/**
 * ReAct agent with search and calculator tools.
 *
 * Built with `createAgent` from `langchain` — the prebuilt agent loop that
 * wires the model, tools, and tool-calling routing for us. It is compiled with
 * an in-memory checkpointer so the custom backend can persist per-thread
 * conversation state, and it streams the same protocol channels (`messages`,
 * `tools`, `values`, `lifecycle`, …) the custom backend relays to clients.
 */

import { MemorySaver } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";

import { calculator, searchWeb } from "./tools.js";

export const agent = createAgent({
  // A concrete model instance avoids `langchain`'s string-based `initChatModel`
  // lookup, which cannot resolve `@langchain/openai` under pnpm's layout.
  model: new ChatOpenAI({ model: "gpt-4o-mini" }),
  tools: [searchWeb, calculator],
  checkpointer: new MemorySaver(),
  systemPrompt:
    "You are a helpful assistant with search_web and calculator tools. " +
    "Use tools when the user asks for lookup or math. Keep final answers concise.",
});
