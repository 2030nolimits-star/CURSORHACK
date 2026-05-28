import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveReview } from "@/lib/supabase";

const BodySchema = z.object({
  resolution: z.enum(["approved", "rejected"]),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const parsed = BodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid resolution" }, { status: 400 });
  }

  await resolveReview(params.id, parsed.data.resolution);
  return NextResponse.json({ ok: true });
}
