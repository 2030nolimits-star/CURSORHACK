"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";

// ── Types ────────────────────────────────────────────────────────────────────

interface ScoredPrompt {
  prompt_id: string;
  prompt_text: string;
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
    brand_safety: { safe: boolean; flags: string[]; risk_summary: string; flagged_sources: { title: string; url: string }[] };
  };
  similar_past_prompts: { prompt_text: string; intent_score: number; verdict: string; conversion_count: number }[];
  overmind_run_id: string;
  duration_ms: number;
  ts: number;
}

interface Stats {
  total_today: number;
  serve_count: number;
  review_count: number;
  block_count: number;
  serve_rate: number;
  conversion_rate: number;
  avg_intent_score: number;
  estimated_revenue_usd: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_PROMPTS = [
  "I want to buy noise-cancelling headphones under £200, ideally Sony or Bose",
  "Best running shoes for marathon training in 2025 — need to order by Friday",
  "Compare MacBook Air M3 vs Dell XPS 15 for software development work",
  "How does photosynthesis work?",
  "Cheap flights from London to New York this summer, flexible dates",
  "What's the meaning of existentialism?",
  "iPhone 16 Pro deal with trade-in, comparing carriers in the UK",
  "How do I make sourdough bread at home?",
];

const VERDICT_LABEL = { SERVE: "✅ SERVE", REVIEW: "⚠️ REVIEW", BLOCK: "🔴 BLOCK" };
const VERDICT_BG = {
  SERVE: "bg-emerald-900/50 text-emerald-400 border border-emerald-800",
  REVIEW: "bg-amber-900/50 text-amber-400 border border-amber-800",
  BLOCK: "bg-red-900/50 text-red-400 border border-red-800",
};
const VERDICT_BAR = { SERVE: "bg-emerald-500", REVIEW: "bg-amber-500", BLOCK: "bg-red-500" };

function ScoreBar({ score, small = false }: { score: number; small?: boolean }) {
  const color = score > 70 ? "bg-emerald-500" : score >= 40 ? "bg-amber-500" : "bg-red-500";
  const h = small ? "h-1.5" : "h-2";
  return (
    <div className={`w-full ${small ? "w-20" : ""} bg-white/10 rounded-full ${h} overflow-hidden`}>
      <div className={`${h} rounded-full ${color} transition-all`} style={{ width: `${score}%` }} />
    </div>
  );
}

function Badge({ verdict }: { verdict: "SERVE" | "REVIEW" | "BLOCK" }) {
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${VERDICT_BG[verdict]}`}>
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [prompt, setPrompt] = useState("");
  const [sessionId] = useState(() => `sess-${Math.random().toString(36).slice(2, 8)}`);
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<ScoredPrompt[]>([]);
  const [selectedItem, setSelectedItem] = useState<ScoredPrompt | null>(null);
  const [reviewQueue, setReviewQueue] = useState<ScoredPrompt[]>([]);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>({
    total_today: 0, serve_count: 0, review_count: 0, block_count: 0,
    serve_rate: 0, conversion_rate: 0, avg_intent_score: 0, estimated_revenue_usd: 0,
  });

  // Build score distribution from feed
  const scoreDist = Array.from({ length: 10 }, (_, i) => ({
    bucket: `${i * 10}–${i * 10 + 10}`,
    count: feed.filter((f) => f.score >= i * 10 && f.score < (i + 1) * 10).length,
    color: i >= 7 ? "#10b981" : i >= 4 ? "#f59e0b" : "#ef4444",
  }));

  const recalcStats = useCallback((items: ScoredPrompt[]) => {
    const today = items.filter((i) => Date.now() - i.ts < 86_400_000);
    const served = today.filter((i) => i.verdict === "SERVE");
    setStats({
      total_today: today.length,
      serve_count: served.length,
      review_count: today.filter((i) => i.verdict === "REVIEW").length,
      block_count: today.filter((i) => i.verdict === "BLOCK").length,
      serve_rate: today.length ? Number((served.length / today.length * 100).toFixed(1)) : 0,
      conversion_rate: 4.2,
      avg_intent_score: today.length ? Number((today.reduce((s, i) => s + i.score, 0) / today.length).toFixed(1)) : 0,
      estimated_revenue_usd: Number((served.length * 0.003).toFixed(4)),
    });
  }, []);

  async function runPrompt(p: string) {
    if (running || !p.trim()) return;
    setRunning(true);
    setSelectedItem(null);
    setPipelineError(null);
    console.log("[runPrompt] sending prompt:", p.slice(0, 60));
    try {
      const res = await fetch("/api/score-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: p, session_id: sessionId }),
      });
      console.log("[runPrompt] response status:", res.status);
      if (!res.ok) {
        const errText = await res.text();
        console.error("[runPrompt] error body:", errText);
        throw new Error(errText);
      }
      const data = await res.json();
      console.log("[runPrompt] result:", data);
      const entry: ScoredPrompt = { ...data, prompt_text: p, ts: Date.now() };
      setSelectedItem(entry);
      setFeed((prev) => {
        const next = [entry, ...prev].slice(0, 50);
        recalcStats(next);
        return next;
      });
      if (data.verdict === "REVIEW") {
        setReviewQueue((prev) => [entry, ...prev].slice(0, 20));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[runPrompt] failed:", msg);
      setPipelineError(msg);
    } finally {
      setRunning(false);
    }
  }

  function resolveReview(id: string, resolution: "SERVE" | "BLOCK") {
    setReviewQueue((prev) => prev.filter((i) => i.prompt_id !== id));
    setFeed((prev) => {
      const next = prev.map((i) => i.prompt_id === id ? { ...i, verdict: resolution } : i);
      recalcStats(next);
      return next;
    });
  }

  const statsCards = [
    { label: "Prompts today", value: stats.total_today, color: "text-slate-200" },
    { label: "Served", value: stats.serve_count, color: "text-emerald-400" },
    { label: "In review", value: stats.review_count, color: "text-amber-400" },
    { label: "Blocked", value: stats.block_count, color: "text-red-400" },
    { label: "Serve rate", value: `${stats.serve_rate}%`, color: "text-emerald-300" },
    { label: "Avg score", value: stats.avg_intent_score, color: "text-indigo-400" },
    { label: "Est. revenue", value: `$${stats.estimated_revenue_usd.toFixed(4)}`, color: "text-emerald-300" },
    { label: "Conv. rate", value: `${stats.conversion_rate}%`, color: "text-slate-300" },
  ];

  return (
    <div className="min-h-screen bg-[#09090d] text-slate-200 font-mono">
      {/* Top nav */}
      <header className="border-b border-white/5 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-indigo-600 flex items-center justify-center text-xs font-bold text-white">IG</div>
          <span className="text-sm font-semibold tracking-tight">IntentGraph</span>
          <span className="text-[10px] text-slate-500 border border-white/10 rounded px-1.5 py-0.5">Publisher Dashboard</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-[10px] text-slate-500">pipeline live · Overmind traced · Alpic MCP</span>
        </div>
      </header>

      <div className="px-6 py-5 space-y-5 max-w-[1440px] mx-auto">
        {/* ── Section 1: Stats bar ── */}
        <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
          {statsCards.map((s) => (
            <div key={s.label} className="bg-white/[0.03] border border-white/5 rounded-lg p-3">
              <p className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">{s.label}</p>
              <p className={`text-lg font-semibold leading-none ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
          {/* ── Left col: Input + trace + live feed ── */}
          <div className="xl:col-span-2 space-y-4">
            {/* Prompt input */}
            <div className="bg-white/[0.03] border border-white/5 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-medium text-slate-300 uppercase tracking-widest">Score a Prompt</h2>
                <span className="text-[10px] text-slate-600">Runs: ENRICH → SAFETY → MEMORY → SCORE → VERDICT → STORE</span>
              </div>
              <textarea
                rows={2}
                placeholder="Enter a chat prompt to run through the eligibility pipeline…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runPrompt(prompt); }}
                className="w-full bg-black/30 border border-white/10 rounded-lg p-3 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/60 resize-none"
              />
              {pipelineError && (
                <div className="text-[11px] text-red-400 bg-red-900/30 border border-red-800 rounded-lg px-3 py-2 break-all">
                  <span className="font-semibold">Pipeline error:</span> {pipelineError}
                </div>
              )}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => runPrompt(prompt)}
                  disabled={running || !prompt.trim()}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs rounded-lg transition-colors font-medium"
                >
                  {running ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Processing…
                    </span>
                  ) : "Run pipeline  ⌘↵"}
                </button>
                <span className="text-[10px] text-slate-600">or try:</span>
                {DEMO_PROMPTS.slice(0, 3).map((p, i) => (
                  <button
                    key={i}
                    onClick={() => { setPrompt(p); runPrompt(p); }}
                    className="text-[10px] px-2 py-1 rounded border border-white/10 text-slate-500 hover:border-indigo-500/50 hover:text-indigo-400 transition-colors max-w-[200px] truncate"
                    title={p}
                  >
                    {p.slice(0, 35)}…
                  </button>
                ))}
              </div>
            </div>

            {/* Active trace */}
            {selectedItem && (
              <div className="bg-white/[0.03] border border-white/5 rounded-xl p-4 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-400 truncate">{selectedItem.prompt_text}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge verdict={selectedItem.verdict} />
                    <span className="text-[10px] text-slate-600">{selectedItem.duration_ms}ms</span>
                  </div>
                </div>

                {/* Score breakdown */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest">Total score</span>
                      <span className={`text-xl font-bold ${selectedItem.score > 70 ? "text-emerald-400" : selectedItem.score >= 40 ? "text-amber-400" : "text-red-400"}`}>
                        {selectedItem.score}
                        <span className="text-xs text-slate-600 font-normal">/100</span>
                      </span>
                    </div>
                    <ScoreBar score={selectedItem.score} />
                    <p className="text-[10px] text-slate-500 mt-2">{selectedItem.reasoning}</p>
                  </div>
                  <div className="space-y-2">
                    {[
                      { label: "Purchase intent", val: selectedItem.score_breakdown.purchaseIntent, max: 25 },
                      { label: "Topic specificity", val: selectedItem.score_breakdown.topicSpecificity, max: 25 },
                      { label: "Contextual relevance", val: selectedItem.score_breakdown.contextualRelevance, max: 25 },
                      { label: "Brand safety", val: selectedItem.score_breakdown.brandSafety, max: 25 },
                    ].map((d) => (
                      <div key={d.label} className="flex items-center gap-2">
                        <span className="text-[9px] text-slate-600 w-32 shrink-0">{d.label}</span>
                        <div className="flex-1 bg-white/5 rounded h-1.5">
                          <div
                            className={`h-1.5 rounded transition-all ${VERDICT_BAR[selectedItem.verdict]}`}
                            style={{ width: `${(d.val / d.max) * 100}%` }}
                          />
                        </div>
                        <span className="text-[9px] text-slate-500 w-8 text-right">{d.val}/{d.max}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Tavily signals */}
                <div className="grid grid-cols-2 gap-3 border-t border-white/5 pt-3">
                  <div>
                    <p className="text-[9px] text-slate-600 uppercase tracking-widest mb-1.5">Tavily signals</p>
                    <p className="text-[10px] text-slate-400">{selectedItem.tavily_signals?.brand_safety?.risk_summary}</p>
                    {selectedItem.tavily_signals?.brand_safety?.flags?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {selectedItem.tavily_signals.brand_safety.flags.map((f) => (
                          <span key={f} className="text-[9px] px-1.5 py-0.5 bg-red-900/50 text-red-400 border border-red-800 rounded">{f}</span>
                        ))}
                      </div>
                    )}
                    {selectedItem.tavily_signals?.top_sources?.slice(0, 2).map((s) => (
                      <a key={s.url} href={s.url} target="_blank" rel="noreferrer"
                        className="block text-[9px] text-indigo-400 hover:underline mt-1 truncate">
                        → {s.title}
                      </a>
                    ))}
                  </div>
                  <div>
                    <p className="text-[9px] text-slate-600 uppercase tracking-widest mb-1.5">Neo4j memory · similar prompts</p>
                    {selectedItem.similar_past_prompts?.length === 0 && (
                      <p className="text-[10px] text-slate-600">No similar past prompts yet</p>
                    )}
                    {selectedItem.similar_past_prompts?.slice(0, 3).map((p, i) => (
                      <div key={i} className="flex items-center gap-1.5 mb-1">
                        <Badge verdict={p.verdict as "SERVE" | "REVIEW" | "BLOCK"} />
                        <span className="text-[9px] text-slate-500 truncate flex-1">{p.prompt_text?.slice(0, 40)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border-t border-white/5 pt-2 flex items-center gap-2">
                  <span className="text-[9px] text-slate-600">Overmind run:</span>
                  <code className="text-[9px] text-indigo-400">{selectedItem.overmind_run_id}</code>
                  <span className="text-[9px] text-slate-600">· confidence:</span>
                  <span className="text-[9px] text-slate-400">{selectedItem.confidence}</span>
                </div>
              </div>
            )}

            {/* ── Section 2: Live feed ── */}
            <div className="bg-white/[0.03] border border-white/5 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-slate-300 uppercase tracking-widest">Live Feed</h2>
                <span className="text-[10px] text-slate-600">{feed.length} scored this session</span>
              </div>
              <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
                {feed.length === 0 && (
                  <p className="text-[11px] text-slate-600 py-4 text-center">Run a prompt above to see results here</p>
                )}
                {feed.map((item) => (
                  <button
                    key={item.prompt_id}
                    onClick={() => setSelectedItem(item)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left hover:bg-white/5 transition-colors ${selectedItem?.prompt_id === item.prompt_id ? "bg-white/5 border border-white/10" : ""}`}
                  >
                    <Badge verdict={item.verdict} />
                    <span className="flex-1 text-[11px] text-slate-300 truncate min-w-0">{item.prompt_text}</span>
                    <div className="w-16 shrink-0">
                      <ScoreBar score={item.score} small />
                    </div>
                    <span className="text-[10px] text-slate-600 w-6 text-right shrink-0">{item.score}</span>
                    <span className="text-[9px] text-slate-700 shrink-0">
                      {new Date(item.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Right col: Chart + review queue ── */}
          <div className="space-y-4">
            {/* ── Section 4: Score distribution ── */}
            <div className="bg-white/[0.03] border border-white/5 rounded-xl p-4">
              <h2 className="text-xs font-medium text-slate-300 uppercase tracking-widest mb-3">Score Distribution</h2>
              {feed.length === 0 ? (
                <p className="text-[10px] text-slate-600 text-center py-6">No data yet</p>
              ) : (
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={scoreDist} margin={{ top: 0, right: 0, left: -28, bottom: 0 }}>
                    <XAxis dataKey="bucket" tick={{ fontSize: 8, fill: "#475569" }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 8, fill: "#475569" }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: "#0f0f15", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, fontSize: 10 }}
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                      {scoreDist.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
              <div className="flex justify-center gap-4 mt-2">
                {[["#10b981", ">70 Serve"], ["#f59e0b", "40–70 Review"], ["#ef4444", "<40 Block"]].map(([c, l]) => (
                  <div key={l} className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm" style={{ background: c }} />
                    <span className="text-[9px] text-slate-600">{l}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Section 3: Human review queue ── */}
            <div className="bg-white/[0.03] border border-white/5 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium text-slate-300 uppercase tracking-widest">Human Review</h2>
                {reviewQueue.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 bg-amber-900/60 text-amber-400 border border-amber-800 rounded-full">
                    {reviewQueue.length} pending
                  </span>
                )}
              </div>
              <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
                {reviewQueue.length === 0 && (
                  <p className="text-[10px] text-slate-600 py-6 text-center">
                    No items in queue.<br />
                    <span className="text-slate-700">Score 40–70 prompts will appear here.</span>
                  </p>
                )}
                {reviewQueue.map((item) => (
                  <div key={item.prompt_id} className="bg-amber-950/20 border border-amber-900/40 rounded-xl p-3 space-y-3">
                    <p className="text-[11px] text-slate-200 leading-relaxed">{item.prompt_text}</p>

                    <div className="grid grid-cols-2 gap-2">
                      {[
                        { label: "Purchase", val: item.score_breakdown.purchaseIntent, max: 25 },
                        { label: "Specificity", val: item.score_breakdown.topicSpecificity, max: 25 },
                        { label: "Relevance", val: item.score_breakdown.contextualRelevance, max: 25 },
                        { label: "Safety", val: item.score_breakdown.brandSafety, max: 25 },
                      ].map((d) => (
                        <div key={d.label} className="flex items-center gap-1.5">
                          <span className="text-[9px] text-slate-600 w-16 shrink-0">{d.label}</span>
                          <div className="flex-1 bg-white/5 h-1 rounded">
                            <div className="h-1 rounded bg-amber-500" style={{ width: `${(d.val / d.max) * 100}%` }} />
                          </div>
                          <span className="text-[9px] text-slate-600">{d.val}</span>
                        </div>
                      ))}
                    </div>

                    {item.tavily_signals?.brand_safety?.flags?.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {item.tavily_signals.brand_safety.flags.map((f) => (
                          <span key={f} className="text-[9px] px-1.5 py-0.5 bg-red-900/40 text-red-400 border border-red-900 rounded">{f}</span>
                        ))}
                      </div>
                    )}

                    {item.similar_past_prompts?.length > 0 && (
                      <div>
                        <p className="text-[9px] text-slate-600 mb-1">Similar past prompts:</p>
                        {item.similar_past_prompts.slice(0, 2).map((p, i) => (
                          <div key={i} className="flex items-center gap-1.5 mb-0.5">
                            <Badge verdict={p.verdict as "SERVE" | "REVIEW" | "BLOCK"} />
                            <span className="text-[9px] text-slate-500 truncate">{p.prompt_text?.slice(0, 45)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    <p className="text-[9px] text-slate-500 italic">{item.reasoning}</p>

                    <div className="flex gap-2 pt-1 border-t border-white/5">
                      <button
                        onClick={() => resolveReview(item.prompt_id, "SERVE")}
                        className="flex-1 text-[11px] py-1.5 font-medium rounded-lg bg-emerald-900/40 text-emerald-400 border border-emerald-900 hover:bg-emerald-900/70 transition-colors"
                      >
                        Approve → SERVE
                      </button>
                      <button
                        onClick={() => resolveReview(item.prompt_id, "BLOCK")}
                        className="flex-1 text-[11px] py-1.5 font-medium rounded-lg bg-red-900/40 text-red-400 border border-red-900 hover:bg-red-900/70 transition-colors"
                      >
                        Reject → BLOCK
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
