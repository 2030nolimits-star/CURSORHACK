import { v4 as uuidv4 } from "uuid";
import { getOvermindClient, traceStep } from "@/lib/overmind";
import { scoreIntent } from "./steps/score-intent";
import { checkBrandSafety } from "./steps/brand-safety";
import { storeAndRecall } from "./steps/graph-memory";
import { computeVerdict } from "./steps/verdict";
import { logEvent } from "@/lib/supabase";

export interface PipelineInput {
  prompt: string;
  sessionId: string;
}

export interface PipelineOutput {
  promptId: string;
  sessionId: string;
  score: number;
  verdict: "serve" | "block" | "review";
  reasoning: string;
  adCategories: string[];
  bidPriceCpm: number;
  intentCategory: string;
  intentSignals: string[];
  tavily_signals: {
    topicSummary: string;
    flags: string[];
    sources: { title: string; url: string; snippet: string }[];
  };
  similar_past_prompts: Array<{
    promptText: string;
    intentScore: number;
    decision: string;
    adTopics: string[];
  }>;
  overmindRunId: string;
  durationMs: number;
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const promptId = uuidv4();
  const overmind = getOvermindClient();
  const pipelineStart = Date.now();

  const overmindRunId = await overmind.createRun({
    workflowName: "ad-eligibility-pipeline",
    metadata: { promptId, sessionId: input.sessionId },
  });

  try {
    // Step 1: Score intent via Claude
    const intent = await traceStep(overmindRunId, "score_intent", { prompt: input.prompt }, () =>
      scoreIntent(input.prompt)
    );

    // Step 2: Brand safety via Tavily
    const safety = await traceStep(overmindRunId, "check_brand_safety", { prompt: input.prompt }, () =>
      checkBrandSafety(input.prompt)
    );

    // Step 3: Compute verdict
    const verdict = computeVerdict(intent, safety);

    // Step 4: Write to Neo4j + retrieve similar past prompts
    const { similarPastPrompts } = await traceStep(
      overmindRunId,
      "graph_memory",
      { promptId, intent, safety, verdict },
      () =>
        storeAndRecall({
          promptId,
          sessionId: input.sessionId,
          promptText: input.prompt,
          intent,
          safety,
          verdict,
        })
    );

    const durationMs = Date.now() - pipelineStart;

    // Log to Supabase (non-blocking)
    logEvent({
      prompt_id: promptId,
      session_id: input.sessionId,
      prompt_text: input.prompt,
      intent_score: intent.score,
      intent_category: intent.category,
      brand_safe: safety.safe,
      brand_flags: safety.flags,
      decision: verdict.decision,
      ad_categories: verdict.adCategories,
      bid_price_cpm: verdict.bidPriceCpm,
      reasoning: verdict.reason,
      overmind_run_id: overmindRunId,
    }).catch(() => {});

    await overmind.completeRun(overmindRunId, "completed", {
      verdict: verdict.decision,
      score: intent.score,
      durationMs,
    });

    return {
      promptId,
      sessionId: input.sessionId,
      score: intent.score,
      verdict: verdict.decision,
      reasoning: verdict.reason,
      adCategories: verdict.adCategories,
      bidPriceCpm: verdict.bidPriceCpm,
      intentCategory: intent.category,
      intentSignals: intent.signals,
      tavily_signals: {
        topicSummary: safety.topicSummary,
        flags: safety.flags,
        sources: safety.tavilyContext,
      },
      similar_past_prompts: similarPastPrompts,
      overmindRunId,
      durationMs,
    };
  } catch (err) {
    await overmind.completeRun(overmindRunId, "failed");
    throw err;
  }
}
