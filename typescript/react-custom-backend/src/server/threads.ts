/**
 * Thread state helpers backed by the graph checkpointer.
 *
 * Port of the Python example's `app/threads.py`. Implements the LangGraph SDK
 * thread state wire-shape consumed by `client.threads.getState` / `updateState`
 * (`GET|POST /threads/:id/state`) and `getHistory` (`POST /threads/:id/history`),
 * aligned with the Agent Protocol thread model.
 */

import type { CompiledGraphType } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";

import { isRecord, sanitizeForJson } from "./serialize.js";

/**
 * Compiled LangGraph instance exposed through the custom protocol server.
 *
 * Thread routes read and write checkpointed state through this graph's
 * checkpointer rather than maintaining a separate thread store.
 */
export type LocalProtocolGraph = CompiledGraphType;

type StateSnapshot = Awaited<ReturnType<LocalProtocolGraph["getState"]>>;

/**
 * Raised when a thread has no checkpoint yet.
 *
 * {@link CustomServer} maps this to HTTP 404 so the LangGraph SDK can
 * bootstrap the thread via `POST /threads/:id/state` before the first run.
 */
export class ThreadNotFoundError extends Error {
  readonly threadId: string;

  /**
   * @param threadId - Thread id that has not been checkpointed yet.
   */
  constructor(threadId: string) {
    super(`Thread ${threadId} not found`);
    this.name = "ThreadNotFoundError";
    this.threadId = threadId;
  }
}

/**
 * Graph node used when bootstrapping an empty thread.
 *
 * Empty `messages` updates must land on `__start__` so conditional edges are
 * not evaluated before the first human turn exists.
 */
const INITIAL_UPDATE_NODE = "__start__";

/**
 * Default graph node for non-empty state updates on an existing checkpoint.
 *
 * Matches `createAgent`'s model node when the client omits `as_node`.
 */
const DEFAULT_UPDATE_NODE = "model_request";

/**
 * Build the {@link RunnableConfig} that scopes graph calls to a thread id.
 *
 * @param threadId - Stable conversation id from the Agent Protocol layer.
 * @returns Config whose `configurable.thread_id` selects the checkpointer row.
 */
function threadConfig(threadId: string): RunnableConfig {
  return { configurable: { thread_id: threadId } };
}

/**
 * Read the `configurable` bag from a LangGraph run config.
 *
 * @param config - Runnable config returned by `getState` / passed to updates.
 * @returns Plain object (empty when `configurable` is missing or not a record).
 */
function configurableOf(config: RunnableConfig): Record<string, unknown> {
  return isRecord(config.configurable) ? config.configurable : {};
}

/**
 * Return whether a {@link StateSnapshot} represents a persisted checkpoint.
 *
 * LangGraph returns an empty configurable bag before the first write; the SDK
 * treats that as "thread not found" rather than an empty thread state.
 *
 * @param snapshot - Snapshot from `graph.getState`.
 * @returns `true` when `checkpoint_id` is a non-empty string.
 */
function threadHasCheckpoint(snapshot: StateSnapshot): boolean {
  const checkpointId = configurableOf(snapshot.config).checkpoint_id;
  return typeof checkpointId === "string" && checkpointId.length > 0;
}

/**
 * Serialize a LangGraph {@link StateSnapshot} to the SDK `ThreadState` shape.
 *
 * Converts LangChain message instances in `values` to plain JSON, normalizes
 * pending `tasks`, and fills the `checkpoint` envelope expected by
 * `client.threads.getState` consumers.
 *
 * @param snapshot - Raw snapshot from `graph.getState` or `getStateHistory`.
 * @param threadId - Thread id echoed in the response `checkpoint.thread_id`.
 * @returns JSON-serializable thread state for HTTP responses.
 */
export function serializeThreadState(
  snapshot: StateSnapshot,
  threadId: string
): Record<string, unknown> {
  const configurable = configurableOf(snapshot.config);
  const checkpointId =
    typeof configurable.checkpoint_id === "string"
      ? configurable.checkpoint_id
      : null;
  const checkpointNs =
    typeof configurable.checkpoint_ns === "string"
      ? configurable.checkpoint_ns
      : "";

  const tasks = (snapshot.tasks ?? []).map((task) => {
    const record = task as {
      id?: unknown;
      name?: unknown;
      error?: unknown;
      interrupts?: unknown;
      state?: unknown;
    };
    return {
      id: record.id,
      name: record.name,
      error: record.error ?? null,
      interrupts: Array.isArray(record.interrupts) ? record.interrupts : [],
      state: record.state ?? null,
    };
  });

  return {
    values: sanitizeForJson(snapshot.values ?? {}),
    next: [...(snapshot.next ?? [])],
    tasks,
    checkpoint: {
      thread_id: threadId,
      checkpoint_id: checkpointId,
      checkpoint_ns: checkpointNs,
    },
    metadata: { ...snapshot.metadata },
    created_at: snapshot.createdAt ?? null,
    parent_checkpoint: null,
  };
}

/**
 * Read checkpointed thread state for `GET /threads/:threadId/state`.
 *
 * @param graph - Compiled agent graph with an attached checkpointer.
 * @param threadId - Thread id from the URL path.
 * @returns Serialized thread state in SDK wire format.
 * @throws {@link ThreadNotFoundError} When the thread has no checkpoint yet.
 */
