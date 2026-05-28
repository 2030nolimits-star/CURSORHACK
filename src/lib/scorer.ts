import type { EnrichedContext, BrandSafetySignals } from "@/lib/tavily";

export interface ScoreBreakdown {
  purchaseIntent: number;
  topicSpecificity: number;
  contextualRelevance: number;
  brandSafety: number;
}

export interface ScoringResult {
  total: number;
  breakdown: ScoreBreakdown;
  reasoning: string;
  confidence: "high" | "medium" | "low";
}

// ── Rule-based fallback (no API key needed) ───────────────────────────────────

function ruleBasedSemantic(prompt: string): { purchaseIntent: number; topicSpecificity: number; reasoning: string } {
  const lower = prompt.toLowerCase();

  // Purchase intent signals
  let purchaseIntent = 0;
  if (/\b(buy|purchase|order|get me|i want|i need|looking to buy|ready to order)\b/.test(lower)) purchaseIntent += 20;
  else if (/\b(best|recommend|worth it|should i get|which one|compare)\b/.test(lower)) purchaseIntent += 14;
  else if (/\b(review|how good|is .+ good|pros and cons)\b/.test(lower)) purchaseIntent += 8;
  else if (/\b(what is|how does|explain|tell me about)\b/.test(lower)) purchaseIntent += 2;
  if (/£|\$|\d+\s*(dollar|pound|usd|gbp|euro)|\bunder\s+\d+|\bbelow\s+\d+/.test(lower)) purchaseIntent += 5;
  if (/\b(today|tonight|asap|urgent|now|quick|this week|by \w+day)\b/.test(lower)) purchaseIntent += 3;
  purchaseIntent = Math.min(25, purchaseIntent);

  // Topic specificity
  let topicSpecificity = 0;
  const wordCount = prompt.trim().split(/\s+/).length;
  if (wordCount > 8) topicSpecificity += 8;
  else if (wordCount > 4) topicSpecificity += 5;
  if (/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/.test(prompt)) topicSpecificity += 8; // brand names
  if (/\b(headphones|laptop|phone|shoes|camera|watch|tv|sofa|mattress|flight|hotel|insurance|software)\b/.test(lower)) topicSpecificity += 5;
  if (/\d+/.test(prompt)) topicSpecificity += 4; // numbers suggest specificity
  topicSpecificity = Math.min(25, topicSpecificity);

  const reasoning = purchaseIntent >= 18
    ? "Strong purchase signals detected."
    : purchaseIntent >= 10
    ? "Moderate commercial intent — user is researching or comparing."
    : "Low commercial intent — primarily informational.";

  return { purchaseIntent, topicSpecificity, reasoning };
}

// ── Claude-powered semantic scoring ──────────────────────────────────────────

async function claudeSemantic(prompt: string): Promise<{ purchaseIntent: number; topicSpecificity: number; reasoning: string }> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();

  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    system: `You are a sell-side ad eligibility scorer. Rate the prompt on two dimensions (0–25 integers):

purchase_intent: 25=explicit buy-now intent, 18=strong transactional, 12=comparison/research, 5=informational, 0=none
topic_specificity: 25=specific named product, 18=specific category, 12=broad category, 5=vague, 0=none

Return ONLY valid JSON: {"purchase_intent":N,"topic_specificity":N,"reasoning":"one sentence"}`,
    messages: [{ role: "user", content: prompt }],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "{}";
  try {
    const p = JSON.parse(text);
    return {
      purchaseIntent: Math.min(25, Math.max(0, Number(p.purchase_intent ?? 0))),
      topicSpecificity: Math.min(25, Math.max(0, Number(p.topic_specificity ?? 0))),
      reasoning: p.reasoning ?? "",
    };
  } catch {
    return ruleBasedSemantic(prompt);
  }
}

// ── Tavily-derived dimensions ─────────────────────────────────────────────────

function contextualRelevanceScore(ctx: EnrichedContext): number {
  let score = Math.min(ctx.results.length, 5) * 2;
  const avgRelevance = ctx.results.slice(0, 3).reduce((s, r) => s + r.score, 0) / Math.max(ctx.results.length, 1);
  score += Math.round(avgRelevance * 10);
  if (ctx.answer && ctx.answer.length > 20) score += 5;
  return Math.min(25, score);
}

function brandSafetyScore(safety: BrandSafetySignals): number {
  if (safety.flags.length === 0) return 25;
  const severe = ["violence", "adult_content", "hate_speech"];
  if (safety.flags.some((f) => severe.includes(f))) return 0;
  return Math.max(5, 25 - safety.flags.length * 8);
}

function deriveConfidence(ctx: EnrichedContext): "high" | "medium" | "low" {
  const rich = ctx.results.filter((r) => r.score > 0.6);
  if (rich.length >= 3 || ctx.answer) return "high";
  if (ctx.results.length >= 2) return "medium";
  return "low";
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function scorePrompt(
  prompt: string,
  tavilyContext: EnrichedContext,
  brandSafety: BrandSafetySignals
): Promise<ScoringResult> {
  const semantic = process.env.ANTHROPIC_API_KEY
    ? await claudeSemantic(prompt).catch(() => ruleBasedSemantic(prompt))
    : ruleBasedSemantic(prompt);

  const breakdown: ScoreBreakdown = {
    purchaseIntent: semantic.purchaseIntent,
    topicSpecificity: semantic.topicSpecificity,
    contextualRelevance: contextualRelevanceScore(tavilyContext),
    brandSafety: brandSafetyScore(brandSafety),
  };

  const total = breakdown.purchaseIntent + breakdown.topicSpecificity + breakdown.contextualRelevance + breakdown.brandSafety;
  const confidence = deriveConfidence(tavilyContext);
  const safetyNote = breakdown.brandSafety === 0 ? " Brand safety blocked." : breakdown.brandSafety < 25 ? " Mild brand risk." : "";
  const reasoning = `${semantic.reasoning}${safetyNote}`;

  return { total, breakdown, reasoning, confidence };
}
