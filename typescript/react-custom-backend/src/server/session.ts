import type { ReactAgent } from "langchain";
// `StreamChannel` buffers events; `matchesSubscription` is the shared protocol
// predicate from `@langchain/langgraph/stream` — the same one langgraph-api
// uses, so this custom transport stays aligned with the production server.
import {
  StreamChannel,
  matchesSubscription,
  type ProtocolEvent,
} from "@langchain/langgraph/stream";
import type {
  Command,
  CommandResponse,
  ErrorResponse,
  SubscribeParams,
} from "@langchain/protocol";

import { isRecord, sanitizeForJson } from "./serialize.js";

type AgentRunInput = Parameters<ReactAgent["streamEvents"]>[0];

/**
 * Make an event safe to `JSON.stringify` onto the SSE wire.
 *
 * Only the protocol payload (`params.data`) and any `params.interrupts` can
 * carry LangChain message instances, so those are the fields we sanitize into
 * the plain, role-keyed protocol message shape the SDK expects.
 */
function sanitizeEvent(event: ProtocolEvent): ProtocolEvent {
  const params = event.params as Record<string, unknown>;
  const sanitizedParams: Record<string, unknown> = {
    ...params,
    data: sanitizeForJson(params.data),
  };
  if ("interrupts" in params) {
    sanitizedParams.interrupts = sanitizeForJson(params.interrupts);
  }
  return { ...event, params: sanitizedParams } as ProtocolEvent;
}

/**
 * Encode an Agent Protocol event as a Server-Sent Event frame.
 *
 * SSE delivery uses a JSON protocol event in `data:`. When available,
 * `event_id` is mirrored into the SSE `id:` field for transport-level
 * reconnection. The SDK primarily deduplicates by `event_id` and replays by
 * `seq`; if an event has no `event_id`, this example falls back to `seq` as a
 * stable frame id.
 */
function encodeSse(event: ProtocolEvent) {
  const eventId = (event as { event_id?: string }).event_id;
  const id = eventId ?? (typeof event.seq === "number" ? `${event.seq}` : "");
  const idLine = id ? `id: ${id}\n` : "";
  return new TextEncoder().encode(
    `${idLine}event: message\ndata: ${JSON.stringify(event)}\n\n`
  );
}

/**
 * Minimal in-memory Agent Streaming Protocol session for the local demo.
 *
 * This class is the server-side counterpart to `HttpAgentServerAdapter`. It
 * implements the SSE/HTTP transport model documented by the Agent Streaming
 * Protocol:
 *
 * - `POST /threads/:thread_id/commands` sends a JSON `Command` and receives a
 *   `CommandResponse` or `ErrorResponse`.
 * - `POST /threads/:thread_id/stream` opens a connection-scoped SSE
 *   subscription described by `SubscribeParams`.
 * - Events are buffered by `seq` and replayed to later subscriptions, enabling
 *   the SDK to rotate streams as subscriptions widen or narrow.
 *
 * The implementation is intentionally small and process-local. It is suitable
 * for this example and for understanding the protocol shape, but production
 * servers should persist threads, enforce concurrency policies, and coordinate
 * replay buffers across workers.
 *
 * @see https://github.com/langchain-ai/agent-protocol/tree/main/streaming
 */
export class LocalThreadSession {
  readonly #agent: ReactAgent;
  readonly #threadId: string;

  /**
   * Per-thread protocol event log.
   *
   * A {@link StreamChannel} is LangGraph's buffered, append-only stream with
   * independent per-consumer cursors. Using it here replaces a hand-rolled
   * `ProtocolEvent[]` buffer plus a live-sink registry: every event ever
   * published stays buffered, and each SSE subscription gets its own cursor via
   * {@link StreamChannel.iterate}, so buffered replay and live delivery are the
   * same iteration. We use a local (in-process) channel because the session
   * performs its own protocol-aware filtering in {@link stream}.
   */
  readonly #log = StreamChannel.local<ProtocolEvent>();

