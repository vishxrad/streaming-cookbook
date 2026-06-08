import { useMemo } from "react";

import { AIMessage } from "@langchain/core/messages";
import { useStreamContext } from "@langchain/react";

import type { agent } from "../../agent/index.js";

function messageLabel(message: { type: string; name?: string }) {
  if (message.type === "human") return "You";
  if (message.type === "tool") return `Tool · ${message.name ?? "result"}`;
  if (message.type === "ai") return "Assistant";
  return message.type;
}

function formatToolArgs(args: Record<string, unknown>) {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  if (entries.length === 1) return String(entries[0]?.[1] ?? "");
  return JSON.stringify(args);
}

export function MessageList() {
  const stream = useStreamContext<typeof agent>();

  const messages = useMemo(
    () => stream.messages.filter((message) => message != null),
    [stream.messages]
  );

  return (
    <section aria-label="Chat messages" className="chat-card">
      {messages.length === 0 ? (
        <div className="empty-state">
          Send the example prompt to stream assistant tokens, tool calls, and
          tool results from the TypeScript backend.
        </div>
      ) : null}

      {messages.map((message, index) => {
        const toolCalls = AIMessage.isInstance(message)
          ? (message.tool_calls ?? [])
          : [];
        return (
          <div
            className={`message ${message.type === "human" ? "user" : ""} ${
              message.type === "tool" ? "tool" : ""
            }`}
            key={message.id ?? index}
          >
            <span>{messageLabel(message)}</span>
            {toolCalls.length > 0 ? (
              <ul className="tool-call-list">
                {toolCalls.map((toolCall, toolIndex) => {
                  const args = formatToolArgs(toolCall.args ?? {});
                  return (
                    <li key={toolCall.id ?? `${index}-${toolIndex}`}>
                      <strong>{toolCall.name}</strong>
                      {args ? `(${args})` : ""}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {message.text ? <p>{message.text}</p> : null}
          </div>
        );
      })}

      {messages.length === 0 && !stream.isLoading && stream.error ? (
        <div className="error">
          Could not reach the TypeScript protocol server. Start it with{" "}
          <code>pnpm dev</code>, then try again.
        </div>
      ) : null}
    </section>
  );
}
