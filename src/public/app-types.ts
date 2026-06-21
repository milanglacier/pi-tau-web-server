export type ModelRecord = {
  provider?: string;
  id?: string;
  name?: string;
  model?: string;
  label?: string;
  context?: string | number;
  contextWindow?: string | number;
  context_window?: string | number;
  maxOutput?: string | number;
  max_output?: string | number;
  maxOut?: string | number;
  thinking?: boolean | string;
  images?: boolean | string;
  [key: string]: unknown;
};

export type LiveSession = {
  id: string;
  cwd?: string;
  sessionFile?: string | null;
  sessionName?: string | null;
  modelSpec?: string;
  modelLabel?: string;
  model?: ModelRecord | string | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  createdAt?: string;
  lastActiveAt?: string;
  contextUsage?: UsageRecord;
};

export type LiveInstance = {
  sessionFile?: string | null;
  cwd?: string;
  port: string;
};

export type UsageRecord = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  [key: string]: unknown;
};

export type MessageContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  source?: { data?: string; media_type?: string };
  data?: string;
  media_type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

export type AppMessage = {
  id?: string;
  role?: string;
  content?: string | MessageContentBlock[];
  usage?: UsageRecord;
  images?: PendingImage[];
  toolCallId?: string;
  isError?: boolean;
};

export type AppEvent = {
  type?: string;
  sessionId?: string;
  session?: LiveSession;
  message?: AppMessage | string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  method?: string;
  id?: string;
  name?: string;
  error?: string;
  summary?: string;
  contextUsage?: UsageRecord;
  sessionFile?: string;
  [key: string]: unknown;
};

export type PendingImage = { data: string; mimeType: string };
export type PendingFilePath = { path: string; name: string; ext: string; sessionId?: string | null };
export type QueuedCommand = { type: string; message?: string; images?: PendingImage[]; sessionId?: string };
export type ExtensionUIRequest = { sessionId: string; event: AppEvent };
export type RpcCommand = { type: string; sessionId?: string; filePath?: string; [key: string]: unknown };
