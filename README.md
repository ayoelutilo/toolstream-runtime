# toolstream-runtime

`toolstream-runtime` orchestrates parallel tool execution with strict lifecycle events, timeout budgets, and merged ordered output.

## Features

- Tool lifecycle events: `start`, `progress`, `output`, `error`, `done`
- Per-tool timeout budgets (defaults plus per-call overrides)
- Timeout fallback values or fallback functions
- Parallel execution across multiple tool calls
- Ordered merged output stream with global sequence IDs
- Async streaming API for live event consumption

## Install

```bash
npm install toolstream-runtime
```

## Usage

```ts
import { ToolstreamRuntime } from "toolstream-runtime";

const runtime = new ToolstreamRuntime(
  {
    search: async (input, ctx) => {
      ctx.progress("querying", { query: input });
      ctx.output({ source: "cache", hit: false });
      return { hits: ["doc-1", "doc-2"] };
    },
    summarize: async (input, ctx) => {
      ctx.progress("summarizing");
      return { summary: String(input).slice(0, 120) };
    },
  },
  { defaultTimeoutMs: 2500 },
);

const summary = await runtime.execute([
  { id: "c1", tool: "search", input: "runner protocol" },
  {
    id: "c2",
    tool: "summarize",
    input: "long text",
    timeoutMs: 300,
    timeoutFallback: { summary: "fallback summary" },
  },
]);

const safeResults = summary.results.map(({ id, tool, status, timedOut }) => ({
  id,
  tool,
  status,
  timedOut,
}));
console.log(safeResults);
console.log({ outputChunks: summary.outputStream.length });

const streamHandle = runtime.executeStream([{ id: "c3", tool: "search", input: "toolstream" }]);
for await (const event of streamHandle.events) {
  console.log(event.sequence, event.type, event.toolCallId);
}

await streamHandle.completed;
```

## Development

```bash
npm install
npm test
npm run build
```

## Architecture

See `docs/adr/0001-architecture.md`.

- Changelog: minor updates.

- Changelog: minor updates.

- Changelog: minor updates.
