import { spawn, type IPty } from "node-pty";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { stateDirectory } from "../config.js";
import { writeJson } from "../files.js";

export class ClaudeWorkers {
  private readonly environments = new Map<
    string,
    { terminal: IPty; environmentId: string; alive: boolean }
  >();
  private readonly resumed = new Map<string, IPty>();
  private binary: string | undefined;
  private async executable() {
    if (this.binary) return this.binary;
    if (process.env.SWITCHBOARD_CLAUDE_BIN)
      return (this.binary = process.env.SWITCHBOARD_CLAUDE_BIN);
    const root = join(
      homedir(),
      "Library/Application Support/Claude/claude-code",
    );
    let versions: string[] = [];
    try {
      versions = (await readdir(root)).filter((value) =>
        /^\d+\.\d+\.\d+$/.test(value),
      );
    } catch {
      /* The standalone CLI is also supported. */
    }
    versions.sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    );
    return (this.binary = versions[0]
      ? join(root, versions[0], "claude.app/Contents/MacOS/claude")
      : join(homedir(), ".local/bin/claude"));
  }
  async environment(cwd: string) {
    const current = this.environments.get(cwd);
    if (current?.alive) return current.environmentId;
    const terminal = spawn(
      await this.executable(),
      [
        "remote-control",
        "--no-create-session-in-dir",
        "--spawn",
        "same-dir",
        "--capacity",
        "8",
        "--permission-mode",
        "default",
      ],
      {
        cwd,
        env: cleanEnvironment(),
        name: "xterm-256color",
        cols: 120,
        rows: 30,
      },
    );
    const environmentId = await waitForOutput({
      terminal,
      pattern: /environment=(env_[A-Za-z0-9]+)/,
    });
    const worker = { terminal, environmentId, alive: true };
    this.environments.set(cwd, worker);
    terminal.onExit(() => {
      worker.alive = false;
    });
    await writeJson({
      path: join(stateDirectory, "workers.json"),
      value: Object.fromEntries(
        [...this.environments].map(([directory, item]) => [
          directory,
          { pid: item.terminal.pid, environment_id: item.environmentId },
        ]),
      ),
    });
    return environmentId;
  }
  async resume({ cwd, nativeId }: { cwd: string; nativeId: string }) {
    if (this.resumed.has(nativeId)) return;
    const terminal = spawn(
      await this.executable(),
      [
        "remote-control",
        "--session-id",
        nativeId,
        "--permission-mode",
        "default",
      ],
      {
        cwd,
        env: cleanEnvironment(),
        name: "xterm-256color",
        cols: 120,
        rows: 30,
      },
    );
    this.resumed.set(nativeId, terminal);
    terminal.onExit(() => this.resumed.delete(nativeId));
    try {
      await waitForOutput({
        terminal,
        pattern: /(claude\.ai\/code\/session_[A-Za-z0-9]+)/,
      });
    } catch (error) {
      this.resumed.delete(nativeId);
      throw error;
    }
  }
  forget(nativeId: string) {
    this.resumed.get(nativeId)?.kill();
    this.resumed.delete(nativeId);
  }
  close() {
    for (const worker of this.environments.values())
      if (worker.alive) worker.terminal.kill();
    for (const terminal of this.resumed.values()) terminal.kill();
  }
}
function cleanEnvironment() {
  return z
    .record(z.string(), z.string())
    .parse(
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    );
}
function waitForOutput({
  terminal,
  pattern,
}: {
  terminal: IPty;
  pattern: RegExp;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      terminal.kill();
      reject(
        new Error(
          "Claude Remote Control did not become ready. Check login and workspace trust.",
        ),
      );
    }, 45_000);
    const dataListener = terminal.onData((data) => {
      output = (output + data).slice(-16_000);
      const match = pattern.exec(output)?.[1];
      if (match) {
        cleanup();
        resolve(match);
      }
    });
    const exitListener = terminal.onExit(() => {
      cleanup();
      reject(
        new Error(
          "Claude Remote Control exited before becoming ready. Check login and workspace trust.",
        ),
      );
    });
    function cleanup() {
      clearTimeout(timer);
      dataListener.dispose();
      exitListener.dispose();
    }
  });
}
