import { v4 as uuidv4 } from "uuid";

export interface PromptContextInput {
  id: string;
  prompt_text: string;
  topic_category: string;
  intent_score: number;
  verdict: "SERVE" | "REVIEW" | "BLOCK";
  session_id: string;
  ad_categories?: string[];
}

export interface SimilarContext {
  id: string;
  prompt_text: string;
  topic_category: string;
  intent_score: number;
  verdict: string;
  similarity_score: number;
  timestamp: string;
  conversion_count: number;
}

export interface PublisherStats {
  total_today: number;
  serve_count: number;
  review_count: number;
  block_count: number;
  conversion_rate: number;
  avg_intent_score: number;
}

// ── In-memory store (used when NEO4J_URI is absent) ───────────────────────────

const memStore: PromptContextInput & { timestamp: string }[] = [];

function memSimilar(category: string, excludeId: string, topK: number): SimilarContext[] {
  return memStore
    .filter((r) => r.topic_category === category && r.id !== excludeId)
    .slice(-topK)
    .reverse()
    .map((r) => ({
      id: r.id,
      prompt_text: r.prompt_text,
      topic_category: r.topic_category,
      intent_score: r.intent_score,
      verdict: r.verdict,
      similarity_score: 0.8,
      timestamp: (r as typeof r & { timestamp: string }).timestamp,
      conversion_count: 0,
    }));
}

function memStats(): PublisherStats {
  const today = memStore.filter((r) => {
    const ts = new Date((r as typeof r & { timestamp: string }).timestamp).getTime();
    return Date.now() - ts < 86_400_000;
  });
  const total = today.length;
  const serve = today.filter((r) => r.verdict === "SERVE").length;
  return {
    total_today: total,
    serve_count: serve,
    review_count: today.filter((r) => r.verdict === "REVIEW").length,
    block_count: today.filter((r) => r.verdict === "BLOCK").length,
    conversion_rate: 0,
    avg_intent_score: total ? Number((today.reduce((s, r) => s + r.intent_score, 0) / total).toFixed(1)) : 0,
  };
}

// ── Real Neo4j implementations ────────────────────────────────────────────────

async function getDriver() {
  const neo4j = (await import("neo4j-driver")).default;
  return neo4j.driver(
    process.env.NEO4J_URI!,
    neo4j.auth.basic(process.env.NEO4J_USER!, process.env.NEO4J_PASSWORD!)
  );
}

async function neo4jStore(data: PromptContextInput): Promise<void> {
  const driver = await getDriver();
  const session = driver.session();
  const neo4j = (await import("neo4j-driver")).default;
  const timestamp = new Date().toISOString();
  try {
    await session.run(
      `MERGE (pc:PromptContext {id: $id})
       SET pc.prompt_text = $prompt_text, pc.topic_category = $topic_category,
           pc.intent_score = $intent_score, pc.verdict = $verdict,
           pc.session_id = $session_id, pc.timestamp = $timestamp`,
      { ...data, timestamp }
    );
    await session.run(
      `MATCH (existing:PromptContext) WHERE existing.topic_category = $cat AND existing.id <> $id
       WITH existing ORDER BY existing.timestamp DESC LIMIT 5
       MATCH (cur:PromptContext {id: $id})
       MERGE (cur)-[:SIMILAR_TO {similarity_score: 0.8}]->(existing)`,
      { cat: data.topic_category, id: data.id }
    );
    if (data.verdict === "SERVE" && data.ad_categories?.length) {
      await session.run(
        `MATCH (pc:PromptContext {id: $cid})
         CREATE (ap:AdPlacement {id: $pid, prompt_context_id: $cid, ad_category: $cat, served_at: $ts})
         CREATE (pc)-[:LED_TO]->(ap)`,
        { cid: data.id, pid: uuidv4(), cat: data.ad_categories[0], ts: timestamp }
      );
    }
  } finally { await session.close(); await driver.close(); }
}

async function neo4jSimilar(category: string, excludeId: string, topK: number): Promise<SimilarContext[]> {
  const driver = await getDriver();
  const session = driver.session();
  const neo4j = (await import("neo4j-driver")).default;
  try {
    const result = await session.run(
      `MATCH (pc:PromptContext) WHERE pc.topic_category = $cat AND pc.id <> $excl
       OPTIONAL MATCH (pc)-[:LED_TO]->(ap:AdPlacement)-[:CONVERTED]->(cv:ConversionEvent)
       WITH pc, count(cv) AS conv ORDER BY pc.timestamp DESC LIMIT $topK
       RETURN pc.id AS id, pc.prompt_text AS pt, pc.topic_category AS cat,
              pc.intent_score AS score, pc.verdict AS verdict, pc.timestamp AS ts, conv`,
      { cat: category, excl: excludeId, topK: neo4j.int(topK) }
    );
    return result.records.map((r) => ({
      id: r.get("id") as string,
      prompt_text: r.get("pt") as string,
      topic_category: r.get("cat") as string,
      intent_score: r.get("score") as number,
      verdict: r.get("verdict") as string,
      similarity_score: 0.8,
      timestamp: r.get("ts") as string,
      conversion_count: (r.get("conv") as number) ?? 0,
    }));
  } finally { await session.close(); await driver.close(); }
}

