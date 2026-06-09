/**
 * React entry shell for the Python custom-backend chat UI.
 *
 * Wires {@link StreamProvider} to a local {@link HttpAgentServerAdapter}
 * (Vite proxies `/api` → the Starlette server on port 9123) and bootstraps a
 * per-tab thread via {@link ensureThreadReady} before mounting {@link Chat}.
 *
 * Mirrors the TypeScript example's `src/app/index.tsx`; presentation lives
 * under `./components/`.
 */

import { useEffect, useMemo, useState } from "react";

import {
  HttpAgentServerAdapter,
  StreamProvider,
} from "@langchain/react";

import { Chat } from "./components/Chat.js";
import {
  API_URL,
  createThreadId,
  ensureThreadReady,
  readThreadId,
} from "./threads.js";

/**
 * Root application component.
 *
 * Lifecycle per tab:
 *
 * 1. Read or mint a `threadId` from `sessionStorage`.
 * 2. Ensure the thread row exists on the server (`GET|POST …/state`).
 * 3. Build an {@link HttpAgentServerAdapter} scoped to that thread.
 * 4. Mount {@link StreamProvider} and render {@link Chat}.
 *
 * Changing `threadId` (New thread) re-runs bootstrap and remounts the provider
 * via `key={threadId}` so stream state does not leak across conversations.
 */
export function App() {
  const [threadId, setThreadId] = useState(readThreadId);
  const [threadReady, setThreadReady] = useState(false);
  const [threadWasReset, setThreadWasReset] = useState(false);

  /**
   * Bootstrap the checkpoint row before StreamProvider hydrates the thread.
   */
  useEffect(() => {
    let cancelled = false;
    setThreadReady(false);
    setThreadWasReset(false);
    void ensureThreadReady(threadId)
      .then((result) => {
        if (cancelled) return;
        if (result.threadId !== threadId) {
          setThreadId(result.threadId);
        }
        setThreadWasReset(result.reset);
        setThreadReady(true);
      })
      .catch(() => {
        /**
         * Still mount the UI if bootstrap fails; Chat surfaces connection errors.
         */
        if (!cancelled) setThreadReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  /**
   * Build an {@link HttpAgentServerAdapter} scoped to that thread.
   */
  const transport = useMemo(
    () =>
      new HttpAgentServerAdapter({
        apiUrl: API_URL,
        threadId,
        paths: {
          commands: `/threads/${threadId}/commands`,
          stream: `/threads/${threadId}/stream`,
        },
      }),
    [threadId]
  );

  function handleNewThread() {
    const nextThreadId = createThreadId();
    setThreadId(nextThreadId);
  }

  if (!threadReady) {
    return (
      <main className="chat-shell">
        <div className="empty-state">
          Preparing thread {threadId.slice(0, 8)}…
        </div>
      </main>
    );
  }

  return (
    <StreamProvider key={threadId} threadId={threadId} transport={transport}>
      <Chat
        onNewThread={handleNewThread}
        threadId={threadId}
        threadWasReset={threadWasReset}
      />
    </StreamProvider>
  );
}
