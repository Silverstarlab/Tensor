"""
Colab/로컬 공용 벤치마크 러너 (병렬 실행, 중간 저장, 재개 지원).

- 이미지마다 고정 시드로 wm_id를 만들고, 삽입 -> 공격 -> 검출 -> 후보 매칭까지 한 작업(task)으로 처리한다.
- 결과는 한 줄씩 JSONL 파일에 즉시 기록한다. 런타임이 끊겨도 같은 파일로 다시 실행하면 끝난 작업은 건너뛴다.
- 성공 기준: 1순위 후보가 정답이고 z >= z_threshold(후보 수 x 가설 수)  (가짜 후보 n_decoys개를 섞는다)
"""
from __future__ import annotations

import json
import os
import random
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

import numpy as np
from PIL import Image

from wmark import Codebook, z_threshold
from wmark.attacks import ATTACKS

KEY = bytes.fromhex("c0ffee" * 8)
KEY_OTHER = bytes.fromhex("badf00d1" * 8)

_QUICK = ["none", "jpeg q75", "jpeg q40", "webp q60", "resize x0.6", "resize x1.5 (up)", "crop random 50%",
          "blur s1.5", "noise s6", "screenshot (x0.85+jpeg80)", "combo crop70+x0.6+jpeg60"]
_STANDARD = _QUICK + ["jpeg q95", "jpeg q60", "resize x0.9", "resize x0.75", "crop center 80%", "crop random 60%",
                      "noise s3", "brightness x1.2", "contrast x0.7", "grayscale", "messenger (x0.75+jpeg70)",
                      "combo x0.5+blur0.8+jpeg50"]
_SUPPORTED = [k for k in ATTACKS if "unsupported" not in k]
PRESETS = {
    "tiny": ["none", "jpeg q75", "resize x0.6"],
    "quick": _QUICK,
    "standard": list(dict.fromkeys(_STANDARD)),
    "full": _SUPPORTED,
    "full+unsupported": list(ATTACKS),
}

_S: dict = {}


def prep(img: Image.Image, max_side: int) -> Image.Image:
    """서비스가 전달하는 해상도를 가정해 긴 변을 max_side로 줄인다(작으면 그대로)."""
    img = img.convert("RGB")
    w, h = img.size
    s = max_side / max(w, h)
    return img.resize((round(w * s), round(h * s)), Image.LANCZOS) if s < 1 else img


def make_id(seed: int, index: int) -> str:
    return f"{random.Random(seed * 100003 + index).getrandbits(64):016x}"


def _init(key: bytes, n_decoys: int, seed: int, strength: float) -> None:
    cb = Codebook(key)
    rng = random.Random(seed)
    ids = [f"{rng.getrandbits(64):016x}" for _ in range(n_decoys)]
    _S.update(cb=cb, decoys=ids, B=cb.codeword_matrix(ids), strength=strength, n_decoys=n_decoys)


def _zmax(softs, B):
    return np.max([(B @ s) / (np.linalg.norm(s) + 1e-12) for s in softs], axis=0)


def _task(job: dict) -> dict:
    cb: Codebook = _S["cb"]
    base = {"image": os.path.basename(job["path"]), "attack": job["attack"]}
    t0 = time.time()
    try:
        src = prep(Image.open(job["path"]), job["max_side"])
        marked = cb.embed(src, job["wm_id"], strength=_S["strength"])
        att = ATTACKS[job["attack"]](marked)
        if att is None:
            return {**base, "skipped": True, "reason": "too_small_for_attack"}
        r = cb.extract_soft(att)
        if not r.ok:
            return {**base, "ok": False, "z": None, "thr": None, "sync_z": None, "n_hyp": 0, "reason": r.reason, "sec": time.time() - t0}
        truth = cb.codeword(job["wm_id"]).astype(np.float64)[None, :]
        z_truth = float(_zmax(r.softs, truth)[0])
        z_decoy = float(_zmax(r.softs, _S["B"]).max())
        thr = z_threshold((_S["n_decoys"] + 1) * r.n_hypotheses)
        ok = bool(z_truth >= thr and z_truth > z_decoy)
        return {**base, "ok": ok, "z": z_truth, "best_decoy_z": z_decoy, "thr": thr, "sync_z": float(r.sync_z),
                "n_hyp": r.n_hypotheses, "size": list(att.size), "sec": time.time() - t0}
    except Exception as e:  # noqa: BLE001
        return {**base, "ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}", "sec": time.time() - t0}


