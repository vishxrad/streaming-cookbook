import { useMemo } from "react";

import { type BaseMessage } from "langchain";
import { useStreamContext } from "@langchain/react";

import { TypingDots } from "./StreamingIndicator.js";

function summarizeToolCalls(messages: BaseMessage[]) {
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.type !== "tool" || !("tool_call_id" in message)) continue;
    const id = message.tool_call_id;
    if (typeof id === "string") resultIds.add(id);
  }

  let count = 0;
  let running = 0;
  for (const message of messages) {
    if (message.type !== "ai" || !("tool_calls" in message)) continue;
    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      count += 1;
      const id = call.id;
      if (typeof id === "string" && !resultIds.has(id)) running += 1;
    }
  }
  return { count, running };
}

export function MetaCard({
  threadId,
  onNewThread,
}: {
  threadId: string;
  onNewThread: () => void;
}) {
  const stream = useStreamContext();

  const messages = useMemo(
    () => stream.messages.filter((message) => message != null),
    [stream.messages]
  );

  const { count: toolCallCount, running: activeToolCalls } = useMemo(
    () => summarizeToolCalls(messages),
    [messages]
  );

  return (
    <section aria-label="Stream status" className="meta-card">
      <div>
        <span>Thread</span>
        <strong>{threadId.slice(0, 8)}</strong>
      </div>
      <div>
        <span>Status</span>
        <strong className={stream.isLoading ? "status-streaming" : undefined}>
          {stream.isLoading ? (
            <>
              Streaming
              <TypingDots className="inline-dots" />
            </>
          ) : (
            "Idle"
          )}
        </strong>
      </div>
      <div>
        <span>Tool calls</span>
        <strong>
          {toolCallCount}
          {activeToolCalls > 0 ? ` (${activeToolCalls} running)` : ""}
        </strong>
      </div>
      <div className="meta-actions">
        <button onClick={onNewThread} type="button">
          New thread
        </button>
      </div>
    </section>
  );
}
