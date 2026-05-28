import { NextResponse } from "next/server";
import { getStats, getReviewQueue } from "@/lib/supabase";

export async function GET() {
  const [stats, queue] = await Promise.all([getStats(), getReviewQueue()]);
  return NextResponse.json({ stats, queue });
}
