"""
이미지 워터마킹 엔진 (확산 스펙트럼 + 타일 반복 + 후보 목록 매칭).

구조
- 키에서 직교하는 T x T 패턴(캐리어) 129개를 만든다: 동기용 파일럿 1개 + 데이터 128개.
  패턴은 저·중간 주파수 대역(기본 0.03~0.16 cycles/px)에만 에너지를 가진다 -> JPEG/리사이즈에 살아남는 대역.
- wm_id -> HMAC으로 128비트 코드워드. 비트별로 +/- 부호를 곱한 캐리어 합이 타일 패턴 W.
- W를 이미지 전체에 반복(타일링)해 휘도(Y)에 질감 마스크를 곱해 더한다.
- 검출: 주기(=스케일)를 자기상관으로 추정 -> 표준 크기로 되돌림 -> 타일로 접어 평균(호스트 잡음 감소)
  -> 파일럿 순환 상관으로 이동량(크롭) 동기 -> 128개 소프트 상관값.
- 후보 wm_id들의 코드워드와 소프트 상관값을 내적해 z 점수로 판정한다(후보 목록은 서버 DB가 가지고 있다).

한계(의도적으로 다루지 않음): 회전, 원근 변환(카메라로 화면 촬영), 뒤집기.
"""
from __future__ import annotations

import hashlib
import hmac
import io
from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy import fft as sfft
from scipy.stats import norm

TILE = 128
N_BITS = 128
BAND = (0.03, 0.16)
MIN_SIDE = 192  # 표준 크기로 되돌린 뒤 이 값보다 작으면 검출 불가


class EngineError(ValueError):
    pass


@dataclass
class SoftResult:
    ok: bool
    softs: list[np.ndarray] | None  # 동기 후보(이동량)별 길이 N_BITS 소프트 상관값. 첫 번째가 가장 유력
    sync_z: float  # 파일럿 상관 피크의 z 점수(동기 품질)
    period: tuple[float, float] | None  # 추정한 (x, y) 타일 주기(px)
    shift: tuple[int, int] | None
    reason: str = ""

    @property
    def n_hypotheses(self) -> int:
        """후보 매칭 시 비교하는 (스케일, 이동) 가설 수. 다중 검정 보정에 쓴다."""
        return len(self.softs or [])


def z_threshold(n_candidates: int, fwer: float = 1e-6) -> float:
    """후보 n개 중 하나라도 우연히 넘을 확률(family-wise)이 fwer 이하가 되는 z 기준."""
    return float(norm.isf(fwer / max(1, n_candidates)))


