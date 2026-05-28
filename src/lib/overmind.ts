// Overmind agent orchestration client
// Each runPipeline() call creates a traceable run in Overmind's dashboard
// Judges can watch every step — name, input summary, output summary, timing, status
// Docs: https://docs.overmind.ai

import { v4 as uuidv4 } from "uuid";
import { enrichPrompt, checkBrandSafety } from "@/lib/tavily";
import { scorePrompt } from "@/lib/scorer";
import { storePromptContext, findSimilarContexts } from "@/lib/neo4j";

// ── Overmind HTTP client ──────────────────────────────────────────────────────

interface OvermindStepLog {
  step_name: string;
  status: "running" | "success" | "error";
  input_summary?: string;
  output_summary?: string;
  duration_ms?: number;
  error?: string;
}

class OvermindClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async post(path: string, body: unknown): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`[Overmind] ${path} → ${res.status}: ${text}`);
      }
    } catch (err) {
      console.warn(`[Overmind] ${path} failed (non-fatal):`, err);
    }
  }

  async createRun(runId: string, workflowName: string, metadata?: Record<string, string>): Promise<void> {
    await this.post("/runs", { id: runId, workflow_name: workflowName, metadata });
  }

  async logStep(runId: string, log: OvermindStepLog): Promise<void> {
    await this.post(`/runs/${runId}/steps`, log);
  }

  async completeRun(runId: string, status: "completed" | "failed", summary?: unknown): Promise<void> {
    await this.post(`/runs/${runId}/complete`, { status, summary });
  }
}

let _client: OvermindClient | null = null;

function getClient(): OvermindClient {
  if (!_client) {
    _client = new OvermindClient(
      process.env.OVERMIND_API_KEY ?? "no-key",
      process.env.OVERMIND_API_URL ?? "https://api.overmind.ai/v1"
    );
  }
  return _client;
}

// Wraps an async step with Overmind tracing
async function traceStep<T>(
  runId: string,
  stepName: string,
  inputSummary: string,
  fn: () => Promise<T>,
  summariseOutput: (out: T) => string
): Promise<T> {
  const overmind = getClient();
  const start = Date.now();

  await overmind.logStep(runId, { step_name: stepName, status: "running", input_summary: inputSummary });

  try {
    const output = await fn();
    await overmind.logStep(runId, {
      step_name: stepName,
      status: "success",
      input_summary: inputSummary,
      output_summary: summariseOutput(output),
      duration_ms: Date.now() - start,
    });
    return output;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await overmind.logStep(runId, {
      step_name: stepName,
      status: "error",
      input_summary: inputSummary,
      error,
      duration_ms: Date.now() - start,
    });
    throw err;
  }
}

// ── Pipeline result ───────────────────────────────────────────────────────────

export interface PipelineResult {
  prompt_id: string;
  session_id: string;
  score: number;
  verdict: "SERVE" | "REVIEW" | "BLOCK";
  reasoning: string;
  confidence: "high" | "medium" | "low";
  score_breakdown: {
    purchaseIntent: number;
    topicSpecificity: number;
    contextualRelevance: number;
    brandSafety: number;
  };
  tavily_signals: {
    topic: string;
    context_answer?: string;
    top_sources: { title: string; url: string; snippet: string }[];
    brand_safety: {
      safe: boolean;
      flags: string[];
      risk_summary: string;
      flagged_sources: { title: string; url: string; snippet: string }[];
    };
  };
  similar_past_prompts: {
    prompt_text: string;
    intent_score: number;
    verdict: string;
    conversion_count: number;
  }[];
  overmind_run_id: string;
  duration_ms: number;
}

function deriveVerdict(
  total: number,
  brandSafe: boolean,
  brandSafetyDim: number
): "SERVE" | "REVIEW" | "BLOCK" {
  if (!brandSafe || brandSafetyDim === 0) return "BLOCK";
  if (total > 70) return "SERVE";
  if (total >= 40) return "REVIEW";
  return "BLOCK";
}

// ── runPipeline ───────────────────────────────────────────────────────────────

