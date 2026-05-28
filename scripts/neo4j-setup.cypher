// Run these in Neo4j Browser or Cypher Shell to initialize the schema

// Constraints
CREATE CONSTRAINT prompt_id IF NOT EXISTS
  FOR (p:Prompt) REQUIRE p.id IS UNIQUE;

// Indexes for fast lookups
CREATE INDEX intent_category_idx IF NOT EXISTS
  FOR (i:IntentScore) ON (i.category);

CREATE INDEX verdict_decision_idx IF NOT EXISTS
  FOR (v:Verdict) ON (v.decision);

// Seed example data for demo (optional)
MERGE (p1:Prompt {id: "demo-001"})
SET p1.text = "Best wireless headphones under $200 for gym",
    p1.sessionId = "demo",
    p1.timestamp = datetime()

MERGE (i1:IntentScore {promptId: "demo-001"})
SET i1.score = 0.82, i1.category = "purchase_ready",
    i1.signals = ["under $200", "best", "buy intent"],
    i1.adTopics = ["Consumer Electronics", "Sports"]

MERGE (s1:BrandSafetyCheck {promptId: "demo-001"})
SET s1.safe = true, s1.flags = []

MERGE (v1:Verdict {promptId: "demo-001"})
SET v1.decision = "serve", v1.bidPriceCpm = 1.23, v1.confidence = 0.95

MERGE (p1)-[:HAS_INTENT]->(i1)
MERGE (i1)-[:HAS_SAFETY_CHECK]->(s1)
MERGE (s1)-[:LED_TO_VERDICT]->(v1);