def decode_image(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as e:  # noqa: BLE001
        raise EngineError(f"cannot decode image: {e}") from e
    return img


def _luma(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("L"), dtype=np.float64)


class Codebook:
    # 격자 탐색에서 미세 조정까지 가져갈 스케일 후보 수. 늘리면 정답이 탈락할 확률이 줄지만 검출이 느려진다.
    scale_keep = 3
    # 스케일 격자 간격(로그). 간격 중간에 진짜 값이 있으면 그 지점의 동기가 약해지므로 촘촘할수록 안정적이지만 느리다.
    scale_step = 0.015
    # 국소 스캔 후 에너지 동기 z가 이 값 미만이면 우연 수준으로 보고 포기한다 (129캐리어 실측: 무신호 스캔 최대 6.2 / 99% 5.7 (n=188), 유신호 최소 9.7 / 5% 13.0 (n=36))
    prune_z = 7.0
    # 동기 통계: "energy"(모든 캐리어 에너지 합) 또는 "pilot"(파일럿 하나)
    sync_mode = "energy"
    # 탐색 단계(반해상도)에서 동기에 쓰는 캐리어 수(파일럿 포함). 최종 읽기는 전부 쓴다. 줄이면 빨라지지만 무신호 z 분포가 바뀌어 prune_z 재보정이 필요하다
    search_carriers = 129
    # 격자 탐색 창(타일 수), 산 오르기 창(타일 수; 큰 이미지에서도 탐색 시간이 늘지 않게 상한), 국소 스캔 점 수
    grid_tiles = 4
    refine_tiles = 6
    scan_points = 9
    # 스케일 변화 없음(항등) 시도의 동기 z가 이 값 이상이면 스케일 탐색을 건너뛴다
    quick_z = 10.0
    # 후보 매칭까지 남길 서로 다른 스케일 가설의 최대 수
    max_hyp = 3

    def __init__(self, key: bytes, tile: int = TILE, n_bits: int = N_BITS, band=BAND, pilot_weight: float = 4.0):
        if len(key) < 16:
            raise EngineError("key must be at least 16 bytes")
        self.key, self.tile, self.n_bits, self.pilot_weight = key, tile, n_bits, pilot_weight
        seed = int.from_bytes(hmac.new(key, b"carriers-v1", hashlib.sha256).digest()[:8], "big")
        rng = np.random.default_rng(seed)
        m = n_bits + 1
        fy = np.fft.fftfreq(tile)[:, None]
        fx = np.fft.rfftfreq(tile)[None, :]
        r = np.hypot(fy, fx)
        mask = (r >= band[0]) & (r <= band[1])
        spec = (rng.standard_normal((m, tile, tile // 2 + 1)) + 1j * rng.standard_normal((m, tile, tile // 2 + 1))) * mask
        pats = np.fft.irfft2(spec, s=(tile, tile)).reshape(m, -1)
        q, _ = np.linalg.qr(pats.T)  # 열이 직교 정규 -> 패턴끼리 정확히 직교
        self.pats = (q.T * tile).reshape(m, tile, tile)  # 각 패턴 RMS = 1
        self._pf = sfft.rfft2(self.pats, axes=(1, 2))  # (m, T, T/2+1) 패턴 스펙트럼
        self._pf_cache: dict = {}

    # ---- 코드워드 ----
    def codeword(self, wm_id: str) -> np.ndarray:
        """wm_id(16 hex) -> 길이 n_bits 의 +/-1 벡터. 키가 없으면 계산할 수 없다."""
        out = b""
        i = 0
        while len(out) * 8 < self.n_bits:
            out += hmac.new(self.key, b"codeword-v1|" + wm_id.encode() + bytes([i]), hashlib.sha256).digest()
            i += 1
        bits = np.unpackbits(np.frombuffer(out, dtype=np.uint8))[: self.n_bits]
        return bits.astype(np.int8) * 2 - 1

    def codeword_matrix(self, ids: list[str]) -> np.ndarray:
        return np.stack([self.codeword(i) for i in ids]).astype(np.float64) if ids else np.zeros((0, self.n_bits))

    # ---- 삽입 ----
    def _tile_pattern(self, wm_id: str) -> np.ndarray:
        w = self.pilot_weight * self.pats[0] + np.tensordot(self.codeword(wm_id).astype(np.float64), self.pats[1:], axes=1)
        return w / np.sqrt(np.mean(w**2))  # RMS = 1

    @staticmethod
    def _mask(y: np.ndarray) -> np.ndarray:
        """질감이 있는 곳은 강하게, 평평한 곳(하늘 등)은 약하게."""
        mu = ndimage.uniform_filter(y, 7)
        var = np.maximum(ndimage.uniform_filter(y * y, 7) - mu * mu, 0)
        m = np.clip(np.sqrt(var) / 6.0, 0.3, 2.0)
        return ndimage.gaussian_filter(m, 3)

    def embed(self, img: Image.Image, wm_id: str, strength: float = 2.5) -> Image.Image:
        if min(img.size) < MIN_SIDE:
            raise EngineError(f"image too small: need at least {MIN_SIDE}px on each side")
        mode = img.mode
        if mode in ("L", "LA"):
            base = img.convert("L")
            y = np.asarray(base, dtype=np.float64)
            ycc = None
        else:
            ycc = img.convert("RGB").convert("YCbCr")
            y = np.asarray(ycc.getchannel("Y"), dtype=np.float64)
        h, w = y.shape
        t = self.tile
        tiled = np.tile(self._tile_pattern(wm_id), (h // t + 1, w // t + 1))[:h, :w]
        y2 = np.clip(np.rint(y + strength * self._mask(y) * tiled), 0, 255).astype(np.uint8)
        if ycc is None:
            return Image.fromarray(y2, "L")
        ch = list(ycc.split())
        ch[0] = Image.fromarray(y2, "L")
        return Image.merge("YCbCr", ch).convert("RGB")

    # ---- 검출 ----
    @staticmethod
    def _peaks(profile: np.ndarray, lo: int, hi: int, k: int = 3) -> list[float]:
        """프로파일에서 상위 k개 피크 위치(포물선 보간, 서브픽셀)."""
        hi = min(hi, len(profile) - 2)
        if hi <= lo + 2:
            return []
        seg = profile[lo:hi].copy()
        out: list[float] = []
        for _ in range(k):
            i = int(np.argmax(seg))
            if not np.isfinite(seg[i]):
                break
            j = lo + i
            a, b, c = profile[j - 1], profile[j], profile[j + 1]
            d = a - 2 * b + c
            off = 0.5 * (a - c) / d if d != 0 else 0.0
            out.append(j + max(-1.0, min(1.0, off)))
            seg[max(0, i - 10) : i + 11] = -np.inf
        return out

    def _estimate_periods(self, hp: np.ndarray) -> tuple[list[float], list[float]]:
        """
        스펙트럼을 백색화한 이미지의 자기상관에서 타일 주기(= 스케일)를 찾는다.
        백색화하면 호스트 이미지의 상관은 0 지연에만 남고 워터마크의 주기 피크만 선명해진다.
        """
        h, w = hp.shape
        f = sfft.rfft2(hp, s=(2 * h, 2 * w))
        pw = np.abs(f) ** 2
        r = np.hypot(np.fft.fftfreq(2 * h)[:, None], np.fft.rfftfreq(2 * w)[None, :])
        bins = np.linspace(0, 0.5, 101)
        idx = np.clip(np.digitize(r.ravel(), bins) - 1, 0, 99)
        tot = np.bincount(idx, pw.ravel(), 100)
        cnt = np.maximum(np.bincount(idx, minlength=100), 1)
        prof = ndimage.gaussian_filter1d(tot / cnt, 1.5) + 1e-9
        white = pw / prof[idx].reshape(pw.shape)
        white[(r < 0.02) | (r > 0.30)] = 0  # 0.30 초과는 보간 격자 등 가짜 주기
        ac = sfft.irfft2(white)
        px = ac[0, :w] / (w - np.arange(w))
        py = ac[:h, 0] / (h - np.arange(h))
        t = self.tile
        lo = int(0.35 * t)
        hi = int(3.0 * t)
        return self._peaks(px, lo, min(hi, int(0.7 * w))), self._peaks(py, lo, min(hi, int(0.7 * h)))

    # ---- 재표본화 / 접기 / 동기 (타일 크기를 인자로 받아 반해상도 탐색과 전해상도 읽기에 함께 쓴다) ----
    @staticmethod
    def _src(hp: np.ndarray):
        h, w = hp.shape
        return (Image.fromarray(np.ascontiguousarray(hp, dtype=np.float32), mode="F"), w, h, hp)

    @staticmethod
    def _canonical(src, px: float, py: float, tile: int, window=None):
        """
        주기가 정확히 tile px가 되도록 재표본화한다(window: 의심 이미지 좌표의 (x0,y0,x1,y1)).
        출력 크기는 정수, 입력 영역(box)은 실수로 지정해 크기 반올림으로 주기가 어긋나지 않게 한다
        (동기 점수의 봉우리가 +-0.5%로 좁아 주기 오차가 곧 검출 실패가 된다).
        scipy.ndimage.zoom(3차 스플라인)이 검출 시간의 97%를 차지해 PIL LANCZOS(약 7배 빠름, 축소 시 안티앨리어싱)로 바꿨다.
        """
        im, w, h, hp = src
        x0, y0, x1, y1 = window or (0.0, 0.0, float(w), float(h))
        if tile == TILE and window is None and abs(TILE / py - 1) < 1e-3 and abs(TILE / px - 1) < 1e-3:
            return hp  # 스케일 변화 없음
        ow, oh = int((x1 - x0) * tile // px), int((y1 - y0) * tile // py)
        if ow < 8 or oh < 8:
            return None
        box = (x0, y0, min(float(w), x0 + ow * px / tile), min(float(h), y0 + oh * py / tile))
        return np.asarray(im.resize((ow, oh), Image.LANCZOS, box=box), dtype=np.float32)

    @staticmethod
    def _fold(c: np.ndarray, t: int) -> np.ndarray | None:
        h, w = c.shape
        nh, nw = h // t, w // t
        if nh < 1 or nw < 1:
            return None
        return c[: nh * t, : nw * t].reshape(nh, t, nw, t).mean(axis=(0, 2))

    @staticmethod
    def _whitening(c: np.ndarray, t: int) -> np.ndarray:
        """호스트 이미지의 방사 평균 스펙트럼으로 만든 H^2 = 1/PSD (색 잡음 하에서의 정합 필터)."""
        f = sfft.rfft2(c)
        pw = np.abs(f) ** 2
        r = np.hypot(np.fft.fftfreq(c.shape[0])[:, None], np.fft.rfftfreq(c.shape[1])[None, :])
        bins = np.linspace(0, 0.5, 51)
        idx = np.clip(np.digitize(r.ravel(), bins) - 1, 0, 49)
        tot = np.bincount(idx, pw.ravel(), 50)
        cnt = np.maximum(np.bincount(idx, minlength=50), 1)
        prof = ndimage.gaussian_filter1d(tot / cnt, 1.0) + 1e-9
        rt = np.hypot(np.fft.fftfreq(t)[:, None], np.fft.rfftfreq(t)[None, :])
        it = np.clip(np.digitize(rt.ravel(), bins) - 1, 0, 49)
        return (1.0 / prof[it]).reshape(rt.shape)

    @staticmethod
    def _z(corr: np.ndarray) -> tuple[float, tuple[int, int]]:
        k = np.unravel_index(int(np.argmax(corr)), corr.shape)
        rest = np.delete(corr.ravel(), np.ravel_multi_index(k, corr.shape))
        return float((corr[k] - rest.mean()) / (rest.std() + 1e-12)), (int(k[0]), int(k[1]))

    def _carrier_spec(self, tile: int) -> np.ndarray:
        """해상도별 전체 캐리어 스펙트럼. 대역이 0.16 cycles/px 이하라 2배 솎아내기(::2)가 정확하다."""
        if tile == self.tile:
            return self._pf
        if tile not in self._pf_cache:
            step = self.tile // tile
            self._pf_cache[tile] = sfft.rfft2(self.pats[:, ::step, ::step], axes=(1, 2)).astype(np.complex64)
        return self._pf_cache[tile]

    def _corr_maps(self, folded: np.ndarray, h2: np.ndarray, tile: int, k: int | None = None) -> np.ndarray:
        """캐리어(파일럿 + 데이터)의 순환 상관 맵 (k, tile, tile). k가 없으면 전부."""
        spec = sfft.rfft2(folded)[None] * np.conj(self._carrier_spec(tile)[:k]) * h2[None]
        return sfft.irfft2(spec, s=(tile, tile), axes=(1, 2))

    def _sync_map(self, folded: np.ndarray, h2: np.ndarray, tile: int, k: int | None = None) -> np.ndarray:
        """
        이동량별 동기 통계 맵.
        energy(기본): 모든 캐리어 상관의 제곱합. 비트 부호를 몰라도 되고 파일럿(전체 에너지의 약 11%)만 쓸 때보다
        약 9배 많은 신호 에너지를 쓰므로, 타일 수가 적은 작은 이미지에서도 동기가 훨씬 잘 잡힌다.
        pilot: 파일럿 하나의 상관(이전 방식).
        """
        if self.sync_mode == "pilot":
            return sfft.irfft2(sfft.rfft2(folded) * np.conj(self._carrier_spec(tile)[0]) * h2, s=folded.shape)
        cm = self._corr_maps(folded, h2, tile, k)
        return np.einsum("kij,kij->ij", cm, cm)

    def _trial(self, src, px: float, py: float, tile: int, h2: np.ndarray | None = None, window=None):
        c = self._canonical(src, px, py, tile, window)
        if c is None or min(c.shape) < MIN_SIDE * tile // self.tile:
            return None
        f = self._fold(c, tile)
        if f is None:
            return None
        hh = h2 if h2 is not None else self._whitening(c, tile)
        z, sh = self._z(self._sync_map(f, hh, tile, self.search_carriers if tile < self.tile else None))
        return z, px, py, sh, f, hh

    def _scale_search(self, src, half: int) -> list[float]:
        """
        등방성 스케일 격자 탐색(반해상도). 각 스케일 s에서 중앙 창을 표준 크기로 되돌려 파일럿 동기 z를 잰다.
        최적 검출기를 그대로 추정기로 쓰므로 자기상관보다 훨씬 민감하다. 서로 떨어진 상위 스케일들을 돌려준다.
        """
        _, w, h, _ = src
        res: list[tuple[float, float]] = []
        for s in np.exp(np.arange(np.log(0.45), np.log(2.2), self.scale_step)):
            wy, wx = min(h, round(self.grid_tiles * 128 * s)), min(w, round(self.grid_tiles * 128 * s))
            if min(wy, wx) < 128 * s * 1.5:
                continue
            x0, y0 = (w - wx) / 2, (h - wy) / 2
            r = self._trial(src, 128 * s, 128 * s, half, None, (x0, y0, x0 + wx, y0 + wy))
            if r:
                res.append((r[0], float(s)))
        picks: list[float] = []
        for z, sc in sorted(res, reverse=True):
            if all(abs(np.log(sc / q)) > 0.05 for q in picks):
                picks.append(sc)
            if len(picks) == self.scale_keep:
                break
        return picks

    def _win(self, src, px: float, py: float):
        """산 오르기용 중앙 창: 큰 이미지에서 시도 비용이 이미지 크기에 비례하지 않도록 refine_tiles 타일로 제한한다."""
        _, w, h, _ = src
        wx, wy = min(float(w), self.refine_tiles * px), min(float(h), self.refine_tiles * py)
        x0, y0 = (w - wx) / 2, (h - wy) / 2
        return (x0, y0, x0 + wx, y0 + wy)

    def _refine(self, src, px0: float, py0: float, half: int):
        """한 시작점 주위를 촘촘히 훑고(봉우리 폭 +-0.5~0.75%보다 세밀) 이방성 미세 조정까지 한다(반해상도, 중앙 창)."""
        scan, h2 = None, None
        for d in np.linspace(-0.01, 0.01, self.scan_points):
            px, py = px0 * (1 + d), py0 * (1 + d)
            r = self._trial(src, px, py, half, h2, self._win(src, px, py))
            if r:
                h2 = r[5] if h2 is None else h2
                if scan is None or r[0] > scan[0]:
                    scan = r
        if scan is None or scan[0] < self.prune_z:
            return None  # 우연 수준(잡음 최댓값)이면 더 파지 않는다
        best = (scan[0], scan[1], scan[2])
        for step in (0.15, 0.05):
            improved, rounds = True, 0
            while improved and rounds < 3:
                improved, rounds = False, rounds + 1
                for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step)):
                    qx, qy = best[1] + dx, best[2] + dy
                    r = self._trial(src, qx, qy, half, h2, self._win(src, qx, qy))
                    if r and r[0] > best[0]:
                        best, improved = (r[0], r[1], r[2]), True
        return best

    def _polish(self, src, r):
        """반해상도에서 찾은 주기는 전해상도의 최적점에서 조금 벗어날 수 있어 동기 z를 높이는 방향으로 짧게 다듬는다."""
        best = r
        for step in (0.1, 0.04):
            improved, rounds = True, 0
            while improved and rounds < 2:
                improved, rounds = False, rounds + 1
                for dx, dy in ((step, 0), (-step, 0), (0, step), (0, -step)):
                    c = self._trial(src, best[1] + dx, best[2] + dy, self.tile, best[5])
                    if c and c[0] > best[0]:
                        best, improved = c, True
        return best

    def extract_soft(self, img: Image.Image, n_shifts: int = 3) -> SoftResult:
        y = _luma(img)
        h, w = y.shape
        if min(h, w) < MIN_SIDE // 2:
            return SoftResult(False, None, 0.0, None, None, "image too small")
        hp = (y - ndimage.gaussian_filter(y, 6)).astype(np.float32)
        src = self._src(hp)
        t = float(self.tile)
        half = self.tile // 2

        # 스케일 가설을 한 개로 확정하지 않는다: 동기 z만으로 고르면 우연히 높은 가짜 가설에 속을 수 있다.
        # 여러 가설을 남기고 후보 매칭 z(훨씬 판별력이 높음)로 최종 선택한다.
        hyps: list[tuple[float, float, float, np.ndarray, np.ndarray]] = []  # (z, px, py, folded, h2)
        ident = self._trial(src, t, t, self.tile)
        if ident:
            hyps.append((ident[0], t, t, ident[4], ident[5]))
        if not (ident and ident[0] >= self.quick_z):
            grid = [(sc * t, sc * t) for sc in self._scale_search(src, half)]
            xs, ys = self._estimate_periods(hp)
            starts = grid + sorted({(float(a), float(b)) for a in xs[:2] for b in ys[:2]})
            uniq: list[tuple[float, float]] = []
            for px, py in starts:  # 가까운 시작점(0.6% 이내)은 하나로 합친다
                if all(abs(px / a_ - 1) > 0.006 or abs(py / b_ - 1) > 0.006 for a_, b_ in uniq):
                    uniq.append((px, py))
            found = [r for r in (self._refine(src, px, py, half) for px, py in uniq) if r]
            found.sort(key=lambda r: -r[0])
            kept: list[tuple[float, float, float]] = []
            for z, px, py in found:  # 서로 다른(0.3% 초과) 상위 가설만 남긴다
                if all(abs(px / a_ - 1) > 0.003 or abs(py / b_ - 1) > 0.003 for _, a_, b_ in kept):
                    kept.append((z, px, py))
                if len(kept) == self.max_hyp:
                    break
            for rank, (_, px, py) in enumerate(kept):  # 최종 읽기는 전해상도로
                r = self._trial(src, px, py, self.tile)
                if r and rank == 0:
                    r = self._polish(src, r)  # 최상위 가설만 전해상도에서 주기를 짧게 다듬는다
                if r:
                    hyps.append((r[0], r[1], r[2], r[4], r[5]))
        if not hyps:
            return SoftResult(False, None, 0.0, None, None, "no usable scale")

        softs: list[np.ndarray] = []
        top_z, top_period, top_shift = -1.0, None, None
        for z, px, py, folded, h2 in hyps:
            cmat = self._corr_maps(folded, h2, self.tile)
            pc = np.einsum("kij,kij->ij", cmat, cmat) if self.sync_mode == "energy" else cmat[0]
            picks: list[tuple[int, int]] = []
            for o in np.argsort(-pc.ravel())[:400]:
                k = np.unravel_index(int(o), pc.shape)
                if all(min(abs(k[0] - a), self.tile - abs(k[0] - a)) > 1 or min(abs(k[1] - b), self.tile - abs(k[1] - b)) > 1 for a, b in picks):
                    picks.append((int(k[0]), int(k[1])))
                if len(picks) == n_shifts:
                    break
            softs += [cmat[1:, a, b].copy() for a, b in picks]
            if z > top_z:
                top_z, top_period, top_shift = z, (px, py), picks[0]
        return SoftResult(True, softs, top_z, top_period, top_shift, "")

    # ---- 매칭 ----
    def match(self, softs: list[np.ndarray], ids: list[str], top: int = 3, chunk: int = 50_000) -> list[tuple[str, float]]:
        """후보 wm_id들의 z 점수(내림차순 상위 top). 동기 후보(이동량) 중 가장 높은 점수를 쓴다."""
        if not ids or not softs:
            return []
        best: dict[str, float] = {}
        for start in range(0, len(ids), chunk):
            part = ids[start : start + chunk]
            b = self.codeword_matrix(part)
            zmax = np.full(len(part), -np.inf)
            for soft in softs:
                z = (b @ soft) / (np.sqrt(np.sum(soft**2)) + 1e-12)
                zmax = np.maximum(zmax, z)
            for i in np.argsort(-zmax)[:top]:
                best[part[i]] = float(zmax[i])
        return sorted(best.items(), key=lambda kv: -kv[1])[:top]
