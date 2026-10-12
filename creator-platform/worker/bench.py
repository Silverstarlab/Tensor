"""
워터마크 강건성 벤치마크.
  python3 bench.py [--strength 2.5] [--quick] [--out results.json]
성공 = 1순위 후보가 정답이고 z >= z_threshold(후보 수). 후보 목록에는 정답 + 무작위 가짜 ID를 섞는다.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time

import numpy as np
from PIL import Image
from skimage import data
from skimage.metrics import structural_similarity

from wmark import Codebook, z_threshold
from wmark.attacks import ATTACKS

KEY = b"benchmark-key-0123456789abcdef"
KEY_OTHER = b"another-key-fedcba9876543210ab"


def load_dir(path: str) -> dict[str, Image.Image]:
    from pathlib import Path
    files = sorted(f for f in Path(path).iterdir() if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
    if not files:
        raise SystemExit(f"{path} 에 이미지가 없습니다")
    return {f.stem: Image.open(f).convert("RGB") for f in files}


def load_images() -> dict[str, Image.Image]:
    imgs = {
        "astronaut": data.astronaut(),
        "coffee": data.coffee(),
        "chelsea": data.chelsea(),
        "rocket": data.rocket(),
        "motorcycle": data.stereo_motorcycle()[0],
        "camera(gray)": data.camera(),
        "moon(gray)": data.moon(),
    }
    return {k: Image.fromarray(v).convert("RGB") for k, v in imgs.items()}


def psnr(a: Image.Image, b: Image.Image) -> float:
    x, y = np.asarray(a, float), np.asarray(b, float)
    return float(10 * np.log10(255**2 / max(np.mean((x - y) ** 2), 1e-9)))


def rand_id(rng: random.Random) -> str:
    return f"{rng.getrandbits(64):016x}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--strength", type=float, default=2.5)
    ap.add_argument("--quick", action="store_true", help="이미지 3장, 대표 공격만")
    ap.add_argument("--decoys", type=int, default=20000)
    ap.add_argument("--images-dir", default="", help="벤치마크에 쓸 이미지 폴더(기본: 내장 샘플 7장)")
    ap.add_argument("--limit", type=int, default=0, help="폴더에서 앞의 N장만 사용")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    cb = Codebook(KEY)
    rng = random.Random(42)
    imgs = load_dir(a.images_dir) if a.images_dir else load_images()
    if a.limit:
        imgs = dict(list(imgs.items())[: a.limit])
    names = (["astronaut", "coffee", "chelsea"] if not a.images_dir else list(imgs)[:3]) if a.quick else list(imgs)
    attacks = {k: v for k, v in ATTACKS.items() if not a.quick or k in (
        "none", "jpeg q75", "jpeg q40", "resize x0.6", "resize x1.5 (up)", "crop random 50%", "blur s1.5",
        "noise s6", "screenshot (x0.85+jpeg80)", "combo crop70+x0.6+jpeg60", "rotate 1deg (unsupported)")}
    decoys = [rand_id(rng) for _ in range(a.decoys)]
    thr = z_threshold(a.decoys + 1)
    print(f"strength={a.strength}  decoys={a.decoys}  z-threshold={thr:.2f}  images={names}")

    marked, ids, quality = {}, {}, []
    for n in names:
        ids[n] = rand_id(rng)
        marked[n] = cb.embed(imgs[n], ids[n], strength=a.strength)
        a_, b_ = imgs[n], marked[n]
        ssim = structural_similarity(np.asarray(a_), np.asarray(b_), channel_axis=2)
        quality.append((n, psnr(a_, b_), ssim))
    print("\n화질 (원본 대비)")
    for n, p, s in quality:
        print(f"  {n:14s} PSNR {p:5.1f} dB   SSIM {s:.4f}")

    results = {}
    print(f"\n{'공격':34s} {'성공':>7s} {'z 중앙값':>9s} {'z 최소':>8s}   실패한 이미지")
    t0 = time.time()
    for an, fn in attacks.items():
        zs, ok, tried, failed = [], 0, 0, []
        for n in names:
            att = fn(marked[n])
            if att is None:
                continue
            tried += 1
            r = cb.extract_soft(att)
            if not r.ok:
                failed.append(f"{n}(no-sync)")
                continue
            thr_h = z_threshold((a.decoys + 1) * r.n_hypotheses)  # 가설 수만큼 다중 검정 보정
            top = cb.match(r.softs, [ids[n]] + decoys, top=1)
            zt = max((cb.match(r.softs, [ids[n]], top=1) or [("", -9)])[0][1], -9)
            good = bool(top) and top[0][0] == ids[n] and top[0][1] >= thr_h
            zs.append(zt)
            ok += good
            if not good:
                failed.append(f"{n}(z={zt:.1f})")
        results[an] = {"ok": ok, "tried": tried, "zs": zs, "failed": failed}
        if tried:
            print(f"{an:34s} {ok:3d}/{tried:<3d} {np.median(zs) if zs else float('nan'):9.2f} {min(zs) if zs else float('nan'):8.2f}   {', '.join(failed)}")
        else:
            print(f"{an:34s}   (해당 없음: 이미지가 너무 작음)")
    print(f"\n(공격 시험 소요 {time.time()-t0:.0f}s)")

    # 공격 이름 기준 통합 요약
    supported = {k: v for k, v in results.items() if "unsupported" not in k and v["tried"]}
    tot = sum(v["tried"] for v in supported.values())
    good = sum(v["ok"] for v in supported.values())
    print(f"지원 범위 공격 전체: {good}/{tot} = {100*good/max(tot,1):.0f}%")

    # 오탐(false positive) 시험: 워터마크가 없는 이미지 / 다른 키로 삽입된 이미지
    print("\n오탐 시험 (후보 목록에 정답이 없는 경우; 기준 z 이상이 나오면 오탐)")
    cb_other = Codebook(KEY_OTHER)
    fp = checks = 0
    maxz = -9.0
    for n in names:
        controls = {"unmarked": imgs[n], "other-key": cb_other.embed(imgs[n], rand_id(rng), strength=a.strength)}
        for cn, ci in controls.items():
            for an in ("none", "jpeg q75", "resize x0.6", "crop random 50%", "screenshot (x0.85+jpeg80)"):
                att = ATTACKS[an](ci)
                if att is None:
                    continue
                r = cb.extract_soft(att)
                if not r.ok:
                    continue
                top = cb.match(r.softs, decoys, top=1)
                checks += 1
                maxz = max(maxz, top[0][1])
                fp += top[0][1] >= z_threshold(a.decoys * r.n_hypotheses)
    print(f"  시험 {checks}회, 오탐 {fp}회, 가짜 후보 중 최대 z = {maxz:.2f} (기준 {thr:.2f})")

    if a.out:
        json.dump({"strength": a.strength, "threshold": thr, "quality": quality, "results": results, "fp": {"checks": checks, "fp": fp, "maxz": maxz}}, open(a.out, "w"), indent=1, default=float)
    return 0


if __name__ == "__main__":
    sys.exit(main())
