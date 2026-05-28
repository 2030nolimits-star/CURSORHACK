#!/usr/bin/env node
/**
 * IntentGraph MCP Server — hosted on Alpic
 *
 * Tools:
 *   1. score_prompt        — full 6-step Overmind pipeline (calls IntentGraph API)
 *   2. check_brand_safety  — Tavily brand safety check
 *   3. get_publisher_stats — Neo4j today's aggregate metrics
 *
 * Deploy:  alpic deploy ./mcp --name intentgraph --env ANTHROPIC_API_KEY=... TAVILY_API_KEY=...
 * Connect: Add to cursor MCP config as the Alpic endpoint URL
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { tavily } from "@tavily/core";
import neo4j from "neo4j-driver";

const INTENTGRAPH_API_URL = process.env.INTENTGRAPH_API_URL ?? "http://localhost:3000";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "";
const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? "password";

const tavilyClient = tavily({ apiKey: TAVILY_API_KEY });

function getNeo4jDriver() {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
}

// ── Tool implementations ──────────────────────────────────────────────────────

async function toolScorePrompt(prompt: string, sessionId: string) {
  const res = await fetch(`${INTENTGRAPH_API_URL}/api/score-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, session_id: sessionId }),
  });

  if (!res.ok) {
    throw new Error(`IntentGraph API ${res.status}: ${await res.text()}`);
  }

  return res.json();
}

const SAFETY_PATTERNS: Record<string, string[]> = {
  violence: ["violence", "murder", "shooting", "terrorist", "bomb"],
  adult_content: ["adult", "explicit", "nsfw", "pornography"],
  hate_speech: ["hate", "racist", "extremist", "slur"],
  legal_risk: ["lawsuit", "fraud", "recall", "illegal", "banned"],
  controversy: ["scandal", "controversy", "harmful", "dangerous"],
};

async function toolCheckBrandSafety(topic: string) {
  let results: { title: string; url: string; snippet: string }[] = [];
  let contextFlags: string[] = [];

  try {
    const response = await tavilyClient.search(
      `"${topic}" controversy OR scandal OR dangerous OR illegal OR harmful`,
      { maxResults: 5, searchDepth: "basic", topic: "news" }
    );

    results = (response.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: (r.content ?? "").slice(0, 150),
    }));

    const combinedText = results.map((r) => r.title + " " + r.snippet).join(" ").toLowerCase();
    contextFlags = Object.entries(SAFETY_PATTERNS)
      .filter(([, kws]) => kws.some((kw) => combinedText.includes(kw)))
      .map(([flag]) => flag);
  } catch (err) {
    console.error("[MCP check_brand_safety] Tavily error:", err);
  }

  const topicFlags = Object.entries(SAFETY_PATTERNS)
    .filter(([, kws]) => kws.some((kw) => topic.toLowerCase().includes(kw)))
    .map(([flag]) => flag);

  const allFlags = [...new Set([...topicFlags, ...contextFlags])];
  const safe = allFlags.length === 0;

  const confidence =
    results.length >= 3 ? "high" : results.length >= 1 ? "medium" : "low";

  return {
    safe,
    signals: allFlags,
    confidence,
    flagged_sources: results.filter((r) =>
      SAFETY_PATTERNS["controversy"].some((kw) => (r.title + r.snippet).toLowerCase().includes(kw))
    ),
    summary: safe
      ? `No brand safety concerns detected for "${topic}" (${confidence} confidence)`
      : `Brand safety flags for "${topic}": ${allFlags.join(", ")} (${confidence} confidence)`,
  };
}

async function toolGetPublisherStats() {
  const driver = getNeo4jDriver();
  const session = driver.session();

  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const result = await session.run(
      `
      MATCH (pc:PromptContext)
      WHERE pc.timestamp >= $todayStart
      WITH
        count(pc) AS total,
        sum(CASE WHEN pc.verdict = 'SERVE'  THEN 1 ELSE 0 END) AS serve_count,
        sum(CASE WHEN pc.verdict = 'REVIEW' THEN 1 ELSE 0 END) AS review_count,
        sum(CASE WHEN pc.verdict = 'BLOCK'  THEN 1 ELSE 0 END) AS block_count,
        avg(pc.intent_score) AS avg_score
      OPTIONAL MATCH (ap:AdPlacement)-[:CONVERTED]->(cv:ConversionEvent)
      WHERE ap.served_at >= $todayStart
      RETURN total, serve_count, review_count, block_count, avg_score, count(cv) AS conversions
      `,
      { todayStart: todayStart.toISOString() }
    );

    if (result.records.length === 0) {
      return { total_today: 0, serve_count: 0, review_count: 0, block_count: 0, conversion_rate: 0, avg_score: 0 };
    }

    const row = result.records[0];
    const total = Number(row.get("total") ?? 0);
    const serveCount = Number(row.get("serve_count") ?? 0);
    const conversions = Number(row.get("conversions") ?? 0);

    return {
      total_today: total,
      serve_count: serveCount,
      review_count: Number(row.get("review_count") ?? 0),
      block_count: Number(row.get("block_count") ?? 0),
      serve_rate: total > 0 ? Number((serveCount / total * 100).toFixed(1)) : 0,
      conversion_rate: serveCount > 0 ? Number((conversions / serveCount * 100).toFixed(2)) : 0,
      avg_intent_score: Number((Number(row.get("avg_score") ?? 0)).toFixed(1)),
      estimated_revenue_usd: Number((serveCount * 0.003).toFixed(4)),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "intentgraph", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "score_prompt",
      description: "Run the full IntentGraph 6-step ad eligibility pipeline on a chat prompt. Returns verdict (SERVE/REVIEW/BLOCK), intent score 0–100, 4-dimension breakdown, Tavily brand safety signals, and similar past prompts from Neo4j memory.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The user chat prompt to score for ad eligibility" },
          session_id: { type: "string", description: "Publisher session ID (optional)", default: "mcp-session" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "check_brand_safety",
      description: "Check brand safety for a topic using Tavily live web search. Returns safe/unsafe status, risk flags, and confidence level.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Topic or product category to check for brand safety" },
        },
        required: ["topic"],
      },
    },
    {
      name: "get_publisher_stats",
      description: "Get today's aggregate publisher stats from Neo4j: total prompts scored, serve/review/block breakdown, conversion rate, and estimated revenue.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, string>;

  try {
    let result: unknown;

    if (name === "score_prompt") {
      if (!a.prompt) throw new Error("prompt is required");
      result = await toolScorePrompt(a.prompt, a.session_id ?? "mcp-session");
    } else if (name === "check_brand_safety") {
      if (!a.topic) throw new Error("topic is required");
      result = await toolCheckBrandSafety(a.topic);
    } else if (name === "get_publisher_stats") {
      result = await toolGetPublisherStats();
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[IntentGraph MCP] Running on stdio.");
  console.error(`[IntentGraph MCP] Pipeline API: ${INTENTGRAPH_API_URL}`);
  console.error("[IntentGraph MCP] Deploy to Alpic: alpic deploy ./mcp --name intentgraph");
}

main().catch(console.error);
