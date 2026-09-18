import { spawn } from "node:child_process";
import { mkdir, readdir, unlink, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { stateDirectory } from "../config.js";
import { isErrno } from "../files.js";
import { queryWorker } from "./claude-worker-host.js";
export { startupDiagnostic } from "./claude-worker-host.js";

export class ClaudeWorkers {
  private readonly starting = new Map<string, Promise<string>>();
  environment(cwd: string) {
    return this.ensureWorker(cwd);
  }
  async findEnvironment(cwd: string) {
    const key = workerKey(cwd);
    try {
      const state = await queryWorker(workerSocket(key), key);
      return state.status === "ready" ? state.value : undefined;
    } catch (error) {
      if (isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED"))
        return undefined;
      throw error;
    }
  }
  async resume({ cwd, nativeId }: { cwd: string; nativeId: string }) {
    await this.ensureWorker(cwd, nativeId);
  }
  forget(nativeId: string) {
    const key = workerKey("", nativeId);
    void queryWorker(workerSocket(key), key, true).catch(() => {});
  }
  // Detached hosts own their PTYs so daemon upgrades do not end or archive sessions.
  close() {}

  private ensureWorker(cwd: string, nativeId?: string): Promise<string> {
    const key = workerKey(cwd, nativeId);
    const existing = this.starting.get(key);
    if (existing) return existing;
    const pending = this.startWorker(cwd, key, nativeId).finally(() =>
      this.starting.delete(key),
    );
    this.starting.set(key, pending);
    return pending;
  }
  private async startWorker(cwd: string, key: string, nativeId?: string) {
    const socketPath = workerSocket(key);
    await mkdir(join(stateDirectory, "worker-hosts"), {
      recursive: true,
      mode: 0o700,
    });
    let launch = false;
    try {
      const state = await queryWorker(socketPath, key);
      if (state.status === "ready") return state.value!;
      if (state.status === "failed")
        throw new Error(state.error ?? "Claude worker failed");
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !isErrno(error, "ECONNREFUSED"))
        throw error;
      if (isErrno(error, "ECONNREFUSED"))
        await unlink(socketPath).catch((error) => {
          if (!isErrno(error, "ENOENT")) throw error;
        });
      launch = true;
    }
    if (launch) {
      const host = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./claude-worker-host.js", import.meta.url)),
          socketPath,
          key,
          await findClaudeExecutable(),
          cwd,
          ...(nativeId ? [nativeId] : []),
        ],
        { detached: true, stdio: "ignore", env: process.env },
      );
      host.on("error", () => {});
      host.unref();
    }
    for (let attempt = 0; attempt < 480; attempt++) {
      await delay(100);
      try {
        const state = await queryWorker(socketPath, key);
        if (state.status === "ready") return state.value!;
        if (state.status === "failed")
          throw new Error(state.error ?? "Claude worker failed");
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ECONNREFUSED"))
          throw error;
      }
    }
    throw new Error(
      "Claude worker host did not become ready; no session was created",
    );
  }
}
function workerKey(cwd: string, nativeId?: string) {
  return createHash("sha256")
    .update(nativeId ? `session:${nativeId}` : `cwd:auto:${cwd}`)
    .digest("hex")
    .slice(0, 24);
}
function workerSocket(key: string) {
  return join(stateDirectory, "worker-hosts", `${key}.sock`);
}

export async function findClaudeExecutable(
  root = join(homedir(), "Library/Application Support/Claude/claude-code"),
  fallback = join(homedir(), ".local/bin/claude"),
) {
  if (process.env.SWITCHBOARD_CLAUDE_BIN)
    return process.env.SWITCHBOARD_CLAUDE_BIN;
  let versions: string[] = [];
  try {
    versions = (await readdir(root)).filter((value) =>
      /^\d+\.\d+\.\d+$/.test(value),
    );
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  versions.sort((left, right) =>
    right.localeCompare(left, undefined, { numeric: true }),
  );
  for (const version of versions) {
    const binary = join(root, version, "claude.app/Contents/MacOS/claude");
    try {
      await access(binary);
      return binary;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
  return fallback;
}
