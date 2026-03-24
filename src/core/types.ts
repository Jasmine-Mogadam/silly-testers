// ─── Enums ────────────────────────────────────────────────────────────────────

export enum Team {
  QA = 'qa',
  RED = 'red',
  DEVOPS = 'devops',
}

export enum Severity {
  Critical = 'Critical',
  High = 'High',
  Medium = 'Medium',
  Low = 'Low',
  Info = 'Info',
}

export enum ReportType {
  Bug = 'BUG',
  Security = 'SECURITY',
  UX = 'UX',
  DevOps = 'DEVOPS',
}

export enum AgentStatus {
  Idle = 'idle',
  Running = 'running',
  Paused = 'paused',
  Stopped = 'stopped',
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface WebConfig {
  enabled: boolean;
  port: number;
}

export interface Config {
  target: TargetConfig;
  ollama: OllamaConfig;
  agents: AgentCountConfig;
  browser: BrowserConfig;
  reports: ReportConfig;
  runner: RunnerConfig;
  web: WebConfig;
}

export interface TargetConfig {
  /** Absolute path to the repository being tested */
  repo: string;
  /** Path to the feature list markdown file */
  featureList: string;
}

/** Discovered at runtime by the DevOps agent — not stored in config.yaml */
export interface DiscoveredTarget {
  startCommand: string;
  url: string;
}

export interface OllamaConfig {
  endpoint: string;
  textModel: string;
  visionModel: string;
  timeoutMs: number;
  maxConcurrentRequests?: number;
}

export interface AgentCountConfig {
  qa: {
    featureTesters: number;
    playTesters: number;
  };
  redTeam: {
    recon: number;
    exploit: number;
  };
}

export interface BrowserConfig {
  headless: boolean;
  timeoutMs: number;
  /** Extra args passed to Playwright launch — used for sandboxing */
  extraArgs?: string[];
}

export interface ReportConfig {
  outputDir: string;
}

export interface RunnerConfig {
  /** How often (ms) play testers get a new goal */
  playTesterGoalIntervalMs: number;
  /** Total run duration in ms; 0 = unlimited */
  maxRunDurationMs: number;
  /** How long to wait for the server to start on each attempt (ms) */
  serverStartTimeoutMs: number;
  /** How many times the DevOps agent will attempt to fix a failing startup before giving up */
  startupRetries: number;
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

export interface HealthCheck {
  url: string;
  label: string;
}

export interface WatchdogConfig {
  startCommand: string;
  healthChecks: HealthCheck[];
  healthCheckIntervalMs: number;
  restartCommand: string;
  maxRestartAttempts: number;
  workingDirectory: string;
}

export interface HealthStatus {
  healthy: boolean;
  checks: Array<{ label: string; url: string; up: boolean; error?: string }>;
}

// ─── Site Map ─────────────────────────────────────────────────────────────────

export interface Route {
  path: string;
  method?: string;
  description?: string;
  access?: 'public' | 'auth-only' | 'unknown';
}

export interface SiteMap {
  allowedOrigins: string[];
  routes: Route[];
  entryUrl: string;
  qaGuidance?: string;
}

// ─── Messaging ────────────────────────────────────────────────────────────────

export interface ChannelMessage {
  id: string;
  from: string;
  content: string;
  timestamp: number;
  tags?: string[];
  /** Base64-encoded PNG screenshot (no data: URI prefix) */
  image?: string;
  threadId?: string;
  replyTo?: string;
  finding?: Finding;
  review?: FindingReviewState;
}

export type FindingReviewStatus = 'draft' | 'needs_revision' | 'approved' | 'filed';

export interface FindingReviewState {
  findingId: string;
  status: FindingReviewStatus;
  reviewerId?: string;
  feedback?: string;
}

export enum SystemEvent {
  SiteDown = 'SITE_DOWN',
  SiteUp = 'SITE_UP',
  GiveUp = 'GIVE_UP',
}

export interface SystemMessage {
  event: SystemEvent;
  detail?: string;
  healthStatus?: HealthStatus;
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  type: string;
  description: string;
  assignee?: string;
  context?: Record<string, unknown>;
}

export interface TaskResult {
  taskId: string;
  agentId: string;
  success: boolean;
  summary: string;
  findings: Finding[];
}

// ─── Reports ──────────────────────────────────────────────────────────────────

export interface CodeRef {
  /** Relative path within the target repo */
  file: string;
  line?: number;
  snippet?: string;
}

export interface Finding {
  title: string;
  type: ReportType;
  severity: Severity;
  team: Team;
  url: string;
  summary: string;
  steps: string[];
  evidence?: string;
  codeRefs: CodeRef[];
  suggestedFix?: string;
}

// ─── LLM ──────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaRequest {
  model: string;
  prompt?: string;
  messages?: LLMMessage[];
  images?: string[];
  stream: boolean;
  options?: Record<string, unknown>;
}

export interface OllamaResponse {
  response: string;
  done: boolean;
}
