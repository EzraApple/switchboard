import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeBackground } from "../src/adapters/claude-background.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { SessionSearchIndex } from "../src/search.js";
import type { DesktopSession } from "../src/adapters/claude-desktop-store.js";
import { OperationError } from "../src/errors.js";

const session: DesktopSession = {
  sessionId: "local_519327f4-fc54-4140-8eef-25e1234bed57",
  cliSessionId: "519327f4-fc54-4140-8eef-25e1234bed57",
  title: "old conversation",
  cwd: "/workspace",
  isArchived: false,
  bridgeSessionIds: ["session_old", "session_current"],
};
function fixture(
  options: {
    copied?: boolean;
    existingBackground?: boolean;
    supported?: boolean;
    ready?: boolean;
    launchError?: Error;
  } = {},
) {
  let started = false;
  let archived = false;
  let checked = 0;
  const calls: string[][] = [];
  const current = () => ({
    ...session,
    isArchived: archived,
    ...(started && options.ready !== false
      ? {
          livePid: 123,
          messagingSocketPath: "/tmp/claude.sock",
          procStart: "start",
        }
      : {}),
  });
  const desktop = {
    async list() {
      return [current()];
    },
  };
  const wake = new ClaudeBackground(desktop, {
    executable: async () => "/bin/claude",
    checkTranscript: async () => {
      checked++;
    },
    pause: async () => {},
    run: async (_binary, args, cwd) => {
      assert.equal(cwd, session.cwd);
      calls.push(args);
      if (args[0] === "--help")
        return options.supported === false ? "old CLI" : "--bg --resume";
      if (args[0] === "agents")
        return JSON.stringify(
          started
            ? [
                {
                  id: options.copied ? "aaaaaaaa" : "519327f4",
                  sessionId: options.copied
                    ? "aaaaaaaa-fc54-4140-8eef-25e1234bed57"
                    : session.cliSessionId,
                  cwd: session.cwd,
                  kind: "background",
                  pid: 123,
                },
              ]
            : options.existingBackground
              ? [
                  {
                    id: "519327f4",
                    sessionId: session.cliSessionId,
                    cwd: session.cwd,
                    kind: "background",
                    state: "stopped",
                  },
                ]
              : [],
        );
      if (args[0] === "--bg") {
        if (options.launchError) throw options.launchError;
        started = true;
        return `backgrounded · ${options.copied ? "aaaaaaaa" : "519327f4"} (idle — send a prompt to start)`;
      }
      if (args[0] === "stop") return "stopped";
      throw new Error("unexpected command");
    },
  });
  return {
    wake,
    calls,
    desktop,
    current,
    checked: () => checked,
    archive: () => {
      archived = true;
    },
  };
}

test("background wake preserves identity, passes no prompt, and concurrent wakes reuse the owner", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    f.wake.wake(session),
    f.wake.wake(session),
  ]);
  assert.equal(first.cliSessionId, session.cliSessionId);
  assert.equal(first.livePid, 123);
  assert.equal(second.livePid, 123);
  assert.deepEqual(
    f.calls.filter((args) => args[0] === "--bg"),
    [["--bg", "--resume", session.cliSessionId, "--no-chrome"]],
  );
  assert.equal(f.checked(), 1);
});
test("a native fork caused by a competing owner is stopped and never used for messaging", async () => {
  const f = fixture({ copied: true });
  await assert.rejects(f.wake.wake(session), {
    code: "CLAUDE_WAKE_IDENTITY_MISMATCH",
  });
  assert.deepEqual(f.calls.at(-1), ["stop", "aaaaaaaa"]);
});
test("unsupported versions and archives fail before startup", async () => {
  const f = fixture({ supported: false });
  await assert.rejects(f.wake.wake(session), {
    code: "CLAUDE_BACKGROUND_UNSUPPORTED",
  });
  assert.equal(f.calls.length, 1);
  f.archive();
  await assert.rejects(f.wake.wake(session), /Unarchive/);
  assert.equal(f.calls.length, 1);
});
test("uncertain startup and missing inbox never retry the launch", async () => {
  const uncertain = fixture({ launchError: new Error("timeout") });
  await assert.rejects(uncertain.wake.wake(session), {
    code: "CLAUDE_WAKE_UNCONFIRMED",
  });
  assert.equal(uncertain.calls.filter((a) => a[0] === "--bg").length, 1);
  const blocked = fixture({ ready: false });
  await assert.rejects(blocked.wake.wake(session), {
    code: "CLAUDE_WAKE_NOT_READY",
  });
  assert.equal(blocked.calls.filter((a) => a[0] === "--bg").length, 1);
});
test("MCP adapter wakes a dormant Desktop alias and delivers once through its original local inbox", async () => {
  const f = fixture();
  let sends = 0;
  let uncertain = false;
  const adapter = new ClaudeAdapter(
    {
      async request() {
        throw new Error("remote API must not be used");
      },
    },
    {
      async environment() {
        throw new Error("unused");
      },
      async resume() {
        throw new Error("unused");
      },
      forget() {},
      close() {},
    },
    f.desktop,
    {
      async send(owner, prompt) {
        assert.equal(owner.cliSessionId, session.cliSessionId);
        assert.equal(owner.livePid, 123);
        assert.equal(prompt, "hello");
        sends++;
        if (uncertain)
          throw new OperationError("OUTCOME_UNKNOWN", "delivery uncertain");
        return {
          status: "submitted",
          delivery: "unconfirmed",
          transport: "claude_local_peer",
        };
      },
    },
    new SessionSearchIndex(":memory:"),
    undefined,
    f.wake,
  );
  try {
    const receipt = await adapter.send({
      session_id: "claude:cse_old",
      prompt: "hello",
    });
    assert.equal(receipt.resumed, true);
    assert.equal(receipt.session_id, "claude:cse_old");
    assert.equal(sends, 1);
    uncertain = true;
    await assert.rejects(
      adapter.send({
        session_id: `claude:${session.sessionId}`,
        prompt: "hello",
      }),
      { code: "OUTCOME_UNKNOWN" },
    );
    assert.equal(sends, 2);
    assert.equal(f.calls.filter((a) => a[0] === "--bg").length, 1);
  } finally {
    adapter.close();
  }
});

test("repeat wake preserves saved native options instead of requesting a copy", async () => {
  const f = fixture({ existingBackground: true });
  await f.wake.wake(session);
  assert.deepEqual(
    f.calls.find((args) => args[0] === "--bg"),
    ["--bg", "--resume", session.cliSessionId],
  );
});
