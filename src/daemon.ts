import { createServer, createConnection, type Socket } from "node:net";
import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { stateDirectory, version } from "./config.js";
import { isErrno, writeJson } from "./files.js";
import { OperationError, failure } from "./errors.js";
import { schemas, type Operation, type Result } from "./contracts.js";
import { SessionManager } from "./manager.js";
import { CodexAdapter } from "./adapters/codex.js";
import { ClaudeAdapter } from "./adapters/claude.js";

const socketPath = join(stateDirectory, "bridge.sock");
const limit = 8 * 1024 * 1024;
const operationSchema = z.enum(
  Object.keys(schemas) as [Operation, ...Operation[]],
);
const requestSchema = z.object({
  protocol: z.literal(1),
  operation: operationSchema,
  arguments: z.unknown(),
});
const responseSchema = z.object({
  protocol: z.literal(1),
  result: z.record(z.string(), z.unknown()),
});
const entrypoint = fileURLToPath(new URL("./cli.js", import.meta.url));

export async function callDaemon({
  operation,
  arguments: arguments_,
}: {
  operation: Operation;
  arguments: unknown;
}): Promise<Result> {
  const client = await connectOrStart();
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      client.destroy();
      reject(
        new OperationError(
          "OUTCOME_UNKNOWN",
          "Switchboard timed out; inspect before retrying.",
        ),
      );
    }, 120_000);
    client.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > limit) {
        clearTimeout(timer);
        client.destroy();
        reject(
          new OperationError(
            "OUTCOME_UNKNOWN",
            "Response exceeds size limit; inspect before retrying.",
          ),
        );
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(
          responseSchema.parse(
            JSON.parse(buffer.subarray(0, newline).toString()),
          ).result,
        );
      } catch {
        reject(
          new OperationError(
            "OUTCOME_UNKNOWN",
            "Invalid daemon response; inspect before retrying.",
          ),
        );
      }
      client.end();
    });
    client.on("error", () => {
      clearTimeout(timer);
      reject(
        new OperationError(
          "OUTCOME_UNKNOWN",
          "Switchboard disconnected; delivery may have occurred.",
        ),
      );
    });
    client.on("close", () => {
      clearTimeout(timer);
      reject(
        new OperationError(
          "OUTCOME_UNKNOWN",
          "Switchboard closed the connection; inspect before retrying.",
        ),
      );
    });
    client.write(
      JSON.stringify({ protocol: 1, operation, arguments: arguments_ }) + "\n",
    );
  });
}
async function connect(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}
async function connectOrStart() {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await chmod(stateDirectory, 0o700);
  try {
    return await connect();
  } catch (error) {
    if (!isErrno(error, "ENOENT") && !isErrno(error, "ECONNREFUSED"))
      throw error;
  }
  const lockPath = join(stateDirectory, "startup.lock");
  for (let attempt = 0; attempt < 200; attempt++) {
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      try {
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        const pid = Number(await readFile(lockPath, "utf8"));
        if (
          age > 5000 &&
          (!Number.isInteger(pid) || pid <= 0 || !processExists(pid))
        )
          await unlink(lockPath);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
      await delay(100);
      continue;
    }
    try {
      await lock.writeFile(String(process.pid));
      try {
        return await connect();
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ECONNREFUSED"))
          throw error;
      }
      await unlink(socketPath).catch((error) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
      const log = await open(join(stateDirectory, "daemon.log"), "a", 0o600);
      const process_ = spawn(process.execPath, [entrypoint, "daemon"], {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
        env: process.env,
      });
      process_.on("error", () => {});
      process_.unref();
      await log.close();
      for (let poll = 0; poll < 150; poll++) {
        try {
          return await connect();
        } catch (error) {
          if (!isErrno(error, "ENOENT") && !isErrno(error, "ECONNREFUSED"))
            throw error;
        }
        await delay(100);
      }
      throw new Error(
        "Switchboard daemon did not start; inspect its daemon.log",
      );
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error("Another process holds the Switchboard startup lock");
}
function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}
export async function serveDaemon() {
  const manager = new SessionManager({
    codex: new CodexAdapter(),
    claude: new ClaudeAdapter(),
  });
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0),
      dispatched = false;
    socket.on("error", () => {});
    socket.setTimeout(130_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (dispatched) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > limit) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      dispatched = true;
      void (async () => {
        let result: Result;
        try {
          const request = requestSchema.parse(
            JSON.parse(buffer.subarray(0, newline).toString()),
          );
          result = await manager.execute(request);
        } catch (error) {
          result = failure({ error });
        }
        const response = JSON.stringify({ protocol: 1, result }) + "\n";
        if (Buffer.byteLength(response) > limit)
          socket.end(
            JSON.stringify({
              protocol: 1,
              result: failure({
                error: new OperationError(
                  "OUTCOME_UNKNOWN",
                  "Result too large; inspect using a smaller read limit.",
                ),
              }),
            }) + "\n",
          );
        else socket.end(response);
      })().catch((error) => {
        console.error(
          error instanceof Error ? error.message : "Request failed",
        );
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  await writeJson({
    path: join(stateDirectory, "daemon.json"),
    value: { pid: process.pid, version, entrypoint },
  });
  const close = () => {
    manager.close();
    server.close();
    void unlink(socketPath).finally(() => process.exit(0));
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
