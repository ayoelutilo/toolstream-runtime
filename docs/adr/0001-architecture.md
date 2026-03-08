# ADR 0001: Event-Driven Tool Orchestration with Sequence-Ordered Output

- Status: Accepted
- Date: 2024-06-15

## Context

Runtime consumers need to execute many tools concurrently while keeping deterministic event ordering, bounded execution time, and clear observability for each tool call.

## Decision

`toolstream-runtime` uses an event-driven orchestrator with:

- Parallel execution of tool calls via `Promise.all`
- Per-call timeout budgets resolved from call override, tool defaults, then runtime default
- Lifecycle event emission for `start`, `progress`, `output`, `error`, and `done`
- A single monotonic sequence counter so merged events and output are globally ordered
- Optional fallback behavior when timeout occurs
- Two execution interfaces:
  - `execute`: returns full summary after completion
  - `executeStream`: provides async iteration of live events plus completion promise

## Consequences

### Positive

- Event order is deterministic and mergeable across tools.
- Timeouts are explicit and recoverable via fallback policy.
- Consumers can choose batch or streaming integration style.

### Negative

- Tool handlers must be written to cooperate with cancellation (`AbortSignal`) to avoid wasted post-timeout work.
- Fallback semantics add one more terminal state (`fallback`) that downstream consumers must handle.

## Alternatives Considered

- Sequential-only execution: rejected because throughput and latency goals require parallelism.
- Per-tool independent event streams: rejected because downstream consumers still needed merged ordering.

- Changelog: minor updates.

- Changelog: minor updates.

- Changelog: minor updates.
