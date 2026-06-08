/**
 * Browser-side thread id storage and server bootstrap helpers.
 *
 * Port of the Python example's `frontend/src/threads.ts`. Each tab keeps its
 * own thread id in `sessionStorage` and ensures a matching checkpoint row
 * exists via the LangGraph SDK before {@link StreamProvider} hydrates.
 */

import { Client } from "@langchain/langgraph-sdk/client";

const STORAGE_KEY = "typescript-react-custom-backend-thread";

/**
 * Read the per-tab thread id from `sessionStorage`, minting one on first visit.
 *
 * @returns Stable thread id for this browser tab.
 */
export function readThreadId(): string {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem(STORAGE_KEY, id);
  return id;
}

/**
 * Persist a thread id for this tab.
 *
 * @param threadId - Id to store for this tab.
 */
export function writeThreadId(threadId: string) {
  sessionStorage.setItem(STORAGE_KEY, threadId);
}

/**
 * Mint a new thread id and persist it for this tab.
 *
 * @returns Fresh uuid written to `sessionStorage`.
 */
export function createThreadId(): string {
  const id = crypto.randomUUID();
  writeThreadId(id);
  return id;
}

/**
 * Create the thread row server-side so hydration does not 404.
 *
 * Calls `GET /threads/:id/state` and, on 404, bootstraps with
 * `POST /threads/:id/state` and empty `messages`.
 *
 * @param apiUrl - LangGraph SDK base url (e.g. `${origin}/api` through Vite).
 * @param threadId - Tab-local thread id to verify or create.
 */
export async function ensureThreadExists(apiUrl: string, threadId: string) {
  const client = new Client({ apiUrl });
  try {
    await client.threads.getState(threadId);
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status !== 404) throw error;
    await client.threads.updateState(threadId, { values: { messages: [] } });
  }
}

/** Result of {@link ensureThreadReady}. */
export type EnsureThreadReadyResult = {
  threadId: string;
  reset: boolean;
};

/**
 * Ensure a thread exists on the server before mounting {@link StreamProvider}.
 *
 * If the stored id cannot be created (e.g. after a backend restart with
 * incompatible in-memory state), mint a fresh thread id and try again.
 *
 * @param apiUrl - LangGraph SDK base url (e.g. `${origin}/api` through Vite).
 * @param threadId - Tab-local thread id from {@link readThreadId}.
 * @returns Final thread id and whether a fresh id was minted after a failure.
 */
export async function ensureThreadReady(
  apiUrl: string,
  threadId: string
): Promise<EnsureThreadReadyResult> {
  try {
    await ensureThreadExists(apiUrl, threadId);
    return { threadId, reset: false };
  } catch {
    const freshThreadId = createThreadId();
    await ensureThreadExists(apiUrl, freshThreadId);
    return { threadId: freshThreadId, reset: true };
  }
}
