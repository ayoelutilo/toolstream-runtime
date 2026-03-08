import { describe, expect, it } from "vitest";

import { LifecycleEvent, ToolstreamRuntime } from "../src/index.js";

const delay = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

describe("toolstream-runtime", () => {
  it("emits lifecycle events in order for a single tool run", async () => {
    const runtime = new ToolstreamRuntime({
      echo: async (input, context) => {
        context.progress("started");
        context.output({ received: input });
        return { ok: true };
      },
    });

    const summary = await runtime.execute([{ id: "call-1", tool: "echo", input: "payload" }]);

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]?.status).toBe("success");
    expect(summary.events.map((event) => event.type)).toEqual(["start", "progress", "output", "done"]);

    const sequence = summary.events.map((event) => event.sequence);
    expect(sequence).toEqual([1, 2, 3, 4]);
  });

  it("runs multiple tools in parallel and merges output in sequence order", async () => {
    const runtime = new ToolstreamRuntime({
      slow: async (_input, context) => {
        await delay(20);
        context.output("slow-1");
        await delay(10);
        context.output("slow-2");
        return "slow-done";
      },
      fast: async (_input, context) => {
        await delay(5);
        context.output("fast-1");
        return "fast-done";
      },
    });

    const summary = await runtime.execute([
      { id: "call-slow", tool: "slow" },
      { id: "call-fast", tool: "fast" },
    ]);

    expect(summary.results).toHaveLength(2);
    expect(summary.results.map((result) => result.status)).toEqual(["success", "success"]);

    const outputValues = summary.outputStream.map((item) => item.chunk);
    expect(outputValues).toEqual(["fast-1", "slow-1", "slow-2"]);

    const sequences = summary.events.map((event) => event.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
  });

  it("applies timeout fallback when a tool exceeds budget", async () => {
    const runtime = new ToolstreamRuntime({
      sleepy: async () => {
        await delay(50);
        return "late";
      },
    });

    const summary = await runtime.execute([
      {
        id: "call-timeout",
        tool: "sleepy",
        timeoutMs: 10,
        timeoutFallback: ({ toolCallId, error }) => ({ toolCallId, reason: error.name }),
      },
    ]);

    const result = summary.results[0];
    expect(result?.status).toBe("fallback");
    expect(result?.timedOut).toBe(true);
    expect(result?.result).toMatchObject({ toolCallId: "call-timeout", reason: "TimeoutError" });

    const eventTypes = summary.events.map((event) => event.type);
    expect(eventTypes).toEqual(["start", "error", "output", "done"]);

    const doneEvent = summary.events.at(-1);
    expect(doneEvent).toMatchObject({ type: "done", status: "fallback", timedOut: true });
  });

  it("returns error result when timeout has no fallback", async () => {
    const runtime = new ToolstreamRuntime({
      stall: async () => {
        await delay(30);
        return "never";
      },
    });

    const summary = await runtime.execute([{ id: "call-error", tool: "stall", timeoutMs: 5 }]);

    const result = summary.results[0];
    expect(result?.status).toBe("error");
    expect(result?.timedOut).toBe(true);
    expect(result?.error?.name).toBe("TimeoutError");

    expect(summary.events.map((event) => event.type)).toEqual(["start", "error", "done"]);
  });

  it("supports async event streaming with ordered merged output", async () => {
    const runtime = new ToolstreamRuntime({
      one: async (_input, context) => {
        context.progress("booting");
        await delay(5);
        context.output("out-1");
        return "done-1";
      },
      two: async (_input, context) => {
        await delay(1);
        context.output("out-2");
        return "done-2";
      },
    });

    const handle = runtime.executeStream([
      { id: "stream-1", tool: "one" },
      { id: "stream-2", tool: "two" },
    ]);

    const streamedEvents: LifecycleEvent[] = [];
    for await (const event of handle.events) {
      streamedEvents.push(event);
    }

    const summary = await handle.completed;

    expect(streamedEvents).toEqual(summary.events);
    expect(summary.outputStream.map((item) => item.chunk)).toEqual(["out-2", "out-1"]);
  });

  it("returns error result when timeout fallback throws", async () => {
    const runtime = new ToolstreamRuntime({
      sleepy: async () => {
        await delay(50);
        return "late";
      },
    });

    const summary = await runtime.execute([
      {
        id: "call-timeout-fallback-throws",
        tool: "sleepy",
        timeoutMs: 10,
        timeoutFallback: async () => {
          throw new Error("fallback broke");
        },
      },
    ]);

    const result = summary.results[0];
    expect(result?.status).toBe("error");
    expect(result?.timedOut).toBe(true);
    expect(result?.error?.message).toContain("fallback broke");
  });

  it("serializes non-Error thrown values without rejecting execution", async () => {
    const runtime = new ToolstreamRuntime({
      boom: async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        throw circular;
      },
    });

    const summary = await runtime.execute([{ id: "call-circular", tool: "boom" }]);

    const result = summary.results[0];
    expect(result?.status).toBe("error");
    expect(result?.error?.message.length).toBeGreaterThan(0);
    expect(summary.events.map((event) => event.type)).toEqual(["start", "error", "done"]);
  });

  it("prevents timed-out handlers from emitting late output during fallback wait", async () => {
    const runtime = new ToolstreamRuntime({
      slowEmitter: async (_input, context) => {
        await delay(20);
        context.output("late-output");
        return "late";
      },
    });

    const summary = await runtime.execute([
      {
        id: "call-slow-emitter",
        tool: "slowEmitter",
        timeoutMs: 5,
        timeoutFallback: async () => {
          await delay(60);
          return "fallback-output";
        },
      },
    ]);

    expect(summary.outputStream.map((item) => item.chunk)).toEqual(["fallback-output"]);
  });

  it("isolates consumer event hook exceptions", async () => {
    const runtime = new ToolstreamRuntime({
      echo: async () => "ok",
    });

    const summary = await runtime.execute([{ id: "call-hook", tool: "echo" }], {
      onEvent: () => {
        throw new Error("listener crash");
      },
    });

    expect(summary.results[0]?.status).toBe("success");
  });
});
