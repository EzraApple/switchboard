import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CodexEngine } from "../src/adapters/codex-engine.js";

test("shared engine connects over the native Unix WebSocket path and closes only its client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sb-ws-"));
  const socketPath = join(directory, "rpc.sock");
  const server = createServer();
  const websocket = new WebSocketServer({ server, path: "/rpc" });
  const requests: unknown[] = [];
  let connections = 0;
  websocket.on("connection", (socket) => {
    connections++;
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      if (request.method === "initialize")
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      if (request.method === "thread/read") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { thread: { id: "shared", status: { type: "idle" } } },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "turn/completed",
            params: { threadId: "shared", turn: { id: "one" } },
          }),
        );
        socket.send(
          JSON.stringify({
            id: "approval",
            method: "item/commandExecution/requestApproval",
            params: {},
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const notifications: string[] = [];
  let first: CodexEngine | undefined;
  let second: CodexEngine | undefined;
  try {
    first = new CodexEngine((method) => notifications.push(method), socketPath);
    assert.equal(first.transport, "codex_shared_daemon");
    const result = await first.call({
      method: "thread/read",
      params: { threadId: "shared" },
    });
    assert.deepEqual(result, {
      thread: { id: "shared", status: { type: "idle" } },
    });
    await first.close();
    assert.ok(notifications.includes("turn/completed"));
    assert.equal(
      requests.some((value) => (value as { id?: string }).id === "approval"),
      false,
    );
    assert.equal(server.listening, true);
    second = new CodexEngine(undefined, socketPath);
    await second.call({
      method: "thread/read",
      params: { threadId: "shared" },
    });
    assert.equal(connections, 2);
  } finally {
    await first?.close();
    await second?.close();
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
