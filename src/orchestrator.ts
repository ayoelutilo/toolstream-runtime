import { AsyncEventChannel } from "./event-channel.js";
import {
  DoneLifecycleEvent,
  ErrorLifecycleEvent,
  ExecuteOptions,
  ExecutionSummary,
  LifecycleEvent,
  OutputLifecycleEvent,
  OutputStreamItem,
  ProgressLifecycleEvent,
  SerializedError,
  StartLifecycleEvent,
  StreamExecutionHandle,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  ToolResultStatus,
} from "./types.js";

interface RuntimeOptions {
  defaultTimeoutMs?: number;
  now?: () => number;
}

type EventDraft =
  | Omit<StartLifecycleEvent, "sequence" | "timestamp">
  | Omit<ProgressLifecycleEvent, "sequence" | "timestamp">
  | Omit<ErrorLifecycleEvent, "sequence" | "timestamp">
  | Omit<OutputLifecycleEvent, "sequence" | "timestamp">
  | Omit<DoneLifecycleEvent, "sequence" | "timestamp">;

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function toToolDefinition(definition: ToolDefinition | ToolDefinition["handler"]): ToolDefinition {
  return typeof definition === "function" ? { handler: definition } : definition;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  let message = "Unknown error";
  if (typeof error === "string") {
    message = error;
  } else {
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
  }

  const name =
    error !== null &&
    typeof error === "object" &&
    "constructor" in error &&
    typeof (error as { constructor?: { name?: unknown } }).constructor?.name === "string"
      ? ((error as { constructor?: { name?: string } }).constructor?.name as string)
      : "Error";

  return {
    name,
    message,
  };
}

export class ToolstreamRuntime {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  constructor(registry: ToolRegistry, options: RuntimeOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5000;
    this.now = options.now ?? (() => Date.now());
    this.tools = new Map(
      Object.entries(registry).map(([name, definition]) => [name, toToolDefinition(definition)]),
    );
  }

  async execute(calls: ToolCall[], options: ExecuteOptions = {}): Promise<ExecutionSummary> {
    return this.executeInternal(calls, options);
  }

  executeStream(calls: ToolCall[], options: ExecuteOptions = {}): StreamExecutionHandle {
    const channel = new AsyncEventChannel<LifecycleEvent>();

    const completed = this.executeInternal(calls, {
      onEvent: (event) => {
        channel.push(event);
        if (options.onEvent) {
          try {
            options.onEvent(event);
          } catch {
            // Ignore listener exceptions so consumer hooks cannot crash runtime execution.
          }
        }
      },
    }).finally(() => {
      channel.close();
    });

    return {
      events: channel.values(),
      completed,
    };
  }

  private async executeInternal(calls: ToolCall[], options: ExecuteOptions): Promise<ExecutionSummary> {
    const events: LifecycleEvent[] = [];
    const outputStream: OutputStreamItem[] = [];
    let sequence = 1;

    const emit = (draft: EventDraft): LifecycleEvent => {
      const event = {
        ...draft,
        sequence,
        timestamp: this.now(),
      } as LifecycleEvent;

      sequence += 1;
      events.push(event);
      if (options.onEvent) {
        try {
          options.onEvent(event);
        } catch {
          // Ignore listener exceptions so consumer hooks cannot crash runtime execution.
        }
      }

      if (event.type === "output") {
        outputStream.push({
          sequence: event.sequence,
          timestamp: event.timestamp,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          chunk: event.chunk,
        });
      }

      return event;
    };

    const results = await Promise.all(calls.map((call) => this.executeToolCall(call, emit)));

    return {
      results,
      events,
      outputStream,
    };
  }

