"""
워터마크 워커 HTTP 서버 (내부 전용: 백엔드에서만 호출한다. 인터넷에 직접 노출하지 말 것).

  GET  /health
  POST /embed?wm_id=<16hex>[&format=png|jpeg][&quality=95][&strength=2.5]   body: 이미지 바이트 -> 이미지 바이트
  POST /extract                                                             body: 이미지 바이트 -> 소프트 상관값(JSON)
  POST /match   {softs, candidates, top}                                    -> 후보별 z 점수와 판정(JSON)

환경 변수: WM_KEY(hex, 16바이트 이상, 운영 필수), WORKER_API_KEY(운영 필수), WORKER_ENV=production, WM_STRENGTH
"""
from __future__ import annotations

import hmac
import io
import os
import re

import numpy as np
from scipy.stats import norm
from fastapi import Body, FastAPI, Header, HTTPException, Query, Request, Response
from PIL import Image, ImageOps

from wmark import Codebook, EngineError, decode_image, z_threshold

PROD = os.environ.get("WORKER_ENV") == "production"
MAX_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", 25 * 1024 * 1024))
Image.MAX_IMAGE_PIXELS = int(os.environ.get("MAX_IMAGE_PIXELS", 50_000_000))  # 압축 폭탄 방어
DEFAULT_STRENGTH = float(os.environ.get("WM_STRENGTH", 2.5))
FWER = float(os.environ.get("MATCH_FWER", 1e-6))
HEX16 = re.compile(r"^[0-9a-f]{16}$")


def _secret(name: str, dev_default: str) -> str:
    v = os.environ.get(name)
    if v:
        return v
    if PROD:
        raise RuntimeError(f"{name} is required in production")
    return dev_default


API_KEY = _secret("WORKER_API_KEY", "dev-worker-key")
WM_KEY = bytes.fromhex(_secret("WM_KEY", "00112233445566778899aabbccddeeff"))
if PROD and (len(WM_KEY) < 32 or API_KEY.startswith("dev-")):
    raise RuntimeError("use a random WM_KEY (>= 32 bytes hex) and WORKER_API_KEY in production")

codebook = Codebook(WM_KEY)
app = FastAPI(title="watermark-worker", docs_url=None, redoc_url=None, openapi_url=None)


def _auth(key: str | None) -> None:
    if not key or not hmac.compare_digest(key.encode(), API_KEY.encode()):
        raise HTTPException(401, "invalid worker key")


async def _image(request: Request) -> Image.Image:
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty body")
    if len(body) > MAX_BYTES:
        raise HTTPException(413, "image too large")
    try:
        return decode_image(body)
    except EngineError as e:
        raise HTTPException(422, str(e)) from e


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/embed")
async def embed(
    request: Request,
    wm_id: str = Query(...),
    format: str = Query("png"),
    quality: int = Query(95, ge=70, le=100),
    strength: float | None = Query(None, ge=0.5, le=6.0),
    x_worker_key: str | None = Header(None),
):
    _auth(x_worker_key)
    if not HEX16.match(wm_id):
        raise HTTPException(400, "wm_id must be 16 lowercase hex chars")
    if format not in ("png", "jpeg"):
        raise HTTPException(400, "format must be png or jpeg")
    img = await _image(request)
    img = ImageOps.exif_transpose(img)  # 화면에 보이는 방향으로 고정(전달본의 픽셀 격자를 결정적으로 만든다). EXIF는 제거된다.
    try:
        out = codebook.embed(img, wm_id, strength=strength or DEFAULT_STRENGTH)
    except EngineError as e:
        raise HTTPException(422, str(e)) from e
    buf = io.BytesIO()
    if format == "jpeg":
        out.convert("RGB").save(buf, "JPEG", quality=quality, subsampling=0)
        return Response(buf.getvalue(), media_type="image/jpeg")
    out.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png")


@app.post("/extract")
async def extract(request: Request, x_worker_key: str | None = Header(None)):
    _auth(x_worker_key)
    img = ImageOps.exif_transpose(await _image(request))
    r = codebook.extract_soft(img)
    if not r.ok:
        return {"ok": False, "reason": r.reason, "softs": [], "syncZ": 0.0}
    return {
        "ok": True,
        "syncZ": r.sync_z,
        "nHypotheses": r.n_hypotheses,
        "period": [float(r.period[0]), float(r.period[1])],
        "softs": [s.tolist() for s in r.softs],
    }


@app.post("/match")
def match(payload: dict = Body(...), x_worker_key: str | None = Header(None)):
    _auth(x_worker_key)
    softs = payload.get("softs")
    cands = payload.get("candidates")
    top = int(payload.get("top", 3))
    if not isinstance(softs, list) or not isinstance(cands, list):
        raise HTTPException(400, "softs and candidates are required")
    if len(cands) > 2_000_000 or not all(isinstance(c, str) and HEX16.match(c) for c in cands):
        raise HTTPException(400, "invalid candidates")
    if not softs:
        return {"detected": False, "matches": [], "threshold": None, "nCandidates": len(cands)}
    arr = [np.asarray(s, dtype=np.float64) for s in softs]
    if any(a.shape != (codebook.n_bits,) for a in arr):
        raise HTTPException(400, "bad soft vector length")
    thr = z_threshold(max(1, len(cands)) * len(arr), FWER)  # 후보 수 x 가설 수만큼 다중 검정 보정
    matches = codebook.match(arr, cands, top=max(1, min(top, 10)))
    best = matches[0] if matches else None
    n_eff = max(1, len(cands)) * len(arr)
    # family-wise p-value: 후보 수 x 가설 수만큼 보정한 우연히 이 점수 이상이 나올 확률
    p_value = float(min(1.0, n_eff * norm.sf(best[1]))) if best else 1.0
    return {
        "detected": bool(best and best[1] >= thr),
        "threshold": thr,
        "pValue": p_value,
        "nCandidates": len(cands),
        "matches": [{"wmId": i, "z": z} for i, z in matches],
    }
