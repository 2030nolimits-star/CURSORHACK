// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnrichedContext {
  topic: string;
  results: { title: string; url: string; snippet: string; score: number }[];
  answer?: string;
}

export interface BrandSafetySignals {
  safe: boolean;
  flags: string[];
  flaggedSources: { title: string; url: string; snippet: string }[];
  riskSummary: string;
}

// ── Mock fallbacks (used when TAVILY_API_KEY is absent) ───────────────────────

function mockEnrich(topic: string): EnrichedContext {
  return {
    topic,
    answer: `${topic} is a popular consumer category with strong online purchasing behaviour.`,
    results: [
      { title: `Best ${topic} 2025 – Expert Reviews`, url: "https://example.com/reviews", snippet: `Comprehensive guide to buying ${topic}. Prices from £50 to £500 depending on brand.`, score: 0.91 },
      { title: `${topic} Buying Guide`, url: "https://example.com/guide", snippet: `What to look for when purchasing ${topic}. Key factors: quality, price, brand reputation.`, score: 0.84 },
      { title: `Top-rated ${topic} on Amazon`, url: "https://example.com/amazon", snippet: `Best-selling ${topic} with verified customer reviews and competitive pricing.`, score: 0.78 },
    ],
  };
}

function mockSafety(topic: string): BrandSafetySignals {
  return {
    safe: true,
    flags: [],
    flaggedSources: [],
    riskSummary: `No brand safety concerns for "${topic}" (mock — add TAVILY_API_KEY for live results)`,
  };
}

// ── Real implementations ──────────────────────────────────────────────────────

async function realEnrich(prompt: string): Promise<EnrichedContext> {
  const { tavily } = await import("@tavily/core");
  const tc = tavily({ apiKey: process.env.TAVILY_API_KEY! });
  const topic = extractTopic(prompt);

  const response = await tc.search(topic, { maxResults: 5, searchDepth: "basic", includeAnswer: true });

  return {
    topic,
    results: (response.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: (r.content ?? "").slice(0, 200),
      score: r.score ?? 0,
    })),
    answer: response.answer ?? undefined,
  };
}

async function realSafety(prompt: string): Promise<BrandSafetySignals> {
  const { tavily } = await import("@tavily/core");
  const tc = tavily({ apiKey: process.env.TAVILY_API_KEY! });
  const topic = extractTopic(prompt);

  const response = await tc.search(
    `"${topic}" controversy OR scandal OR ban OR dangerous OR illegal OR harmful`,
    { maxResults: 5, searchDepth: "basic", topic: "news" }
  );

  const results = response.results ?? [];
  const combinedText = results.map((r) => (r.title ?? "") + " " + (r.content ?? "")).join(" ").toLowerCase();
  const flags = detectSafetyFlags(prompt.toLowerCase() + " " + combinedText);

  const flaggedSources = results
    .filter((r) => SAFETY_KEYWORDS.some((kw) => ((r.title ?? "") + (r.content ?? "")).toLowerCase().includes(kw)))
    .slice(0, 3)
    .map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: (r.content ?? "").slice(0, 150) }));

  return {
    safe: flags.length === 0,
    flags,
    flaggedSources,
    riskSummary: flags.length === 0
      ? `No safety concerns for "${topic}"`
      : `Brand safety issues for "${topic}": ${flags.join(", ")}`,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function enrichPrompt(prompt: string): Promise<EnrichedContext> {
  if (!process.env.TAVILY_API_KEY) return mockEnrich(extractTopic(prompt));
  try { return await realEnrich(prompt); }
  catch (err) { console.warn("[Tavily] enrichPrompt failed, using mock:", err); return mockEnrich(extractTopic(prompt)); }
}

export async function checkBrandSafety(prompt: string): Promise<BrandSafetySignals> {
  if (!process.env.TAVILY_API_KEY) return mockSafety(extractTopic(prompt));
  try { return await realSafety(prompt); }
  catch (err) { console.warn("[Tavily] checkBrandSafety failed, using mock:", err); return mockSafety(extractTopic(prompt)); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const SAFETY_KEYWORDS = [
  "controversy", "scandal", "ban", "banned", "illegal", "dangerous", "harmful",
  "violence", "murder", "shooting", "terrorist", "hate", "racist", "adult",
  "explicit", "nsfw", "fraud", "lawsuit", "recall", "unsafe",
];

const SAFETY_CATEGORIES: Record<string, string[]> = {
  violence: ["violence", "murder", "shooting", "terrorist", "bomb"],
  adult_content: ["adult", "explicit", "nsfw", "pornography"],
  hate_speech: ["hate", "racist", "discrimination", "extremist"],
  legal_risk: ["lawsuit", "fraud", "recall", "illegal", "banned"],
  controversy: ["scandal", "controversy", "harmful", "dangerous"],
};

function detectSafetyFlags(text: string): string[] {
  return Object.entries(SAFETY_CATEGORIES)
    .filter(([, kws]) => kws.some((kw) => text.includes(kw)))
    .map(([cat]) => cat);
}

export function extractTopic(prompt: string): string {
  return prompt
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8)
    .join(" ")
    .trim() || prompt.slice(0, 60);
}
