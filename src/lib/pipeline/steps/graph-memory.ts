import { withSession } from "@/lib/neo4j";
import type { IntentResult, BrandSafetyResult, VerdictResult, GraphMemoryResult } from "@/types";

export async function storeAndRecall(params: {
  promptId: string;
  sessionId: string;
  promptText: string;
  intent: IntentResult;
  safety: BrandSafetyResult;
  verdict: VerdictResult;
}): Promise<{
  graphResult: GraphMemoryResult;
  similarPastPrompts: Array<{
    promptText: string;
    intentScore: number;
    decision: string;
    adTopics: string[];
  }>;
}> {
  const { promptId, sessionId, promptText, intent, safety, verdict } = params;
  const timestamp = new Date().toISOString();

  return await withSession(async (session) => {
    // Store the full pipeline result as a connected subgraph
    await session.run(
      `
      MERGE (p:Prompt {id: $promptId})
      SET p.text = $promptText,
          p.sessionId = $sessionId,
          p.timestamp = $timestamp

      MERGE (i:IntentScore {promptId: $promptId})
      SET i.score = $intentScore,
          i.category = $intentCategory,
          i.signals = $signals,
          i.adTopics = $adTopics

      MERGE (s:BrandSafetyCheck {promptId: $promptId})
      SET s.safe = $brandSafe,
          s.flags = $brandFlags,
          s.topicSummary = $topicSummary

      MERGE (v:Verdict {promptId: $promptId})
      SET v.decision = $decision,
          v.reason = $reason,
          v.adCategories = $adCategories,
          v.bidPriceCpm = $bidPrice,
          v.confidence = $confidence

      MERGE (p)-[:HAS_INTENT]->(i)
      MERGE (i)-[:HAS_SAFETY_CHECK]->(s)
      MERGE (s)-[:LED_TO_VERDICT]->(v)
      `,
      {
        promptId,
        promptText,
        sessionId,
        timestamp,
        intentScore: intent.score,
        intentCategory: intent.category,
        signals: intent.signals,
        adTopics: intent.adTopics,
        brandSafe: safety.safe,
        brandFlags: safety.flags,
        topicSummary: safety.topicSummary,
        decision: verdict.decision,
        reason: verdict.reason,
        adCategories: verdict.adCategories,
        bidPrice: verdict.bidPriceCpm,
        confidence: verdict.confidence,
      }
    );

    // Retrieve similar past prompts by matching intent category
    const similarResult = await session.run(
      `
      MATCH (p:Prompt)-[:HAS_INTENT]->(i:IntentScore)-[:HAS_SAFETY_CHECK]->(:BrandSafetyCheck)-[:LED_TO_VERDICT]->(v:Verdict)
      WHERE i.category = $category
        AND p.id <> $promptId
      RETURN p.text AS promptText,
             i.score AS intentScore,
             v.decision AS decision,
             i.adTopics AS adTopics
      ORDER BY i.score DESC
      LIMIT 3
      `,
      { category: intent.category, promptId }
    );

    const similarPastPrompts = similarResult.records.map((r) => ({
      promptText: r.get("promptText") as string,
      intentScore: r.get("intentScore") as number,
      decision: r.get("decision") as string,
      adTopics: (r.get("adTopics") as string[]) ?? [],
    }));

    return {
      graphResult: {
        promptNodeId: promptId,
        intentNodeId: `intent-${promptId}`,
        safetyNodeId: `safety-${promptId}`,
        verdictNodeId: `verdict-${promptId}`,
      },
      similarPastPrompts,
    };
  });
}