export async function runPipeline(prompt: string, sessionId: string): Promise<PipelineResult> {
  const runId = uuidv4();
  const promptId = uuidv4();
  const pipelineStart = Date.now();
  const overmind = getClient();

  await overmind.createRun(runId, "intentgraph-ad-eligibility", {
    prompt_id: promptId,
    session_id: sessionId,
    prompt_preview: prompt.slice(0, 80),
  });

  try {
    // Step 1: ENRICH
    const tavilyContext = await traceStep(
      runId, "ENRICH",
      `prompt="${prompt.slice(0, 60)}…"`,
      () => enrichPrompt(prompt),
      (ctx) => `topic="${ctx.topic}", results=${ctx.results.length}, hasAnswer=${!!ctx.answer}`
    );

    // Step 2: SAFETY_CHECK
    const safety = await traceStep(
      runId, "SAFETY_CHECK",
      `topic="${tavilyContext.topic}"`,
      () => checkBrandSafety(prompt),
      (s) => `safe=${s.safe}, flags=[${s.flags.join(",")}]`
    );

    // Step 3: MEMORY_LOOKUP — find similar past prompts before scoring
    const similarContexts = await traceStep(
      runId, "MEMORY_LOOKUP",
      `topic_category="${tavilyContext.topic}", topK=5`,
      () => findSimilarContexts(tavilyContext.topic, promptId, 5),
      (ctx) => `found=${ctx.length} similar contexts`
    );

    // Step 4: SCORE
    const scoring = await traceStep(
      runId, "SCORE",
      `prompt="${prompt.slice(0, 60)}…", tavilyResults=${tavilyContext.results.length}`,
      () => scorePrompt(prompt, tavilyContext, safety),
      (s) => `total=${s.total}, confidence=${s.confidence}, breakdown=${JSON.stringify(s.breakdown)}`
    );

    // Step 5: VERDICT
    const verdict = await traceStep(
      runId, "VERDICT",
      `score=${scoring.total}, brandSafe=${safety.safe}, brandSafetyDim=${scoring.breakdown.brandSafety}`,
      async () => {
        const v = deriveVerdict(scoring.total, safety.safe, scoring.breakdown.brandSafety);
        return v;
      },
      (v) => `verdict=${v}`
    );

    const verdictSuffix: Record<string, string> = {
      SERVE: "Eligible for premium ad serving.",
      REVIEW: "Queued for human review before ad serving.",
      BLOCK: safety.safe ? "Insufficient commercial value." : "Brand safety violation — ads suppressed.",
    };

    const reasoning = `${scoring.reasoning} ${verdictSuffix[verdict]}`.trim();

    // Step 6: STORE
    await traceStep(
      runId, "STORE",
      `promptId=${promptId}, verdict=${verdict}`,
      () =>
        storePromptContext({
          id: promptId,
          prompt_text: prompt,
          topic_category: tavilyContext.topic,
          intent_score: scoring.total,
          verdict,
          session_id: sessionId,
          ad_categories: tavilyContext.results.map((r) => r.title).slice(0, 2),
        }),
      () => "stored to Neo4j"
    );

    const durationMs = Date.now() - pipelineStart;

    await overmind.completeRun(runId, "completed", {
      verdict,
      score: scoring.total,
      duration_ms: durationMs,
    });

    return {
      prompt_id: promptId,
      session_id: sessionId,
      score: scoring.total,
      verdict,
      reasoning,
      confidence: scoring.confidence,
      score_breakdown: scoring.breakdown,
      tavily_signals: {
        topic: tavilyContext.topic,
        context_answer: tavilyContext.answer,
        top_sources: tavilyContext.results.slice(0, 3).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        })),
        brand_safety: {
          safe: safety.safe,
          flags: safety.flags,
          risk_summary: safety.riskSummary,
          flagged_sources: safety.flaggedSources,
        },
      },
      similar_past_prompts: similarContexts.map((c) => ({
        prompt_text: c.prompt_text,
        intent_score: c.intent_score,
        verdict: c.verdict,
        conversion_count: c.conversion_count,
      })),
      overmind_run_id: runId,
      duration_ms: durationMs,
    };
  } catch (err) {
    await overmind.completeRun(runId, "failed");
    throw err;
  }
}
