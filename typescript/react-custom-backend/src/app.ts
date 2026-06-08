/**
 * Start the local Agent Streaming Protocol server.
 *
 * Port of the Python example's `main.py`: load the compiled ReAct agent and
 * expose it through the custom HTTP backend in {@link CustomServer}.
 */

import { agent } from "./agent/index.js";
import { CustomServer } from "./server/server.js";

const PORT = 9123;

const server = new CustomServer(agent);
await server.start(PORT);
console.log(
  `Agent Streaming Protocol server listening on http://localhost:${PORT}`
);
