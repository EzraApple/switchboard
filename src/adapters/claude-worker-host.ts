import { createServer, createConnection } from "node:net";
import { spawn } from "node-pty";
import { chmod } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const workerStateSchema = z.object({
  key: z.string(),
  pid: z.number(),
  status: z.enum(["starting", "ready", "failed"]),
  value: z.string().optional(),
  error: z.string().optional(),
});
export type WorkerState = z.infer<typeof workerStateSchema>;

export async function queryWorker(
  socketPath: string,
  key: string,
  stop = false,
) {
  return new Promise<WorkerState>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(
      () => finish(new Error("Claude worker host timed out")),
      2000,
    );
    function finish(error?: Error, state?: WorkerState) {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(state!);
    }
    socket.once("error", finish);
    socket.once("connect", () =>
      socket.write(JSON.stringify({ key, stop }) + "\n"),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 8192)
        return finish(new Error("Claude worker host reply too large"));
      if (!buffer.includes("\n")) return;
      try {
        const state = workerStateSchema.parse(
          JSON.parse(buffer.split("\n")[0]!),
        );
        if (state.key !== key)
          throw new Error("Claude worker host identity mismatch");
        finish(undefined, state);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("end", () => {
      if (!buffer.includes("\n"))
        finish(new Error("Claude worker host closed without a reply"));
    });
  });
}

export async function runWorkerHost(input: {
  socketPath: string;
  key: string;
  binary: string;
  cwd: string;
  nativeId?: string;
}) {
  let state: WorkerState = {
    key: input.key,
    pid: process.pid,
    status: "starting",
  };
  let terminal: ReturnType<typeof spawn> | undefined;
  let output = "";
  let stopping = false;
  const server = createServer((socket) => {
    let request = "";
    socket.setTimeout(2000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      request += chunk.toString();
      if (request.length > 1024) return socket.destroy();
      if (!request.includes("\n")) return;
      try {
        const message = JSON.parse(request.split("\n")[0]!);
        if (message.key !== input.key) return socket.destroy();
        socket.end(JSON.stringify(state) + "\n");
        if (message.stop === true) stop();
      } catch {
        socket.destroy();
      }
    });
  });
  function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    terminal?.kill();
    server.close();
  }
  const timer = setTimeout(() => {
    state = {
      ...state,
      status: "failed",
      error: `Claude Remote Control did not become ready. ${startupDiagnostic(output)}`,
    };
    terminal?.kill();
  }, 45000);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, resolve);
  });
  await chmod(input.socketPath, 0o600);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const args = input.nativeId
      ? [
          "remote-control",
          "--session-id",
          input.nativeId,
          "--permission-mode",
          "auto",
        ]
      : [
          "remote-control",
          "--no-create-session-in-dir",
          "--spawn",
          "same-dir",
          "--capacity",
          "8",
          "--permission-mode",
          "auto",
        ];
    terminal = spawn(input.binary, args, {
      cwd: input.cwd,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      name: "xterm-256color",
      cols: 120,
      rows: 30,
    });
    terminal.onData((data) => {
      if (data.includes("\u001b[6n")) terminal!.write("\u001b[1;1R");
      if (data.includes("\u001b[c")) terminal!.write("\u001b[?1;2c");
      output = (output + data).slice(-16000);
      const pattern = input.nativeId
        ? /(claude\.ai\/code\/session_[A-Za-z0-9]+)/
        : /environment=(env_[A-Za-z0-9]+)/;
      const match = pattern.exec(stripVTControlCharacters(output))?.[1];
      if (match && state.status === "starting") {
        clearTimeout(timer);
        state = { ...state, status: "ready", value: match };
      }
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (stopping) return;
      state = {
        ...state,
        status: "failed",
        error:
          state.error ??
          `Claude Remote Control exited (exit ${exitCode}). ${startupDiagnostic(output)}`,
      };
      setTimeout(stop, 3000);
    });
  } catch (error) {
    clearTimeout(timer);
    state = { ...state, status: "failed", error: String(error) };
    setTimeout(stop, 3000);
  }
}

export function startupDiagnostic(output: string) {
  const plain = stripVTControlCharacters(output);
  const lines = plain
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) =>
      /error|not trusted|cannot|could not|invalid|not found|expired|failed|reattach|resume|session.id/i.test(
        line,
      ),
    );
  return (
    (lines.length ? lines : [plain])
      .slice(-4)
      .join(" ")
      .replace(/https?:\/\/\S+/g, "[URL]")
      .replace(/(?:sk-ant-|Bearer\s+)\S+/gi, "[redacted]")
      .slice(-1000) || "Check login and workspace trust."
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [socketPath, key, binary, cwd, nativeId] = process.argv.slice(2);
  if (!socketPath || !key || !binary || !cwd)
    throw new Error("Missing Claude worker host arguments");
  await runWorkerHost({ socketPath, key, binary, cwd, nativeId });
}