  private async executeToolCall(
    call: ToolCall,
    emit: (draft: EventDraft) => LifecycleEvent,
  ): Promise<ToolExecutionResult> {
    const startedAt = this.now();
    const definition = this.tools.get(call.tool);
    const timeoutMs = this.resolveTimeoutMs(call, definition);

    emit({
      type: "start",
      toolCallId: call.id,
      toolName: call.tool,
      timeoutMs,
    });

    if (!definition) {
      const missingToolError = {
        name: "MissingToolError",
        message: `No tool registered under \"${call.tool}\"`,
      };

      emit({
        type: "error",
        toolCallId: call.id,
        toolName: call.tool,
        error: missingToolError,
        timedOut: false,
      });

      return this.finishResult({
        call,
        startedAt,
        timedOut: false,
        emit,
        status: "error",
        error: missingToolError,
      });
    }

    const controller = new AbortController();
    const deadline = startedAt + timeoutMs;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    const context: ToolExecutionContext = {
      toolCallId: call.id,
      toolName: call.tool,
      signal: controller.signal,
      timeoutMs,
      startedAt,
      deadline,
      timeRemainingMs: () => Math.max(0, deadline - this.now()),
      progress: (message, data) => {
        if (settled) {
          return;
        }

        emit({
          type: "progress",
          toolCallId: call.id,
          toolName: call.tool,
          message,
          data,
        });
      },
      output: (chunk) => {
        if (settled) {
          return;
        }

        emit({
          type: "output",
          toolCallId: call.id,
          toolName: call.tool,
          chunk,
        });
      },
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new TimeoutError(`Tool \"${call.tool}\" exceeded ${timeoutMs}ms timeout`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([Promise.resolve(definition.handler(call.input, context)), timeoutPromise]);
      settled = true;

      return this.finishResult({
        call,
        startedAt,
        timedOut: false,
        emit,
        status: "success",
        result,
      });
    } catch (error) {
      const serializedError = serializeError(error);

      emit({
        type: "error",
        toolCallId: call.id,
        toolName: call.tool,
        error: serializedError,
        timedOut,
      });

      if (timedOut && call.timeoutFallback !== undefined) {
        settled = true;
        try {
          const fallbackValue =
            typeof call.timeoutFallback === "function"
              ? await call.timeoutFallback({
                  toolCallId: call.id,
                  toolName: call.tool,
                  timeoutMs,
                  elapsedMs: this.now() - startedAt,
                  error: serializedError,
                })
              : call.timeoutFallback;

          emit({
            type: "output",
            toolCallId: call.id,
            toolName: call.tool,
            chunk: fallbackValue,
          });

          return this.finishResult({
            call,
            startedAt,
            timedOut: true,
            emit,
            status: "fallback",
            result: fallbackValue,
          });
        } catch (fallbackError) {
          const fallbackSerializedError = serializeError(fallbackError);
          emit({
            type: "error",
            toolCallId: call.id,
            toolName: call.tool,
            error: fallbackSerializedError,
            timedOut: true,
          });

          return this.finishResult({
            call,
            startedAt,
            timedOut: true,
            emit,
            status: "error",
            error: fallbackSerializedError,
          });
        }
      }

      settled = true;

      return this.finishResult({
        call,
        startedAt,
        timedOut,
        emit,
        status: "error",
        error: serializedError,
      });
    } finally {
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private finishResult(input: {
    call: ToolCall;
    startedAt: number;
    timedOut: boolean;
    emit: (draft: EventDraft) => LifecycleEvent;
    status: ToolResultStatus;
    result?: unknown;
    error?: SerializedError;
  }): ToolExecutionResult {
    const finishedAt = this.now();

    input.emit({
      type: "done",
      toolCallId: input.call.id,
      toolName: input.call.tool,
      status: input.status,
      durationMs: Math.max(0, finishedAt - input.startedAt),
      timedOut: input.timedOut,
      result: input.result,
    });

    return {
      id: input.call.id,
      tool: input.call.tool,
      status: input.status,
      startedAt: input.startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - input.startedAt),
      timedOut: input.timedOut,
      result: input.result,
      error: input.error,
    };
  }

  private resolveTimeoutMs(call: ToolCall, definition?: ToolDefinition): number {
    const resolved = call.timeoutMs ?? definition?.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(resolved) || resolved <= 0) {
      return this.defaultTimeoutMs;
    }
    return resolved;
  }
}

// Refinement.

// Refinement.