  /** Monotonic seq across all runs on this thread (graph runs reset at 0). */
  #nextSeq = 0;

  #activeRun:
    | {
      abort(reason?: unknown): void;
    }
    | undefined;

  constructor(agent: ReactAgent, threadId: string) {
    this.#agent = agent;
    this.#threadId = threadId;
  }

  /**
   * Handle a thread command sent to the Agent Protocol `/commands` endpoint.
   *
   * The SDK sends `run.start` to start or resume a graph run on the current
   * thread. This demo starts the LangGraph in-process v3 stream and immediately
   * returns a success response containing a generated `run_id`, while streamed
   * events flow asynchronously through active `/stream` subscriptions.
   *
   * Other Agent Protocol commands, such as subscription commands used by the
   * WebSocket transport, are rejected here because SSE subscriptions are carried
   * by independent HTTP connections rather than in-band commands.
   */
  async handleCommand(
    command: Command
  ): Promise<CommandResponse | ErrorResponse> {
    if (command.method !== "run.start") {
      return {
        type: "error",
        id: command.id,
        error: "unknown_command",
        message: `Unsupported command: ${command.method}`,
      } as ErrorResponse;
    }

    const params = isRecord(command.params)
      ? (command.params as { input?: unknown })
      : {};
    const runId = crypto.randomUUID();
    void this.#startRun(params.input as AgentRunInput, runId);

    return {
      type: "success",
      id: command.id,
      result: { run_id: runId },
    } as CommandResponse;
  }

  /**
   * Open a connection-scoped SSE subscription for this thread.
   *
   * The returned `ReadableStream` first replays buffered events matching the
   * requested `channels`, `namespaces`, `depth`, and optional `since` cursor,
   * then stays attached for live events. Closing the HTTP connection releases
   * this subscription's event-log cursor, matching the Agent Protocol SSE
   * unsubscribe model.
   */
  stream(params: SubscribeParams) {
    // Each subscription gets an independent cursor over the shared event log.
    // The cursor first walks the buffered history (replay) and then awaits
    // freshly pushed events (live delivery) — the channel makes both the same
    // iteration, so this server only has to apply the protocol filter.
    const cursor = this.#log.iterate();

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        // Scan forward until we find an event matching this subscription's
        // filter, enqueue exactly one frame, and return so the channel honors
        // the consumer's backpressure. `cursor.next()` resolves immediately for
        // buffered events and suspends once the live edge is reached.
        for (; ;) {
          const { value: event, done } = await cursor.next();
          if (done) {
            controller.close();
            return;
          }
          if (matchesSubscription(event, params)) {
            controller.enqueue(encodeSse(event));
            return;
          }
        }
      },
      cancel: () => {
        // Closing the HTTP connection releases this subscription's cursor,
        // matching the Agent Protocol SSE unsubscribe model.
        void cursor.return?.(undefined);
      },
    });
  }

  #publish(rawEvent: ProtocolEvent) {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    const event = sanitizeEvent({
      ...rawEvent,
      type: "event",
      seq,
    } as ProtocolEvent);
    this.#log.push(event);
  }

  async #startRun(input: AgentRunInput, runId: string) {
    this.#activeRun?.abort("Starting a new run.");
    // Thread the `thread_id` / `run_id` into the run config so the checkpointer
    // persists conversation state per thread and downstream events carry the
    // run identity.
    const run = await this.#agent.streamEvents(input, {
      version: "v3",
      configurable: { thread_id: this.#threadId, run_id: runId },
    });
    this.#activeRun = run;

    try {
      for await (const rawEvent of run) {
        // Normalize non-standard methods onto the `custom` envelope, then
        // sanitize LangChain message instances into plain protocol dicts before
        // appending. Every active subscription cursor observes the event through
        // {@link stream}, and it is replayed to later subscriptions.
        this.#publish(rawEvent);
      }
    } catch (error) {
      console.error(error);
    } finally {
      if (this.#activeRun === run) {
        this.#activeRun = undefined;
      }
    }
  }
}
