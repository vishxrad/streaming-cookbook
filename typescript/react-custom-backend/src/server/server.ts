import type { ReactAgent } from "langchain";
import type { Command, SubscribeParams } from "@langchain/protocol";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";

import { LocalThreadSession } from "./session.js";
import {
  ThreadNotFoundError,
  getThreadHistory,
  getThreadState,
  updateThreadState,
} from "./threads.js";

/**
 * Minimal HTTP server that exposes an in-process LangGraph through the Agent
 * Streaming Protocol endpoints consumed by `HttpAgentServerAdapter`, plus the
 * LangGraph SDK thread-state routes backed by the graph checkpointer.
 *
 * The server keeps one {@link LocalThreadSession} per thread id. Each session
 * owns its event replay buffer and active run, while this class routes protocol
 * commands, stream subscriptions, and thread-state requests to the right
 * session and to the shared compiled graph.
 *
 * @see https://github.com/langchain-ai/agent-protocol/tree/main/streaming
 */
export class CustomServer {
  #app = new Hono();
  #agent: ReactAgent;
  #sessions = new Map<string, LocalThreadSession>();

  constructor(agent: ReactAgent) {
    this.#agent = agent;

    this.#app.get("/threads/:threadId/state", this.#getState.bind(this));
    this.#app.post("/threads/:threadId/state", this.#postState.bind(this));
    this.#app.post("/threads/:threadId/history", this.#postHistory.bind(this));
    this.#app.post("/threads/:threadId/commands", this.#commands.bind(this));
    this.#app.post("/threads/:threadId/stream", this.#stream.bind(this));
  }

  /**
   * Get or create the process-local session for a thread.
   *
   * This example stores sessions in memory. Production servers should back this
   * with durable thread state and a replay buffer shared across workers.
   */
  #session(threadId: string) {
    let session = this.#sessions.get(threadId);
    if (session == null) {
      session = new LocalThreadSession(this.#agent, threadId);
      this.#sessions.set(threadId, session);
    }
    return session;
  }

  /** Handle `GET /threads/:threadId/state`. */
  async #getState(ctx: Context) {
    const threadId = ctx.req.param("threadId") ?? "local";
    try {
      return ctx.json(await getThreadState(this.#agent.graph, threadId));
    } catch (error) {
      if (error instanceof ThreadNotFoundError) {
        return ctx.json(
          { error: "not_found", message: error.message },
          404
        );
      }
      throw error;
    }
  }

  /** Handle `POST /threads/:threadId/state`. */
  async #postState(ctx: Context) {
    const threadId = ctx.req.param("threadId") ?? "local";
    const body = (await ctx.req.json().catch(() => ({}))) as {
      values?: Record<string, unknown> | null;
      checkpoint?: Record<string, unknown> | null;
      as_node?: string;
    };
    try {
      const state = await updateThreadState(this.#agent.graph, threadId, {
        values: body.values ?? null,
        checkpoint: body.checkpoint ?? null,
        asNode: body.as_node,
      });
      return ctx.json(state);
    } catch (error) {
      return ctx.json(
        { error: "invalid_state_update", message: String(error) },
        422
      );
    }
  }

  /** Handle `POST /threads/:threadId/history`. */
  async #postHistory(ctx: Context) {
    const threadId = ctx.req.param("threadId") ?? "local";
    const body = (await ctx.req.json().catch(() => ({}))) as {
      limit?: number;
      before?: unknown;
    };
    try {
      const history = await getThreadHistory(this.#agent.graph, threadId, {
        limit: typeof body.limit === "number" ? body.limit : 10,
        before: body.before,
      });
      return ctx.json(history);
    } catch (error) {
      if (error instanceof ThreadNotFoundError) {
        return ctx.json(
          { error: "not_found", message: error.message },
          404
        );
      }
      throw error;
    }
  }

  /**
   * Handle `POST /threads/:threadId/commands`.
   *
   * The request body is an Agent Protocol {@link Command}. The response is the
   * command result emitted by the owning {@link LocalThreadSession}.
   */
  async #commands(ctx: Context) {
    const threadId = ctx.req.param("threadId") ?? "local";
    const command = (await ctx.req.json()) as Command;
    return ctx.json(await this.#session(threadId).handleCommand(command));
  }

  /**
   * Handle `POST /threads/:threadId/stream`.
   *
   * The request body is a connection-scoped {@link SubscribeParams} filter. The
   * response is an SSE stream that first replays matching buffered events and
   * then stays attached for live events from the same thread.
   */
  async #stream(ctx: Context) {
    const threadId = ctx.req.param("threadId") ?? "local";
    const params = (await ctx.req.json()) as SubscribeParams;

    return new Response(this.#session(threadId).stream(params), {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
      },
    });
  }

  /**
   * Start serving the protocol routes on the given port.
   *
   * @param port - TCP port for the local Hono server.
   * @returns Server metadata used by the example runner.
   */
  async start(port: number) {
    return new Promise((resolve) =>
      serve(
        {
          fetch: this.#app.fetch,
          port,
        },
        (c) =>
          resolve({
            host: `${c.address}:${c.port}`,
            cleanup: () => Promise.resolve(),
          })
      )
    );
  }
}
