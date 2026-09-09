import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { OperationError } from "../errors.js";

const messageSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    method: z.string().optional(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number(), message: z.string() }).optional(),
  })
  .loose();
export class CodexEngine {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private nextId = 0;
  private exited = false;
  private readonly ready: Promise<unknown>;
  constructor() {
    const desktopBinary = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const binary =
      process.env.SWITCHBOARD_CODEX_BIN ??
      (existsSync(desktopBinary) ? desktopBinary : "codex");
    this.process = spawn(binary, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stderr.resume();
    createInterface({ input: this.process.stdout }).on("line", (line) =>
      this.receive(line),
    );
    this.process.on("error", () => this.failPending());
    this.process.on("exit", () => this.failPending());
    this.process.stdin.on("error", () => this.failPending());
    this.ready = this.request({
      method: "initialize",
      params: {
        clientInfo: { name: "switchboard", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
    }).then((result) => {
      this.write({ method: "initialized" });
      return result;
    });
    void this.ready.catch(() => {});
  }
  async call({
    method,
    params,
  }: {
    method: string;
    params: unknown;
  }): Promise<unknown> {
    await this.ready;
    return this.request({ method, params });
  }
  private request({
    method,
    params,
  }: {
    method: string;
    params: unknown;
  }): Promise<unknown> {
    if (this.exited)
      return Promise.reject(
        new OperationError(
          "ENGINE_UNAVAILABLE",
          "Codex engine exited. Restart Switchboard before continuing.",
        ),
      );
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new OperationError(
            "OUTCOME_UNKNOWN",
            `${method} timed out; do not automatically retry.`,
          ),
        );
      }, 40_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }
  private write(message: unknown) {
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  private receive(line: string) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = messageSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.method) {
      if (message.id !== undefined)
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message:
              "Switchboard cannot answer native approvals or user-input requests. Continue in the owning app.",
          },
        });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const isOwnershipConflict =
        message.error.code === -32600 &&
        message.error.message.includes("already has an active writer");
      pending.reject(
        new OperationError(
          isOwnershipConflict ? "SESSION_OWNED_ELSEWHERE" : "PROVIDER_ERROR",
          message.error.message,
        ),
      );
    } else pending.resolve(message.result);
  }
  private failPending() {
    this.exited = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new OperationError(
          "OUTCOME_UNKNOWN",
          "Codex engine disconnected; an outstanding operation may have been delivered.",
        ),
      );
    }
    this.pending.clear();
  }
  close() {
    this.process.kill();
  }
}
