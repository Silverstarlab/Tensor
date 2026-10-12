/**
 * 지역별 가격표 (기획안 16.2). 1코인 = 100원 기준.
 * 값은 각 통화의 최소 단위(KRW=원, USD=센, JPY=엔).
 * TODO: DB 테이블 + 버전 관리로 이동. 현재는 자리표시자이며 실제 가격은 사업 결정 사항.
 */
export const PRICE_VERSION = 1;

export const PRICES: Record<string, { currency: string; minorPerCoin: number }> = {
  KR: { currency: "KRW", minorPerCoin: 100 },
  US: { currency: "USD", minorPerCoin: 7 },
  JP: { currency: "JPY", minorPerCoin: 10 },
};

export function priceFor(region: string) {
  const p = PRICES[region];
  if (!p) return null;
  return { ...p, version: PRICE_VERSION };
}
