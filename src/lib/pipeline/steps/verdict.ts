import type { IntentResult, BrandSafetyResult, VerdictResult } from "@/types";

const BASE_CPM = 0.5;
const CATEGORY_MULTIPLIERS: Record<string, number> = {
  purchase_ready: 3.0,
  comparison: 2.0,
  research: 1.2,
  general_chat: 0.5,
  off_topic: 0.1,
};

function calcBidPrice(score: number, category: string): number {
  const mult = CATEGORY_MULTIPLIERS[category] ?? 1.0;
  const cpm = BASE_CPM * score * 10 * mult;
  return Math.round(cpm * 100) / 100;
}

export function computeVerdict(
  intent: IntentResult,
  safety: BrandSafetyResult
): VerdictResult {
  const score = intent.score;
  const category = intent.category;
  const adCategories = intent.adTopics;
  const bidPriceCpm = calcBidPrice(score, category);

  // Score > 0.7 AND brand safe → serve
  if (score > 0.7 && safety.safe) {
    return {
      decision: "serve",
      reason: `High purchase intent (${(score * 100).toFixed(0)}%) with clean brand safety. Category: ${category}.`,
      adCategories,
      bidPriceCpm,
      confidence: 0.95,
    };
  }

  // Brand safety violation → block regardless of intent
  if (!safety.safe && safety.flags.length > 0) {
    return {
      decision: "block",
      reason: `Brand safety flags detected: ${safety.flags.join(", ")}. Ads suppressed.`,
      adCategories: [],
      bidPriceCpm: 0,
      confidence: 0.9,
    };
  }

  // Score 0.4–0.7 → human review queue
  if (score >= 0.4 && score <= 0.7) {
    return {
      decision: "review",
      reason: `Moderate intent (${(score * 100).toFixed(0)}%) — queued for human review. Category: ${category}.`,
      adCategories,
      bidPriceCpm,
      confidence: 0.6,
    };
  }

  // Score < 0.4 → block (low commercial value)
  return {
    decision: "block",
    reason: `Insufficient commercial intent (${(score * 100).toFixed(0)}%). Category: ${category}.`,
    adCategories: [],
    bidPriceCpm: 0,
    confidence: 0.85,
  };
}
