"""
오픈 이미지 API(picsum.photos)에서 무작위 고해상도 이미지를 내려받아 test_images/ 에 저장한다.
  python3 fetch_test_images.py [--count 30] [--size 1024] [--out test_images]
받은 파일의 sha256과 Picsum-Id를 manifest.json에 남겨, 같은 이미지로 벤치마크를 다시 돌릴 수 있게 한다.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import time
from pathlib import Path

import requests
from PIL import Image


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=30)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--out", default="test_images")
    a = ap.parse_args()

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest, seen, tries = [], set(), 0
    while len(manifest) < a.count and tries < a.count * 3:
        tries += 1
        try:
            r = requests.get(f"https://picsum.photos/{a.size}/{a.size}", timeout=30)
            r.raise_for_status()
            img = Image.open(io.BytesIO(r.content))
            img.load()
        except Exception as e:  # noqa: BLE001
            print(f"  시도 {tries}: 실패 ({type(e).__name__}: {str(e)[:120]})")
            if tries >= 3 and not manifest:
                print("처음 3번 모두 실패: 네트워크 접근을 확인하세요. 중단합니다.")
                return 1
            time.sleep(1)
            continue
        digest = hashlib.sha256(r.content).hexdigest()
        if digest in seen:  # 무작위라 같은 이미지가 다시 올 수 있다
            continue
        seen.add(digest)
        name = f"img_{len(manifest) + 1:02d}.jpg"
        (out / name).write_bytes(r.content)
        manifest.append({"file": name, "sha256": digest, "picsum_id": r.headers.get("Picsum-Id"), "size": list(img.size), "bytes": len(r.content)})
        print(f"  {name}  {img.size}  {len(r.content) // 1024} KB  picsum-id={r.headers.get('Picsum-Id')}")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)}장 저장 -> {out}/")
    return 0 if len(manifest) == a.count else 2


if __name__ == "__main__":
    sys.exit(main())
