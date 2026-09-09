import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter, CreateInput, Result } from "../src/contracts.js";
import { SessionManager } from "../src/manager.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DesktopUnavailableError } from "../src/adapters/codex-ipc.js";
import { OperationError } from "../src/errors.js";
import { readTranscript } from "../src/adapters/codex-store.js";

const nativeId = "519327f4-fc54-4140-8eef-25e1234bed57",
  sessionId = `codex:${nativeId}`;
function fixture({
  requestError,
  desktopError,
}: { requestError?: Error; desktopError?: Error } = {}) {
  const calls: string[] = [];
  const adapter = new CodexAdapter({
    engine: {
      async call({ method }) {
        calls.push(method);
        if (requestError && method === "thread/archive") throw requestError;
        return { turn: { id: "turn-1" } };
      },
      close() {},
    },
    store: {
      search: () => [],
      get: () => ({
        id: nativeId,
        name: "",
        title: "",
        archived: 0,
        cwd: "/tmp",
        rollout_path: "",
        source: "cli",
        updated_at: 1,
      }),
      read: async () => ({
        session_id: sessionId,
        native_id: nativeId,
        harness: "codex",
        title: "",
        archived: false,
        status: "idle",
        turn_id: null,
        messages: [],
      }),
    },
    openDesktop: async () => {
      throw desktopError ?? new DesktopUnavailableError("not running");
    },
  });
  return { adapter, calls };
}
test("missing Desktop falls back exactly once to separate engine", async () => {
  const { adapter, calls } = fixture();
  assert.equal(
    (await adapter.send({ session_id: sessionId, prompt: "test" })).status,
    "accepted",
  );
  assert.deepEqual(calls, ["thread/resume", "turn/start"]);
});
test("ambiguous Desktop delivery never falls back", async () => {
  const { adapter, calls } = fixture({
    desktopError: new OperationError("OUTCOME_UNKNOWN", "timeout"),
  });
  await assert.rejects(adapter.send({ session_id: sessionId, prompt: "test" }));
  assert.deepEqual(calls, []);
});
test("refresh failures do not undo either field in compound update", async () => {
  const { adapter, calls } = fixture();
  const result = await adapter.update({
    session_id: sessionId,
    title: "new",
    archived: true,
  });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.applied, ["title", "archived"]);
  assert.deepEqual(calls, ["thread/name/set", "thread/archive"]);
  assert.ok(Array.isArray(result.warnings));
});
test("ownership conflict preserves the successful rename", async () => {
  const { adapter } = fixture({
    requestError: new OperationError("SESSION_OWNED_ELSEWHERE", "owned"),
  });
  const result = await adapter.update({
    session_id: sessionId,
    title: "new",
    archived: true,
  });
  assert.equal(result.status, "partial");
  assert.equal(result.error_code, "SESSION_OWNED_ELSEWHERE");
  assert.deepEqual(result.applied, ["title"]);
});
test("successful delete remains success when Desktop is unavailable", async () => {
  const { adapter, calls } = fixture();
  assert.equal(
    (await adapter.delete({ session_id: sessionId })).status,
    "deleted",
  );
  assert.deepEqual(calls, ["thread/delete"]);
});
test("manager validates before dispatching a destructive operation", async () => {
  const { adapter, calls } = fixture();
  const manager = new SessionManager({ codex: adapter, claude: adapter });
  const result = await manager.execute({
    operation: "delete_session",
    arguments: { session_id: "invalid" },
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(calls, []);
});
test("mixed search returns healthy harness results when another fails", async () => {
  const { adapter } = fixture();
  const failing: Adapter = {
    ...stubAdapter(),
    async search() {
      throw new Error("provider down");
    },
  };
  const manager = new SessionManager({ codex: adapter, claude: failing });
  const result = await manager.execute({
    operation: "search_sessions",
    arguments: {},
  });
  assert.deepEqual(result.errors, { claude: "provider down" });
});
test("transcripts exclude reasoning, instructions and partially written records", async () => {
  const root = await mkdtemp(join(tmpdir(), "switchboard-transcript-"));
  try {
    const path = join(root, "test.jsonl");
    const rows = [
      {
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn-1" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "instruction" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "reasoning", summary: "private" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ready" }],
        },
      },
      { type: "event_msg", payload: { type: "task_complete" } },
    ];
    await writeFile(
      path,
      rows.map((row) => JSON.stringify(row)).join("\n") + '\n{"partial":',
    );
    const result = await readTranscript({ path, limit: 1 });
    assert.equal(result.status, "idle");
    assert.deepEqual(
      result.messages.map((message) => message.text),
      ["ready"],
    );
    assert.equal(
      (await readTranscript({ path: join(root, "missing"), limit: 1 })).status,
      "pending",
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
function stubAdapter(): Adapter {
  const result = async (): Promise<Result> => ({});
  return {
    search: async () => [],
    read: result,
    create: async (_input: CreateInput) => ({}),
    send: result,
    update: result,
    delete: result,
    close() {},
  };
}
