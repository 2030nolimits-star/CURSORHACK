import Anthropic from "@anthropic-ai/sdk";
import type { IntentResult } from "@/types";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are an ad intent classifier for an AI publisher monetization platform.
Analyze the user's chat prompt and return a JSON object with these exact fields:
- score: number 0.0–1.0 (commercial purchase intent)
- category: one of "purchase_ready"|"comparison"|"research"|"general_chat"|"off_topic"
- signals: array of 1–4 specific intent signals found in the text
- adTopics: array of 1–3 relevant IAB ad topic categories

Scoring guide:
- 0.8–1.0: explicit purchase intent ("I want to buy", "best price for", "where can I get")
- 0.5–0.7: comparison shopping or strong research with commercial end goal
- 0.2–0.4: informational research that may lead to purchase
- 0.0–0.1: general chat, how-things-work, off-topic

Return ONLY valid JSON, no markdown, no explanation.`;

export async function scoreIntent(prompt: string): Promise<IntentResult> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    message.content[0].type === "text" ? message.content[0].text : "{}";

  try {
    const parsed = JSON.parse(text);
    return {
      score: Number(parsed.score ?? 0),
      category: parsed.category ?? "off_topic",
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
      adTopics: Array.isArray(parsed.adTopics) ? parsed.adTopics : [],
    };
  } catch {
    return { score: 0, category: "off_topic", signals: [], adTopics: [] };
  }
}