def _fp_task(job: dict) -> dict:
    """오탐 시험: 후보 목록에 정답이 없는 경우. 기준 z 이상이 나오면 오탐."""
    cb: Codebook = _S["cb"]
    base = {"image": os.path.basename(job["path"]), "attack": job["attack"], "control": job["control"]}
    try:
        src = prep(Image.open(job["path"]), job["max_side"])
        if job["control"] == "other-key":
            src = Codebook(KEY_OTHER).embed(src, job["wm_id"], strength=_S["strength"])
        att = ATTACKS[job["attack"]](src)
        if att is None:
            return {**base, "skipped": True}
        r = cb.extract_soft(att)
        if not r.ok:
            return {**base, "checked": False, "reason": r.reason}
        z = float(_zmax(r.softs, _S["B"]).max())
        thr = z_threshold(_S["n_decoys"] * r.n_hypotheses)
        return {**base, "checked": True, "max_z": z, "thr": thr, "false_positive": bool(z >= thr)}
    except Exception as e:  # noqa: BLE001
        return {**base, "checked": False, "error": f"{type(e).__name__}: {str(e)[:200]}"}


def _execute(fn, jobs, workers, init_args, out_path, key_fn, progress=None):
    done: dict = {}
    if out_path and os.path.exists(out_path):
        for line in open(out_path):
            try:
                r = json.loads(line)
                done[key_fn(r)] = r
            except Exception:  # noqa: BLE001
                pass
    todo = [j for j in jobs if key_fn(j) not in done]
    results = list(done.values())
    out = open(out_path, "a") if out_path else None
    bar = progress(total=len(todo), desc="벤치마크") if progress else None

    def record(r):
        results.append(r)
        if out:
            out.write(json.dumps(r) + "\n")
            out.flush()
        if bar:
            bar.update(1)

    if workers <= 1:
        _init(*init_args)
        for j in todo:
            record(fn(j))
    else:
        with ProcessPoolExecutor(max_workers=workers, initializer=_init, initargs=init_args) as ex:
            futs = [ex.submit(fn, j) for j in todo]
            for f in as_completed(futs):
                record(f.result())
    if out:
        out.close()
    if bar:
        bar.close()
    wanted = {key_fn(j) for j in jobs}
    return [r for r in results if key_fn(r) in wanted]


def run(paths, attacks, max_side=1024, strength=2.5, n_decoys=20000, workers=2, seed=42, out_path="results.jsonl", progress=None):
    jobs = [{"path": p, "attack": a, "max_side": max_side, "wm_id": make_id(seed, i)} for i, p in enumerate(paths) for a in attacks]
    key = lambda r: (os.path.basename(r.get("path", r.get("image", ""))), r["attack"])  # noqa: E731
    return _execute(_task, jobs, workers, (KEY, n_decoys, seed, strength), out_path, key, progress)


def run_fp(paths, attacks=("none", "jpeg q75", "resize x0.6", "crop random 50%", "screenshot (x0.85+jpeg80)"),
           max_side=1024, strength=2.5, n_decoys=20000, workers=2, seed=42, out_path="fp.jsonl", progress=None):
    jobs = [{"path": p, "attack": a, "control": c, "max_side": max_side, "wm_id": make_id(seed + 1, i)}
            for i, p in enumerate(paths) for c in ("unmarked", "other-key") for a in attacks]
    key = lambda r: (os.path.basename(r.get("path", r.get("image", ""))), r["attack"], r["control"])  # noqa: E731
    return _execute(_fp_task, jobs, workers, (KEY, n_decoys, seed, strength), out_path, key, progress)


def quality(paths, max_side=1024, strength=2.5):
    """원본 대비 화질(PSNR/SSIM). 값이 낮을수록 워터마크가 눈에 띌 가능성이 크다."""
    from skimage.metrics import structural_similarity

    cb = Codebook(KEY)
    rows = []
    for i, p in enumerate(paths):
        a = prep(Image.open(p), max_side)
        b = cb.embed(a, make_id(0, i), strength=strength)
        x, y = np.asarray(a, float), np.asarray(b, float)
        rows.append({"image": os.path.basename(p), "size": a.size,
                     "psnr_db": float(10 * np.log10(255**2 / max(np.mean((x - y) ** 2), 1e-9))),
                     "ssim": float(structural_similarity(np.asarray(a), np.asarray(b), channel_axis=2))})
    return rows
