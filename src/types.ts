export type LifecycleEventType = "start" | "progress" | "output" | "error" | "done";

export interface LifecycleEventBase {
  sequence: number;
  timestamp: number;
  toolCallId: string;
  toolName: string;
}

export interface StartLifecycleEvent extends LifecycleEventBase {
  type: "start";
  timeoutMs: number;
}

export interface ProgressLifecycleEvent extends LifecycleEventBase {
  type: "progress";
  message: string;
  data?: unknown;
}

export interface OutputLifecycleEvent extends LifecycleEventBase {
  type: "output";
  chunk: unknown;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export interface ErrorLifecycleEvent extends LifecycleEventBase {
  type: "error";
  error: SerializedError;
  timedOut: boolean;
}

export type ToolResultStatus = "success" | "error" | "fallback";

export interface DoneLifecycleEvent extends LifecycleEventBase {
  type: "done";
  status: ToolResultStatus;
  durationMs: number;
  timedOut: boolean;
  result?: unknown;
}

export type LifecycleEvent =
  | StartLifecycleEvent
  | ProgressLifecycleEvent
  | OutputLifecycleEvent
  | ErrorLifecycleEvent
  | DoneLifecycleEvent;

export interface OutputStreamItem {
  sequence: number;
  timestamp: number;
  toolCallId: string;
  toolName: string;
  chunk: unknown;
}

export interface TimeoutFallbackContext {
  toolCallId: string;
  toolName: string;
  timeoutMs: number;
  elapsedMs: number;
  error: SerializedError;
}

export type TimeoutFallback =
  | unknown
  | ((context: TimeoutFallbackContext) => unknown | Promise<unknown>);

export interface ToolCall {
  id: string;
  tool: string;
  input?: unknown;
  timeoutMs?: number;
  timeoutFallback?: TimeoutFallback;
}

export interface ToolExecutionContext {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly startedAt: number;
  readonly deadline: number;
  timeRemainingMs(): number;
  progress(message: string, data?: unknown): void;
  output(chunk: unknown): void;
}

export type ToolHandler<Input = unknown, Output = unknown> = (
  input: Input,
  context: ToolExecutionContext,
) => Promise<Output> | Output;

export interface ToolDefinition {
  handler: ToolHandler;
  timeoutMs?: number;
}

export type ToolRegistry = Record<string, ToolDefinition | ToolHandler>;

export interface ToolExecutionResult {
  id: string;
  tool: string;
  status: ToolResultStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  timedOut: boolean;
  result?: unknown;
  error?: SerializedError;
}

export interface ExecutionSummary {
  results: ToolExecutionResult[];
  events: LifecycleEvent[];
  outputStream: OutputStreamItem[];
}

export interface ExecuteOptions {
  onEvent?: (event: LifecycleEvent) => void;
}

export interface StreamExecutionHandle {
  events: AsyncIterable<LifecycleEvent>;
  completed: Promise<ExecutionSummary>;
}
