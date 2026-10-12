import io
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import numpy as np
from PIL import Image
from skimage import data

from wmark import Codebook, EngineError, z_threshold
from wmark.attacks import ATTACKS

KEY = b"unit-test-key-0123456789abcdef"
WM = "a1b2c3d4e5f60718"
DECOYS = [f"{i:016x}" for i in range(2000)]


class CoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cb = Codebook(KEY)
        cls.img = Image.fromarray(data.astronaut())
        cls.marked = cls.cb.embed(cls.img, WM)

    def detect(self, img, cb=None):
        cb = cb or self.cb
        r = cb.extract_soft(img)
        if not r.ok:
            return False, -9.0
        top = cb.match(r.softs, [WM] + DECOYS, top=1)
        thr = z_threshold((len(DECOYS) + 1) * r.n_hypotheses)
        return top[0][0] == WM and top[0][1] >= thr, top[0][1]

    def test_carriers_are_orthogonal_and_band_limited(self):
        a = self.cb.pats.reshape(len(self.cb.pats), -1) / self.cb.tile
        gram = a @ a.T
        self.assertTrue(np.allclose(gram, np.eye(len(a)), atol=1e-8))
        spec = np.abs(np.fft.rfft2(self.cb.pats[5])) ** 2
        r = np.hypot(np.fft.fftfreq(128)[:, None], np.fft.rfftfreq(128)[None, :])
        self.assertLess(spec[(r < 0.025) | (r > 0.165)].sum() / spec.sum(), 1e-9)

    def test_codeword_is_deterministic_and_key_dependent(self):
        self.assertTrue(np.array_equal(self.cb.codeword(WM), Codebook(KEY).codeword(WM)))
        self.assertFalse(np.array_equal(self.cb.codeword(WM), Codebook(b"x" * 32).codeword(WM)))
        self.assertEqual(len(self.cb.codeword(WM)), 128)

    def test_embed_is_visually_small(self):
        a, b = np.asarray(self.img, float), np.asarray(self.marked, float)
        psnr = 10 * np.log10(255**2 / np.mean((a - b) ** 2))
        self.assertGreater(psnr, 35)
        self.assertEqual(self.marked.size, self.img.size)

    def test_roundtrip(self):
        ok, z = self.detect(self.marked)
        self.assertTrue(ok, z)
        self.assertGreater(z, 8)

    def test_survives_common_transforms(self):
        for name in ("jpeg q60", "resize x0.75", "blur s1.5", "noise s6"):
            with self.subTest(name):
                ok, z = self.detect(ATTACKS[name](self.marked))
                self.assertTrue(ok, f"{name}: z={z:.2f}")

    def test_no_false_positive_on_unmarked_or_other_key(self):
        self.assertFalse(self.detect(self.img)[0])
        self.assertFalse(self.detect(Codebook(b"y" * 32).embed(self.img, WM))[0])  # 다른 키로 같은 ID를 넣어도 매칭 불가
        self.assertFalse(self.detect(self.marked, cb=Codebook(b"z" * 32))[0])  # 키 없이는 검출 불가

    def test_other_id_is_not_matched(self):
        r = self.cb.extract_soft(self.cb.embed(self.img, "0f0f0f0f0f0f0f0f"))
        top = self.cb.match(r.softs, [WM] + DECOYS, top=1)
        self.assertNotEqual(top[0][0], WM)

    def test_too_small_image_is_rejected(self):
        with self.assertRaises(EngineError):
            self.cb.embed(Image.new("RGB", (150, 600)), WM)

    def test_grayscale_and_png_roundtrip(self):
        g = Image.fromarray(data.camera())
        m = self.cb.embed(g, WM)
        self.assertEqual(m.mode, "L")
        buf = io.BytesIO()
        m.save(buf, "PNG")
        ok, z = self.detect(Image.open(io.BytesIO(buf.getvalue())))
        self.assertTrue(ok, z)


if __name__ == "__main__":
    unittest.main()
