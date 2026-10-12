"""벤치마크용 공격/변환 모음. 각 함수는 PIL 이미지를 받아 변환된 PIL 이미지를 돌려준다(적용 불가면 None)."""
from __future__ import annotations

import io
import random
from typing import Callable

import numpy as np
from PIL import Image, ImageFilter, ImageOps

Attack = Callable[[Image.Image], "Image.Image | None"]


def _jpeg(q: int) -> Attack:
    def f(im: Image.Image):
        b = io.BytesIO()
        im.convert("RGB").save(b, "JPEG", quality=q)
        return Image.open(io.BytesIO(b.getvalue())).convert("RGB")
    return f


def _webp(q: int) -> Attack:
    def f(im: Image.Image):
        b = io.BytesIO()
        im.convert("RGB").save(b, "WEBP", quality=q)
        return Image.open(io.BytesIO(b.getvalue())).convert("RGB")
    return f


def _resize(s: float, resample=Image.LANCZOS) -> Attack:
    def f(im: Image.Image):
        w, h = im.size
        return im.resize((max(8, round(w * s)), max(8, round(h * s))), resample)
    return f


def _crop(frac: float, seed: int | None = None) -> Attack:
    def f(im: Image.Image):
        w, h = im.size
        cw, ch = round(w * frac), round(h * frac)
        if min(cw, ch) < 200:
            return None  # 최소 크기 미만이면 의미 있는 시험이 아님
        if seed is None:
            x0, y0 = (w - cw) // 2, (h - ch) // 2
        else:
            r = random.Random(seed)
            x0, y0 = r.randint(0, w - cw), r.randint(0, h - ch)
        return im.crop((x0, y0, x0 + cw, y0 + ch))
    return f


def _blur(sigma: float) -> Attack:
    return lambda im: im.filter(ImageFilter.GaussianBlur(sigma))


def _noise(sigma: float) -> Attack:
    def f(im: Image.Image):
        a = np.asarray(im.convert("RGB"), dtype=np.float64)
        rng = np.random.default_rng(1234)
        return Image.fromarray(np.clip(a + rng.normal(0, sigma, a.shape), 0, 255).astype(np.uint8))
    return f


def _brightness(k: float) -> Attack:
    return lambda im: Image.fromarray(np.clip(np.asarray(im.convert("RGB"), float) * k, 0, 255).astype(np.uint8))


def _contrast(k: float) -> Attack:
    def f(im: Image.Image):
        a = np.asarray(im.convert("RGB"), float)
        return Image.fromarray(np.clip((a - 128) * k + 128, 0, 255).astype(np.uint8))
    return f


def _gamma(g: float) -> Attack:
    def f(im: Image.Image):
        a = np.asarray(im.convert("RGB"), float) / 255
        return Image.fromarray((np.clip(a, 0, 1) ** g * 255).astype(np.uint8))
    return f


def _chain(*fs: Attack) -> Attack:
    def f(im: Image.Image):
        for g in fs:
            im = g(im)
            if im is None:
                return None
        return im
    return f


def _rotate(deg: float) -> Attack:
    return lambda im: im.rotate(deg, resample=Image.BICUBIC, expand=False)


ATTACKS: dict[str, Attack] = {
    "none": lambda im: im.convert("RGB"),
    "jpeg q95": _jpeg(95),
    "jpeg q85": _jpeg(85),
    "jpeg q75": _jpeg(75),
    "jpeg q60": _jpeg(60),
    "jpeg q40": _jpeg(40),
    "webp q80": _webp(80),
    "webp q60": _webp(60),
    "resize x0.9": _resize(0.9),
    "resize x0.75": _resize(0.75),
    "resize x0.6": _resize(0.6),
    "resize x1.5 (up)": _resize(1.5, Image.BICUBIC),
    "resize x2.0 (up)": _resize(2.0, Image.BICUBIC),
    "crop center 80%": _crop(0.8),
    "crop random 60%": _crop(0.6, seed=7),
    "crop random 50%": _crop(0.5, seed=11),
    "blur s1.0": _blur(1.0),
    "blur s1.5": _blur(1.5),
    "noise s3": _noise(3),
    "noise s6": _noise(6),
    "brightness x1.2": _brightness(1.2),
    "contrast x1.3": _contrast(1.3),
    "contrast x0.7": _contrast(0.7),
    "gamma 1.3": _gamma(1.3),
    "grayscale": lambda im: ImageOps.grayscale(im).convert("RGB"),
    "median 3x3": lambda im: im.convert("RGB").filter(ImageFilter.MedianFilter(3)),
    "sharpen": lambda im: im.convert("RGB").filter(ImageFilter.UnsharpMask(2, 150, 2)),
    "screenshot (x0.85+jpeg80)": _chain(_resize(0.85, Image.BILINEAR), _jpeg(80)),
    "messenger (x0.75+jpeg70)": _chain(_resize(0.75), _jpeg(70)),
    "combo crop70+x0.6+jpeg60": _chain(_crop(0.7, seed=3), _resize(0.6), _jpeg(60)),
    "combo x0.5+blur0.8+jpeg50": _chain(_resize(0.5), _blur(0.8), _jpeg(50)),
    # 아래는 지원하지 않는 변환(예상 실패). 한계를 숨기지 않기 위해 포함한다.
    "rotate 1deg (unsupported)": _rotate(1),
    "rotate 3deg (unsupported)": _rotate(3),
    "flip horizontal (unsupported)": lambda im: ImageOps.mirror(im.convert("RGB")),
}
