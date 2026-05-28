-- Run this in the Supabase SQL editor

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS events (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  prompt_id        TEXT NOT NULL,
  session_id       TEXT,
  prompt_text      TEXT NOT NULL,
  intent_score     DECIMAL(4,3) NOT NULL,
  intent_category  TEXT NOT NULL,
  brand_safe       BOOLEAN NOT NULL DEFAULT true,
  brand_flags      TEXT[] DEFAULT '{}',
  decision         TEXT NOT NULL CHECK (decision IN ('serve', 'block', 'review')),
  ad_categories    TEXT[] DEFAULT '{}',
  bid_price_cpm    DECIMAL(8,4) DEFAULT 0,
  reasoning        TEXT,
  overmind_run_id  TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_decision_idx   ON events (decision);
CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS events_session_idx    ON events (session_id);

-- Row-level security: allow anon reads for dashboard, service role for writes
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read" ON events
  FOR SELECT TO anon USING (true);

CREATE POLICY "service_write" ON events
  FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "service_update" ON events
  FOR UPDATE TO service_role USING (true);
