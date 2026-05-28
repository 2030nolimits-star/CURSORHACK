import { searchBrandSafetyContext, extractTopicFromPrompt } from "@/lib/tavily";
import type { BrandSafetyResult } from "@/types";

const SAFETY_KEYWORDS = {
  adult_content: ["adult", "explicit", "nsfw", "pornography", "sexual"],
  violence: ["violence", "murder", "weapon", "shooting", "attack", "bomb"],
  hate_speech: ["hate", "racist", "discrimination", "slur", "extremist"],
  political_sensitivity: ["election", "propaganda", "political party", "campaign"],
  competitor_risk: ["lawsuit", "sued", "scandal", "recall", "unsafe", "fraud"],
};

function detectFlags(text: string): string[] {
  const lower = text.toLowerCase();
  const flags: string[] = [];
  for (const [flag, keywords] of Object.entries(SAFETY_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      flags.push(flag);
    }
  }
  return flags;
}

export async function checkBrandSafety(
  prompt: string
): Promise<BrandSafetyResult> {
  const topic = await extractTopicFromPrompt(prompt);

  let tavilyResults: Awaited<ReturnType<typeof searchBrandSafetyContext>> = [];
  try {
    tavilyResults = await searchBrandSafetyContext(topic);
  } catch (err) {
    console.warn("[BrandSafety] Tavily search failed:", err);
  }

  // Check prompt itself for safety flags
  const promptFlags = detectFlags(prompt);

  // Check Tavily results for safety flags
  const contextFlags: string[] = [];
  const contextText = tavilyResults.map((r) => r.content + " " + r.title).join(" ");
  const contextFlagsFound = detectFlags(contextText);
  contextFlags.push(...contextFlagsFound);

  const allFlags = [...new Set([...promptFlags, ...contextFlags])];

  const tavilyContext = tavilyResults.slice(0, 3).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content.slice(0, 200),
  }));

  const topicSummary =
    tavilyResults.length > 0
      ? `Topic "${topic}" returned ${tavilyResults.length} Tavily results. Context appears ${allFlags.length === 0 ? "brand-safe" : `flagged: ${allFlags.join(", ")}`}.`
      : `No Tavily context found for topic "${topic}".`;

  return {
    safe: allFlags.length === 0,
    flags: allFlags,
    tavilyContext,
    topicSummary,
  };
}
