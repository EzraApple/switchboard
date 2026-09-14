import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CodexAdapter } from "../src/adapters/codex.js";
import { DesktopUnavailableError } from "../src/adapters/codex-ipc.js";

function fixture() {
  const workers: {
    notify: (method: string, params: unknown) => void;
    closed: boolean;
    calls: string[];
  }[] = [];
  let desktopAvailable = false;
  let backgroundTerminals: unknown[] = [];
  const adapter = new CodexAdapter({
    createEngine(notify) {
      const worker = { notify, closed: false, calls: [] as string[] };
      workers.push(worker);
      return {
        async call({ method, params }) {
          assert.equal(worker.closed, false);
          worker.calls.push(method);
          const { threadId } = params as { threadId: string };
          if (method === "turn/start")
            notify("turn/started", { threadId, turn: { id: "turn-1" } });
          if (method === "thread/backgroundTerminals/list")
            return { data: backgroundTerminals };
          return { turn: { id: "turn-1" } };
        },
        async close() {
          worker.closed = true;
        },
      };
    },
    store: {
      search: () => [],
      get: (sessionId) => ({
        id: sessionId.slice(6),
        name: "",
        title: "",
        archived: 0,
        cwd: "/tmp",
        rollout_path: "",
        source: "cli",
        updated_at: 1,
      }),
      read: async () => ({ status: "idle", turn_id: null, messages: [] }),
    },
    openDesktop: async () => {
      if (!desktopAvailable) throw new DesktopUnavailableError("not running");
      return {
        findOwner: async () => "desktop-owner",
        send: async () => ({
          type: "response",
          result: { result: { turnId: "desktop-turn" } },
        }),
        broadcast() {},
        close() {},
      };
    },
  });
  return {
    adapter,
    workers,
    setBackgroundTerminals(value: unknown[]) {
      backgroundTerminals = value;
    },
    enableDesktop() {
      desktopAvailable = true;
    },
  };
}
const first = "codex:519327f4-fc54-4140-8eef-25e1234bed57";
const second = "codex:519327f4-fc54-4140-8eef-25e1234bed58";
function notify(
  worker: ReturnType<typeof fixture>["workers"][number],
  method: string,
  sessionId: string,
  turnId = "turn-1",
) {
  worker.notify(method, { threadId: sessionId.slice(6), turn: { id: turnId } });
}
test("completed task releases its writer without stopping another task, then routes to Desktop", async () => {
  const { adapter, workers, enableDesktop } = fixture();
  await adapter.send({ session_id: first, prompt: "2+2" });
  await adapter.send({ session_id: second, prompt: "3+3" });
  assert.equal(workers.length, 2);
  notify(workers[0]!, "turn/completed", first);
  await setImmediate();
  assert.equal(workers[0]!.closed, true);
  assert.equal(workers[1]!.closed, false);
  enableDesktop();
  const result = await adapter.send({ session_id: first, prompt: "4+4" });
  assert.equal(result.transport, "codex_desktop_ipc");
  assert.equal(workers.length, 2);
  adapter.close();
});
test("completion does not close an engine with another active turn", async () => {
  const { adapter, workers } = fixture();
  await adapter.send({ session_id: first, prompt: "2+2" });
  notify(workers[0]!, "turn/started", second, "child-turn");
  notify(workers[0]!, "turn/completed", first);
  await setImmediate();
  assert.equal(workers[0]!.closed, false);
  notify(workers[0]!, "turn/completed", second, "child-turn");
  await setImmediate();
  assert.equal(workers[0]!.closed, true);
  adapter.close();
});
test("follow-up without Desktop resumes in a fresh engine after release", async () => {
  const { adapter, workers } = fixture();
  await adapter.send({ session_id: first, prompt: "2+2" });
  notify(workers[0]!, "turn/completed", first);
  await adapter.send({ session_id: first, prompt: "3+3" });
  assert.equal(workers[0]!.closed, true);
  assert.equal(workers.length, 2);
  assert.deepEqual(workers[1]!.calls, ["thread/resume", "turn/start"]);
  adapter.close();
});

test("completed answer preserves an engine with a running background terminal", async () => {
  const { adapter, workers, setBackgroundTerminals } = fixture();
  await adapter.send({ session_id: first, prompt: "2+2" });
  setBackgroundTerminals([{ processId: "server" }]);
  notify(workers[0]!, "turn/completed", first);
  await setImmediate();
  assert.equal(workers[0]!.closed, false);
  setBackgroundTerminals([]);
  notify(workers[0]!, "turn/completed", first);
  await setImmediate();
  assert.equal(workers[0]!.closed, true);
  adapter.close();
});
