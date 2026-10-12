import { randomUUID } from "node:crypto";
import type { Ctx } from "./context.js";
import { badRequest, notFound } from "./errors.js";

/**
 * 유출본에서 추출한 wm_id로 전달 기록을 역조회해 계정을 특정한다.
 * 자동 제재는 하지 않는다: 신뢰도 점수와 함께 OPEN 상태로 두고 사람이 검수한다(오탐/계정 도용 대비).
 */
export async function reportLeak(
  ctx: Ctx,
  input: { wmId: string; sourceUrl: string; confidence: number; contentId?: string; zScore?: number; detail?: Record<string, unknown> },
) {
  if (!/^[0-9a-f]{16}$/.test(input.wmId)) throw badRequest("invalid_wm_id", "wmId must be 16 hex chars");
  if (!input.sourceUrl) throw badRequest("missing_source_url", "sourceUrl is required");
  if (!(input.confidence >= 0 && input.confidence <= 1)) throw badRequest("invalid_confidence", "confidence must be 0..1");

  const d = (
    await ctx.db.query<any>(
      `SELECT d.id, d.user_id, d.receipt_id, d.subscription_id, d.content_id, c.creator_id
         FROM deliveries d JOIN contents c ON c.id = d.content_id WHERE d.wm_id = $1`,
      [input.wmId],
    )
  )[0];
  const id = randomUUID();
  await ctx.db.query(
    "INSERT INTO leak_reports (id,wm_id,content_id,source_url,confidence,delivery_id,resolved_user_id,z_score,detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id, input.wmId, input.contentId ?? null, input.sourceUrl, input.confidence, d?.id ?? null, d?.user_id ?? null, input.zScore ?? null, input.detail ? JSON.stringify(input.detail) : null],
  );
  return {
    reportId: id,
    resolved: !!d,
    userId: d?.user_id ?? null,
    receiptId: d?.receipt_id ?? null,
    subscriptionId: d?.subscription_id ?? null,
    creatorId: d?.creator_id ?? null,
    contentMatches: d ? (input.contentId ? d.content_id === input.contentId : null) : null,
  };
}

export async function reviewLeak(ctx: Ctx, reportId: string, status: "CONFIRMED" | "DISMISSED") {
  const r = await ctx.db.query("UPDATE leak_reports SET status = $1 WHERE id = $2 RETURNING id", [status, reportId]);
  if (!r[0]) throw notFound("leak report");
}
