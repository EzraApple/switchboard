import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { findClaudeExecutable } from "../src/adapters/claude-workers.js";
import { queryWorker } from "../src/adapters/claude-worker-host.js";

const run = promisify(execFile);
test("Claude PTY host survives launcher exit and accepts another client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sb-worker-"));
  const socket = join(directory, "host.sock");
  const binary = join(directory, "fake-worker");
  const key = "persistence-test";
  await writeFile(
    binary,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$0.args"\nprintf "environment=env_persistence\\n"\nsleep 60\n',
    { mode: 0o700 },
  );
  const hostPath = fileURLToPath(
    new URL("../src/adapters/claude-worker-host.ts", import.meta.url),
  );
  const launcher = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,${JSON.stringify(["--import", "tsx", hostPath, socket, key, binary, directory])},{detached:true,stdio:'ignore'});p.unref();`;
  let state;
  try {
    await run(process.execPath, ["-e", launcher]);
    for (let i = 0; i < 100; i++) {
      try {
        state = await queryWorker(socket, key);
        if (state.status === "ready") break;
      } catch {}
      await delay(50);
    }
    assert.equal(state?.status, "ready");
    assert.equal(state?.value, "env_persistence");
    const args = (await readFile(`${binary}.args`, "utf8")).trim().split("\n");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
    const second = await queryWorker(socket, key);
    assert.equal(second.pid, state.pid);
    assert.equal(second.value, state.value);
    await assert.rejects(
      queryWorker(socket, "incorrect-identity"),
      /closed without a reply/,
    );
    assert.equal((await queryWorker(socket, key)).status, "ready");
  } finally {
    await queryWorker(socket, key, true).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("ClaudeWorkers reuses its host after close and a fresh manager process", async () => {
  const directory = await mkdtemp("/tmp/sb-reuse-");
  const binary = join(directory, "fake-worker");
  const statePath = join(directory, "state");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf "environment=env_reused\\n"\nsleep 60\n',
    { mode: 0o700 },
  );
  const modulePath = new URL(
    "../dist/adapters/claude-workers.js",
    import.meta.url,
  ).href;
  const script = `const {ClaudeWorkers}=await import(${JSON.stringify(modulePath)});const manager=new ClaudeWorkers();console.log(await manager.environment(${JSON.stringify(directory)}));manager.close();`;
  const environment = {
    ...process.env,
    SWITCHBOARD_STATE_DIR: statePath,
    SWITCHBOARD_CLAUDE_BIN: binary,
  };
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256")
    .update(`cwd:auto:${directory}`)
    .digest("hex")
    .slice(0, 24);
  const socket = join(statePath, "worker-hosts", `${key}.sock`);
  try {
    assert.equal(
      (
        await run(process.execPath, ["--input-type=module", "-e", script], {
          env: environment,
        })
      ).stdout.trim(),
      "env_reused",
    );
    const before = await queryWorker(socket, key);
    assert.equal(
      (
        await run(process.execPath, ["--input-type=module", "-e", script], {
          env: environment,
        })
      ).stdout.trim(),
      "env_reused",
    );
    assert.equal((await queryWorker(socket, key)).pid, before.pid);
  } finally {
    await queryWorker(socket, key, true).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("worker launches rediscover Claude after Desktop upgrades and ignore incomplete versions", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-versions-"));
  const binary = (version: string) =>
    join(root, version, "claude.app/Contents/MacOS/claude");
  try {
    await mkdir(join(binary("2.1.9"), ".."), { recursive: true });
    await writeFile(binary("2.1.9"), "old");
    assert.equal(
      await findClaudeExecutable(root, "/fallback"),
      binary("2.1.9"),
    );
    await mkdir(join(binary("2.1.10"), ".."), { recursive: true });
    await writeFile(binary("2.1.10"), "new");
    await rm(join(root, "2.1.9"), { recursive: true });
    await mkdir(join(root, "2.1.11"));
    assert.equal(
      await findClaudeExecutable(root, "/fallback"),
      binary("2.1.10"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
