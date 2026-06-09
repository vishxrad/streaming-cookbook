# React Custom Backend

React and Vite example that uses `@langchain/react` against a local Agent Streaming Protocol server instead of the default LangGraph hosted transport. A Hono backend implements the protocol over HTTP and SSE and runs a ReAct agent with tool streaming.

## What It Demonstrates

- `StreamProvider` with `HttpAgentServerAdapter` pointed at local command and stream endpoints.
- A local Hono server that implements the Agent Streaming Protocol over HTTP and SSE.
- Per-thread checkpointed state via LangGraph's in-memory checkpointer.
- Subscription filtering by protocol channel, namespace, depth, and replay cursor.
- Token-by-token `messages` streaming and `tools` lifecycle events in the UI.

## Prerequisites

Create the shared environment file from the repository root:

```bash
cp .env.example .env
```

Fill in the OpenAI provider key listed in `.env`. The local server loads the root file through `tsx --env-file=../../.env`.

Install from the TypeScript workspace root:

```bash
cd typescript
pnpm install
```

## Run

```bash
cd typescript/react-custom-backend
pnpm dev
```

This starts:

- `vite` for the browser app.
- `tsx watch --env-file=../../.env --clear-screen=false src/app.ts` for the local protocol server.

Other commands:

```bash
pnpm dev:client
pnpm dev:server
pnpm build:internal
pnpm preview
```

The Vite dev server proxies `/api` to the local Hono server on `http://localhost:9123`, stripping the `/api` prefix so browser calls to `/api/threads/...` reach `/threads/...` on the backend (same as the Python example).

## How It Works

`src/app.ts` loads a compiled ReAct agent and starts `CustomServer`. The server exposes the Agent Streaming Protocol routes consumed by `HttpAgentServerAdapter`:

- `POST /threads/:threadId/commands` accepts `run.start` commands and starts an in-process `streamEvents(..., { version: "v3" })` run.
- `POST /threads/:threadId/stream` opens a filtered SSE subscription and replays matching buffered events when a cursor is provided.
- `GET|POST /threads/:threadId/state` reads and updates checkpointed thread state.

`src/app/index.tsx` configures `HttpAgentServerAdapter` with those local paths and passes it to `StreamProvider` (requires `@langchain/react` ≥ 1.0.20 and `@langchain/langgraph-sdk` ≥ 1.9.20 so hydration inherits the transport `apiUrl`). Each browser tab keeps its own thread id in `sessionStorage`, bootstrapped through the LangGraph SDK thread-state routes before the first stream.

`src/server/session.ts` is the server-side counterpart. It buffers protocol events by sequence number, applies subscription filters, and fans matching SSE frames out to active subscribers.

## Important Files

- `src/main.tsx`: React entrypoint.
- `src/app/index.tsx`: `StreamProvider`, per-tab thread management, and the UI shell.
- `src/app/threads.ts`: client-side thread id storage and server bootstrap helpers.
- `src/app.ts`: agent bootstrap and local server startup.
- `src/server/server.ts`: Hono routes for Agent Streaming Protocol commands, streams, and thread state.
- `src/server/session.ts`: in-memory thread session, replay buffer, subscription filtering, and SSE framing.
- `src/server/threads.ts`: checkpointer-backed get/update state helpers.
- `src/agent/index.ts`: ReAct agent with `search_web` and `calculator` tools.
## Python sibling

The Python example in `python/react-custom-backend/` implements the same protocol surface with Starlette and ships a matching React UI with per-tab threads, stream status, and tool-call counts.

## SDK Docs

- [React SDK docs](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk-react/docs): `StreamProvider`, custom transports, extension projections, and React stream consumption.
- [Client Streaming SDK docs](https://github.com/langchain-ai/langgraphjs/blob/5e2014ff1a85fc77416a90b5f22fec9e46336d09/libs/sdk/docs): the lower-level stream, subscription, channel, and namespace behavior that this example reimplements locally.
