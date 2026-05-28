import { createClient } from "@supabase/supabase-js";
import type { Decision, IntentCategory } from "@/types";

// Server-side client (uses service role key for writes)
export function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

// Browser-safe client (anon key)
export function getSupabaseBrowser() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export interface EventRow {
  id?: string;
  prompt_id: string;
  session_id?: string;
  prompt_text: string;
  intent_score: number;
  intent_category: IntentCategory;
  brand_safe: boolean;
  brand_flags: string[];
  decision: Decision;
  ad_categories: string[];
  bid_price_cpm: number;
  reasoning: string;
  overmind_run_id?: string;
  created_at?: string;
}

export async function logEvent(event: EventRow): Promise<void> {
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("events").insert(event);
  if (error) console.error("[Supabase] logEvent failed:", error.message);
}

export async function getStats() {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("events")
    .select("decision, intent_score, intent_category, bid_price_cpm")
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error || !data) return null;

  const total = data.length;
  const serve = data.filter((r) => r.decision === "serve");
  const block = data.filter((r) => r.decision === "block");
  const review = data.filter((r) => r.decision === "review");

  const avgIntent =
    total > 0 ? data.reduce((s, r) => s + r.intent_score, 0) / total : 0;
  const totalRevenue = serve.reduce((s, r) => s + r.bid_price_cpm, 0);

  const categories = ["purchase_ready", "comparison", "research", "general_chat", "off_topic"] as IntentCategory[];
  const intentDistribution = categories.map((cat) => ({
    category: cat,
    count: data.filter((r) => r.intent_category === cat).length,
  }));

  return {
    totalRequests: total,
    serveCount: serve.length,
    blockCount: block.length,
    reviewCount: review.length,
    avgIntentScore: Number(avgIntent.toFixed(3)),
    totalRevenueCpm: Number(totalRevenue.toFixed(2)),
    serveRate: total > 0 ? Number((serve.length / total).toFixed(3)) : 0,
    intentDistribution,
  };
}

export async function getReviewQueue() {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("events")
    .select("*")
    .eq("decision", "review")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) return [];
  return data ?? [];
}

export async function resolveReview(
  id: string,
  resolution: "approved" | "rejected"
): Promise<void> {
  const sb = getSupabaseAdmin();
  await sb
    .from("events")
    .update({ decision: resolution === "approved" ? "serve" : "block" })
    .eq("id", id);
}
