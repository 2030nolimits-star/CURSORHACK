export type IntentCategory =
  | "purchase_ready"
  | "comparison"
  | "research"
  | "general_chat"
  | "off_topic";

export type Decision = "serve" | "block" | "review";

export interface IntentResult {
  score: number;
  category: IntentCategory;
  signals: string[];
  adTopics: string[];
}

export interface BrandSafetyResult {
  safe: boolean;
  flags: string[];
  tavilyContext: { title: string; url: string; snippet: string }[];
  topicSummary: string;
}

export interface GraphMemoryResult {
  promptNodeId: string;
  intentNodeId: string;
  safetyNodeId: string;
  verdictNodeId: string;
}

export interface VerdictResult {
  decision: Decision;
  reason: string;
  adCategories: string[];
  bidPriceCpm: number;
  confidence: number;
}

export interface PipelineRun {
  runId: string;
  sessionId: string;
  prompt: string;
  timestamp: string;
  steps: {
    scoreIntent?: StepTrace<IntentResult>;
    checkBrandSafety?: StepTrace<BrandSafetyResult>;
    graphMemory?: StepTrace<GraphMemoryResult>;
    verdict?: StepTrace<VerdictResult>;
  };
  final?: VerdictResult;
  durationMs?: number;
}

export interface StepTrace<T> {
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  output?: T;
  error?: string;
}

export interface DashboardStats {
  totalRequests: number;
  serveCount: number;
  blockCount: number;
  reviewCount: number;
  avgIntentScore: number;
  totalRevenueCpm: number;
  serveRate: number;
  intentDistribution: { category: IntentCategory; count: number }[];
}

export interface ReviewQueueItem {
  id: string;
  promptId: string;
  promptText: string;
  intentScore: number;
  intentCategory: IntentCategory;
  brandFlags: string[];
  reason: string;
  createdAt: string;
}
