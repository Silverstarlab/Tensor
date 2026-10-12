/**
 * 워터마크 엔진 인터페이스.
 * 검출은 "후보 목록 매칭" 방식이다: 이미지에서 신호를 읽어낸 뒤, 서버가 발급한 wm_id 후보들과 대조해
 * 통계적으로 유의한 것만 판정한다(오탐 확률을 p-value로 관리). 후보 목록은 deliveries 테이블에서 온다.
 */
export interface EmbedResult {
  data: Buffer;
  contentType: string;
}
export interface AnalysisResult {
  detected: boolean;
  wmId: string | null;
  /** 1순위 후보의 z 점수와 판정 기준 */
  z: number | null;
  threshold: number | null;
  /** 후보 수와 가설 수로 보정한(family-wise) 오탐 확률 */
  pValue: number | null;
  nCandidates: number;
  reason?: string;
}
export interface WatermarkEngine {
  embed(input: Buffer, wmId: string, opts?: { format?: "png" | "jpeg" }): Promise<EmbedResult>;
  analyze(input: Buffer, candidates: string[]): Promise<AnalysisResult>;
}

export class WatermarkError extends Error {
  constructor(
    public readonly kind: "unsupported_image" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** 파이썬 워커(worker/server.py)를 호출하는 구현 */
export class HttpWatermarkEngine implements WatermarkEngine {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 60_000,
  ) {}

  private async call(path: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), "x-worker-key": this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new WatermarkError("unavailable", `watermark worker unreachable: ${(e as Error).message}`);
    }
    if (res.status === 422) throw new WatermarkError("unsupported_image", (await res.text()).slice(0, 200));
    if (!res.ok) throw new WatermarkError("unavailable", `watermark worker error ${res.status}`);
    return res;
  }

  async embed(input: Buffer, wmId: string, opts: { format?: "png" | "jpeg" } = {}): Promise<EmbedResult> {
    const fmt = opts.format ?? "jpeg";
    const res = await this.call(`/embed?wm_id=${encodeURIComponent(wmId)}&format=${fmt}`, { method: "POST", body: new Uint8Array(input) });
    return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async analyze(input: Buffer, candidates: string[]): Promise<AnalysisResult> {
    const ex = (await (await this.call("/extract", { method: "POST", body: new Uint8Array(input) })).json()) as any;
    if (!ex.ok) return { detected: false, wmId: null, z: null, threshold: null, pValue: null, nCandidates: candidates.length, reason: ex.reason ?? "no_signal" };
    const m = (await (
      await this.call("/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ softs: ex.softs, candidates, top: 1 }),
      })
    ).json()) as any;
    const best = m.matches?.[0];
    return {
      detected: !!m.detected,
      wmId: m.detected && best ? best.wmId : null,
      z: best?.z ?? null,
      threshold: m.threshold ?? null,
      pValue: m.pValue ?? null,
      nCandidates: candidates.length,
    };
  }
}

/**
 * 테스트용 자리표시자. 파일 끝에 태그를 붙일 뿐이라 보안 기능이 아니다. 운영 금지.
 */
export class InsecureStubWatermark implements WatermarkEngine {
  private static TAG = "\nWMSTUB:";
  async embed(input: Buffer, wmId: string) {
    return { data: Buffer.concat([input, Buffer.from(InsecureStubWatermark.TAG + wmId)]), contentType: "application/octet-stream" };
  }
  async analyze(input: Buffer, candidates: string[]): Promise<AnalysisResult> {
    const i = input.lastIndexOf(InsecureStubWatermark.TAG);
    const id = i < 0 ? null : input.subarray(i + InsecureStubWatermark.TAG.length).toString();
    const hit = id !== null && candidates.includes(id);
    return { detected: hit, wmId: hit ? id : null, z: hit ? 99 : null, threshold: 6.5, pValue: hit ? 0 : null, nCandidates: candidates.length };
  }
}