export async function getThreadState(
  graph: LocalProtocolGraph,
  threadId: string
): Promise<Record<string, unknown>> {
  const snapshot = await graph.getState(threadConfig(threadId));
  if (!threadHasCheckpoint(snapshot)) throw new ThreadNotFoundError(threadId);
  return serializeThreadState(snapshot, threadId);
}

/**
 * Parse the `before` pagination cursor accepted by `POST /threads/:id/history`.
 *
 * The SDK may send either a checkpoint id string or a partial checkpoint
 * object from a prior `ThreadState.checkpoint` field.
 *
 * @param threadId - Thread id to scope the history query.
 * @param before - Opaque cursor from the request body (or `undefined`).
 * @returns Runnable config for `getStateHistory`, or `undefined` to start at head.
 */
function parseBeforeCursor(
  threadId: string,
  before: unknown
): RunnableConfig | undefined {
  if (before == null) return undefined;
  if (typeof before === "string") {
    return { configurable: { thread_id: threadId, checkpoint_id: before } };
  }
  if (!isRecord(before)) return undefined;

  const configurable = isRecord(before.configurable) ? before.configurable : before;
  const checkpointId = configurable.checkpoint_id;
  if (typeof checkpointId !== "string") return undefined;

  const cursor: RunnableConfig = {
    configurable: { thread_id: threadId, checkpoint_id: checkpointId },
  };
  if (typeof configurable.checkpoint_ns === "string") {
    (cursor.configurable as Record<string, unknown>).checkpoint_ns =
      configurable.checkpoint_ns;
  }
  return cursor;
}

/**
 * List past thread states for `POST /threads/:threadId/history`.
 *
 * Verifies the thread exists (404 when missing) before walking
 * `graph.getStateHistory`, matching {@link getThreadState} behavior.
 *
 * @param graph - Compiled agent graph with an attached checkpointer.
 * @param threadId - Thread id from the URL path.
 * @param options.limit - Maximum snapshots to return (default `10`).
 * @param options.before - Checkpoint cursor; omit to read from the latest state.
 * @returns Newest-first list of serialized thread states.
 * @throws {@link ThreadNotFoundError} When the thread has no checkpoint yet.
 */
export async function getThreadHistory(
  graph: LocalProtocolGraph,
  threadId: string,
  options: { limit?: number; before?: unknown } = {}
): Promise<Record<string, unknown>[]> {
  await getThreadState(graph, threadId);

  const history: Record<string, unknown>[] = [];
  const iterator = graph.getStateHistory(threadConfig(threadId), {
    before: parseBeforeCursor(threadId, options.before),
    limit: options.limit ?? 10,
  });
  for await (const snapshot of iterator) {
    history.push(serializeThreadState(snapshot, threadId));
  }
  return history;
}

/**
 * Choose which graph node should receive a `updateState` write.
 *
 * @param options.asNode - Explicit node from the client (`as_node` body field).
 * @param options.values - State payload; empty `messages` triggers bootstrap path.
 * @param options.hasCheckpoint - Whether the thread already has a checkpoint row.
 * @returns Node name passed to `graph.updateState` as the update attribution target.
 */
function resolveUpdateNode(options: {
  asNode?: string;
  values: Record<string, unknown> | null;
  hasCheckpoint: boolean;
}): string {
  if (options.asNode) return options.asNode;
  const messages = options.values?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return INITIAL_UPDATE_NODE;
  }
  if (!options.hasCheckpoint) return INITIAL_UPDATE_NODE;
  return DEFAULT_UPDATE_NODE;
}

/**
 * Create or update thread state for `POST /threads/:threadId/state`.
 *
 * Used by the browser bootstrap in `src/app/threads.ts` and by the SDK when
 * hydrating or editing conversation history. Applies the update at
 * {@link resolveUpdateNode}, then returns the latest serialized snapshot.
 *
 * @param graph - Compiled agent graph with an attached checkpointer.
 * @param threadId - Thread id from the URL path.
 * @param options.values - State patch (defaults to `{ messages: [] }` for create).
 * @param options.checkpoint - Optional fork point (`checkpoint_id`, `checkpoint_ns`).
 * @param options.asNode - Optional explicit update node (`as_node` body field).
 * @returns Serialized thread state after the write.
 */
export async function updateThreadState(
  graph: LocalProtocolGraph,
  threadId: string,
  options: {
    values?: Record<string, unknown> | null;
    checkpoint?: Record<string, unknown> | null;
    asNode?: string;
  } = {}
): Promise<Record<string, unknown>> {
  let config = threadConfig(threadId);
  const checkpoint = options.checkpoint;
  if (checkpoint && typeof checkpoint.checkpoint_id === "string") {
    config = {
      configurable: {
        ...configurableOf(config),
        checkpoint_id: checkpoint.checkpoint_id,
        ...(typeof checkpoint.checkpoint_ns === "string"
          ? { checkpoint_ns: checkpoint.checkpoint_ns }
          : {}),
      },
    };
  }

  const snapshot = await graph.getState(config);
  const resolvedValues = options.values ?? { messages: [] };
  const resolvedAsNode = resolveUpdateNode({
    asNode: options.asNode,
    values: resolvedValues,
    hasCheckpoint: threadHasCheckpoint(snapshot),
  });

  await graph.updateState(config, resolvedValues, resolvedAsNode);
  const updated = await graph.getState(threadConfig(threadId));
  return serializeThreadState(updated, threadId);
}
