import io
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.pop("WORKER_ENV", None)
from fastapi.testclient import TestClient
from PIL import Image
from skimage import data

import server

H = {"x-worker-key": "dev-worker-key"}
WM = "a1b2c3d4e5f60718"


def png(arr) -> bytes:
    b = io.BytesIO()
    Image.fromarray(arr).save(b, "PNG")
    return b.getvalue()


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(server.app)
        cls.src = png(data.astronaut())

    def test_auth_required(self):
        self.assertEqual(self.c.get("/health").status_code, 200)
        self.assertEqual(self.c.post(f"/embed?wm_id={WM}", content=self.src).status_code, 401)
        self.assertEqual(self.c.post("/extract", content=self.src, headers={"x-worker-key": "nope"}).status_code, 401)
        self.assertEqual(self.c.post("/match", json={}, headers={}).status_code, 401)

    def test_validation(self):
        self.assertEqual(self.c.post("/embed?wm_id=zz", content=self.src, headers=H).status_code, 400)
        self.assertEqual(self.c.post(f"/embed?wm_id={WM}&format=gif", content=self.src, headers=H).status_code, 400)
        self.assertEqual(self.c.post(f"/embed?wm_id={WM}", content=b"", headers=H).status_code, 400)
        self.assertEqual(self.c.post(f"/embed?wm_id={WM}", content=b"not an image", headers=H).status_code, 422)
        tiny = png(data.astronaut()[:100, :100])
        self.assertEqual(self.c.post(f"/embed?wm_id={WM}", content=tiny, headers=H).status_code, 422)
        self.assertEqual(self.c.post("/match", json={"softs": [[0.0] * 128], "candidates": ["bad"]}, headers=H).status_code, 400)

    def test_embed_extract_match_flow_png_and_jpeg(self):
        for fmt, ctype in (("png", "image/png"), ("jpeg", "image/jpeg")):
            with self.subTest(fmt):
                r = self.c.post(f"/embed?wm_id={WM}&format={fmt}", content=self.src, headers=H)
                self.assertEqual(r.status_code, 200)
                self.assertEqual(r.headers["content-type"], ctype)
                ex = self.c.post("/extract", content=r.content, headers=H).json()
                self.assertTrue(ex["ok"])
                cands = [WM] + [f"{i:016x}" for i in range(500)]
                m = self.c.post("/match", json={"softs": ex["softs"], "candidates": cands}, headers=H).json()
                self.assertTrue(m["detected"], m)
                self.assertEqual(m["matches"][0]["wmId"], WM)
                # 정답이 후보에 없으면 판정되지 않는다
                m2 = self.c.post("/match", json={"softs": ex["softs"], "candidates": cands[1:]}, headers=H).json()
                self.assertFalse(m2["detected"], m2)


if __name__ == "__main__":
    unittest.main()
