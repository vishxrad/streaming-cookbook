import { useState } from "react";

import { HumanMessage } from "@langchain/core/messages";
import { useStreamContext } from "@langchain/react";

import type { agent } from "../../agent/index.js";
import { MetaCard } from "./MetaCard.js";
import { MessageList } from "./MessageList.js";

const EXAMPLE_PROMPT =
  "Search the web for LangGraph streaming, then calculate 42 * 17.";

export function Chat({
  threadId,
  onNewThread,
  threadWasReset,
}: {
  threadId: string;
  onNewThread: () => void;
  threadWasReset: boolean;
}) {
  const stream = useStreamContext<typeof agent>();
  const [content, setContent] = useState(EXAMPLE_PROMPT);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  function handleSubmit() {
    const nextContent = content.trim();
    if (nextContent.length === 0 || stream.isLoading) return;

    setContent("");
    void stream.submit({
      messages: [new HumanMessage(nextContent)],
    });
  }

  return (
    <main className={`chat-shell ${theme === "light" ? "light" : ""}`}>
      <button
        aria-label={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
        className="theme-toggle"
        onClick={() =>
          setTheme((current) => (current === "dark" ? "light" : "dark"))
        }
        type="button"
      >
        {theme === "dark" ? "☀" : "☾"}
      </button>

      <section className="hero-card">
        <div aria-label="React logo" className="framework-logo" role="img">
          <svg viewBox="-11.5 -10.23174 23 20.46348">
            <circle cx="0" cy="0" fill="currentColor" r="2.05" />
            <g fill="none" stroke="currentColor" strokeWidth="1">
              <ellipse rx="11" ry="4.2" />
              <ellipse rx="11" ry="4.2" transform="rotate(60)" />
              <ellipse rx="11" ry="4.2" transform="rotate(120)" />
            </g>
          </svg>
        </div>
        <div className="eyebrow">typescript custom backend</div>
        <div className="hero-copy">
          <h1>React + LocalThreadSession</h1>
          <p>
            Each browser tab keeps its own thread id. Watch assistant tokens and
            tool calls stream over <code>messages</code> and <code>tools</code>{" "}
            channels via <code>MemorySaver</code> checkpoints at{" "}
            <code>/threads/&lt;id&gt;/…</code>.
          </p>
        </div>
      </section>

      {threadWasReset ? (
        <section aria-live="polite" className="notice-card">
          Server memory was cleared. Started a fresh thread for this tab.
        </section>
      ) : null}

      <MetaCard onNewThread={onNewThread} threadId={threadId} />
      <MessageList />

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <textarea
          aria-label="Message"
          onChange={(event) => setContent(event.target.value)}
          placeholder="Ask for a web search, a calculation, or both..."
          rows={3}
          value={content}
        />
        <button
          disabled={content.trim() === "" || stream.isLoading}
          type="submit"
        >
          Send
        </button>
      </form>
    </main>
  );
}