async function neo4jStats(): Promise<PublisherStats> {
  const driver = await getDriver();
  const session = driver.session();
  const neo4j = (await import("neo4j-driver")).default;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  try {
    const r = await session.run(
      `MATCH (pc:PromptContext) WHERE pc.timestamp >= $ts
       WITH count(pc) AS total,
            sum(CASE WHEN pc.verdict='SERVE' THEN 1 ELSE 0 END) AS serve,
            sum(CASE WHEN pc.verdict='REVIEW' THEN 1 ELSE 0 END) AS review,
            sum(CASE WHEN pc.verdict='BLOCK' THEN 1 ELSE 0 END) AS block,
            avg(pc.intent_score) AS avg
       OPTIONAL MATCH (ap:AdPlacement)-[:CONVERTED]->(cv:ConversionEvent) WHERE ap.served_at >= $ts
       RETURN total, serve, review, block, avg, count(cv) AS conv`,
      { ts: todayStart.toISOString() }
    );
    if (!r.records.length) return { total_today: 0, serve_count: 0, review_count: 0, block_count: 0, conversion_rate: 0, avg_intent_score: 0 };
    const row = r.records[0];
    const total = Number(row.get("total") ?? 0);
    const serve = Number(row.get("serve") ?? 0);
    const conv = Number(row.get("conv") ?? 0);
    return {
      total_today: total,
      serve_count: serve,
      review_count: Number(row.get("review") ?? 0),
      block_count: Number(row.get("block") ?? 0),
      conversion_rate: serve > 0 ? Number((conv / serve).toFixed(3)) : 0,
      avg_intent_score: Number((Number(row.get("avg") ?? 0)).toFixed(1)),
    };
  } finally { await session.close(); await driver.close(); }
}

// ── Public API ────────────────────────────────────────────────────────────────

const useNeo4j = () => !!process.env.NEO4J_URI;

export async function storePromptContext(data: PromptContextInput): Promise<void> {
  if (!useNeo4j()) {
    memStore.push({ ...data, timestamp: new Date().toISOString() } as typeof data & { timestamp: string });
    return;
  }
  try { await neo4jStore(data); }
  catch (err) {
    console.warn("[Neo4j] storePromptContext failed, using memory:", err);
    memStore.push({ ...data, timestamp: new Date().toISOString() } as typeof data & { timestamp: string });
  }
}

export async function findSimilarContexts(
  topicCategory: string,
  excludeId = "",
  topK = 5
): Promise<SimilarContext[]> {
  if (!useNeo4j()) return memSimilar(topicCategory, excludeId, topK);
  try { return await neo4jSimilar(topicCategory, excludeId, topK); }
  catch (err) { console.warn("[Neo4j] findSimilarContexts failed:", err); return memSimilar(topicCategory, excludeId, topK); }
}

export async function logConversion(session_id: string, type: string): Promise<void> {
  if (!useNeo4j()) return;
  try {
    const driver = await getDriver();
    const session = driver.session();
    const ts = new Date().toISOString();
    try {
      await session.run(
        `CREATE (cv:ConversionEvent {id: $id, session_id: $sid, type: $type, timestamp: $ts})
         WITH cv MATCH (ap:AdPlacement)<-[:LED_TO]-(:PromptContext {session_id: $sid})
         ORDER BY ap.served_at DESC LIMIT 1 CREATE (ap)-[:CONVERTED]->(cv)`,
        { id: uuidv4(), sid: session_id, type, ts }
      );
    } finally { await session.close(); await driver.close(); }
  } catch (err) { console.warn("[Neo4j] logConversion failed:", err); }
}

export async function getPublisherStats(): Promise<PublisherStats> {
  if (!useNeo4j()) return memStats();
  try { return await neo4jStats(); }
  catch (err) { console.warn("[Neo4j] getPublisherStats failed:", err); return memStats(); }
}

export async function ensureConstraints(): Promise<void> {
  if (!useNeo4j()) return;
  try {
    const driver = await getDriver();
    const session = driver.session();
    try {
      await session.run("CREATE CONSTRAINT prompt_context_id IF NOT EXISTS FOR (p:PromptContext) REQUIRE p.id IS UNIQUE");
      await session.run("CREATE CONSTRAINT ad_placement_id IF NOT EXISTS FOR (a:AdPlacement) REQUIRE a.id IS UNIQUE");
    } finally { await session.close(); await driver.close(); }
  } catch (err) { console.warn("[Neo4j] ensureConstraints failed:", err); }
}
