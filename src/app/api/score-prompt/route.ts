import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runPipeline } from "@/lib/overmind";

const RequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  session_id: z.string().default("anonymous"),
});

export async function POST(req: NextRequest) {
  console.log("[/api/score-prompt] POST received");
  console.log("[/api/score-prompt] env vars present:", {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    TAVILY_API_KEY: !!process.env.TAVILY_API_KEY,
    NEO4J_URI: !!process.env.NEO4J_URI,
    OVERMIND_API_KEY: !!process.env.OVERMIND_API_KEY,
  });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  console.log("[/api/score-prompt] running pipeline for prompt:", parsed.data.prompt.slice(0, 60));

  try {
    const result = await runPipeline(parsed.data.prompt, parsed.data.session_id);
    console.log("[/api/score-prompt] pipeline completed, verdict:", result.verdict, "score:", result.score);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/score-prompt] pipeline error:", err);
    return NextResponse.json(
      { error: "Pipeline error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
