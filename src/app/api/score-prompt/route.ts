import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runPipeline } from "@/lib/overmind";

const RequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  session_id: z.string().default("anonymous"),
});

export async function POST(req: NextRequest) {
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

  try {
    const result = await runPipeline(parsed.data.prompt, parsed.data.session_id);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[/api/score-prompt]", err);
    return NextResponse.json(
      { error: "Pipeline error", message: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
