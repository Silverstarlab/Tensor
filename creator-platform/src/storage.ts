import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/** 객체 저장소 추상화. 운영에서는 같은 인터페이스를 S3 호환 저장소로 구현한다. */
export interface ObjectStorage {
  get(key: string): Promise<Buffer | null>;
  put(key: string, data: Buffer): Promise<void>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/;

/** 키 검증. 크리에이터가 넣을 수 있는 값이므로 경로 탈출('..', 절대 경로)을 막는다. */
export function isSafeKey(key: string): boolean {
  return KEY_RE.test(key) && !key.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}

export class LocalFsStorage implements ObjectStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    if (!isSafeKey(key)) throw new Error("unsafe storage key");
    const p = resolve(this.root, key);
    if (!p.startsWith(this.root + sep)) throw new Error("unsafe storage key");
    return p;
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async exists(key: string) {
    return stat(this.path(key)).then(() => true, () => false);
  }
}

export class MemoryStorage implements ObjectStorage {
  readonly map = new Map<string, Buffer>();
  async get(key: string) {
    if (!isSafeKey(key)) throw new Error("unsafe storage key");
    return this.map.get(key) ?? null;
  }
  async put(key: string, data: Buffer) {
    if (!isSafeKey(key)) throw new Error("unsafe storage key");
    this.map.set(key, data);
  }
}

/** 매직 바이트로 이미지 형식 확인 (Content-Type 헤더는 믿지 않는다) */
export function sniffImage(b: Buffer): "png" | "jpeg" | "webp" | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 12 && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}
