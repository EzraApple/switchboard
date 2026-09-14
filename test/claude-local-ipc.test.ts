import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeLocalIPC } from "../src/adapters/claude-local-ipc.js";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import type { DesktopSession } from "../src/adapters/claude-desktop-store.js";
import { OperationError } from "../src/errors.js";

test("local IPC authenticates as peer, targets original session, and makes no delivery claim", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sb-ipc-"));
  const socket = join(directory, "test.sock");
  const procStart = execFileSync(
    "/bin/ps",
    ["-p", String(process.pid), "-o", "lstart="],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
  ).trim();
  const owner: DesktopSession = {
    sessionId: "local_9a349f59-29ed-4610-9891-5c4d2123fb17",
    cliSessionId: "f62a5406-d112-4106-990d-08e0e44901c8",
    cwd: directory,
    title: "test",
    isArchived: false,
    bridgeSessionIds: [],
    livePid: process.pid,
    procStart,
    messagingSocketPath: socket,
  };
  const frames: Record<string, any>[] = [];
  const server = createServer((connection) => {
    let data = "";
    connection.on("data", (part) => {
      data += part;
    });
    connection.on("end", () => {
      frames.push(
        ...data
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
      connection.end();
    });
  });
  await new Promise<void>((done) => server.listen(socket, done));
  try {
    const key = join(
      directory,
      `${process.pid}.${createHash("sha256").update(socket).digest("hex")}.key`,
    );
    await writeFile(
      key,
      JSON.stringify({ peerToken: "a".repeat(32), procStart }),
      { mode: 0o600 },
    );
    const ipc = new ClaudeLocalIPC(directory);
    const result = await ipc.send(owner, "2+2=?");
    assert.equal(result.delivery, "unconfirmed");
    assert.equal(frames[0].type, "auth");
    assert.equal(frames[0].token, "a".repeat(32));
    assert.equal(frames[1].session_id, owner.cliSessionId);
    assert.equal(frames[1].from, "switchboard");
    assert.match(frames[1].message.content, /from-name="Switchboard"/);
    assert.equal(JSON.stringify(result).includes("a".repeat(32)), false);
    await assert.rejects(
      ipc.send({ ...owner, procStart: "stale" }, "again"),
      /owner process changed/,
    );
    assert.equal(frames.length, 2);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("local-only Desktop routing uses its owner without API and never falls back after uncertainty", async () => {
  const local: DesktopSession = {
    sessionId: "local_9a349f59-29ed-4610-9891-5c4d2123fb17",
    title: "test",
    cwd: "/tmp/test",
    isArchived: false,
    bridgeSessionIds: [],
    livePid: 123,
    messagingSocketPath: "/tmp/test.sock",
  };
  let sent = 0;
  const adapter = new ClaudeAdapter(
    {
      async request() {
        throw new Error("API must not be called");
      },
    },
    {
      async environment() {
        throw new Error("no worker");
      },
      async resume() {
        throw new Error("no worker");
      },
      forget() {},
      close() {},
    },
    {
      async list() {
        return [local];
      },
    },
    {
      async send(owner) {
        assert.equal(owner, local);
        sent++;
        throw new OperationError("OUTCOME_UNKNOWN", "uncertain local delivery");
      },
    },
  );
  await assert.rejects(
    adapter.send({ session_id: `claude:${local.sessionId}`, prompt: "2+2=?" }),
    /uncertain local delivery/,
  );
  assert.equal(sent, 1);
});
