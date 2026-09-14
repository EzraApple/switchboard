import { connect, type Socket } from "node:net";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { codexHome } from "../config.js";
import { isErrno } from "../files.js";
import { OperationError } from "../errors.js";

const responseSchema = z
  .object({
    type: z.string(),
    requestId: z.string().optional(),
    resultType: z.string().optional(),
    error: z.string().optional(),
    handledByClientId: z.string().optional(),
    result: z.unknown().optional(),
  })
  .loose();
type Response = z.infer<typeof responseSchema>;
export class DesktopUnavailableError extends Error {}
export class DesktopRejection extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}
export class CodexIPC {
  private clientId = "initializing-client";
  private readonly pending = new Map<
    string,
    {
      resolve: (result: Response) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private buffer: Buffer = Buffer.alloc(0);
  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", () => this.failPending());
    socket.on("close", () => this.failPending());
  }
  static async open(home = codexHome) {
    const path = join(home, "ipc/ipc.sock");
    try {
      const info = await lstat(path);
      if (!info.isSocket() || info.uid !== process.getuid?.())
        throw new Error("Codex IPC must be a socket owned by the current user");
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw new DesktopUnavailableError("Codex Desktop IPC is not running");
      throw error;
    }
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DesktopUnavailableError("Desktop connection did not open"));
      }, 15_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(
          isErrno(error, "ENOENT") || isErrno(error, "ECONNREFUSED")
            ? new DesktopUnavailableError("Codex Desktop IPC is not running")
            : error,
        );
      });
    });
    const client = new CodexIPC(socket);
    try {
      const result = await client.request({
        method: "initialize",
        params: { clientType: "switchboard" },
        version: 0,
      });
      client.clientId = z
        .object({ clientId: z.string() })
        .parse(result.result).clientId;
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  request({
    method,
    params,
    version = 1,
    targetClientId,
  }: {
    method: string;
    params: unknown;
    version?: number;
    targetClientId?: string;
  }): Promise<Response> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new OperationError(
            "OUTCOME_UNKNOWN",
            "Desktop IPC timed out; do not automatically resend.",
          ),
        );
      }, 32_000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.write({
        type: "request",
        requestId,
        sourceClientId: this.clientId,
        method,
        version,
        params,
        timeoutMs: 30_000,
        ...(targetClientId ? { targetClientId } : {}),
      });
    });
  }
  broadcast({
    method,
    params,
    version = 0,
  }: {
    method: string;
    params: unknown;
    version?: number;
  }) {
    this.write({
      type: "broadcast",
      method,
      params,
      version,
      sourceClientId: this.clientId,
    });
  }
  private write(value: unknown) {
    const body = Buffer.from(JSON.stringify(value));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    this.socket.write(frame);
  }
  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size > 32 * 1024 * 1024) {
        this.close();
        return;
      }
      if (this.buffer.length < size + 4) return;
      const frame = this.buffer.subarray(4, size + 4);
      this.buffer = this.buffer.subarray(size + 4);
      let parsed: ReturnType<typeof responseSchema.safeParse>;
      try {
        parsed = responseSchema.safeParse(JSON.parse(frame.toString()));
      } catch {
        this.close();
        return;
      }
      if (
        !parsed.success ||
        parsed.data.type !== "response" ||
        !parsed.data.requestId
      )
        continue;
      const response = parsed.data,
        pending = this.pending.get(parsed.data.requestId);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(parsed.data.requestId);
      if (response.resultType !== "success")
        pending.reject(
          new DesktopRejection(response.error ?? "Desktop rejected request"),
        );
      else pending.resolve(response);
    }
  }
  async findOwner(nativeId: string): Promise<string | null> {
    try {
      const owner = await this.request({
        method: "thread-owner-discovery",
        params: { hostId: "local", conversationId: nativeId },
      });
      return owner.handledByClientId ?? null;
    } catch (error) {
      if (
        error instanceof DesktopRejection &&
        error.reason === "no-client-found"
      )
        return null;
      throw error;
    }
  }
  async send({
    nativeId,
    prompt,
    cwd,
    active,
  }: {
    nativeId: string;
    prompt: string;
    cwd: string;
    active: boolean;
  }) {
    const ownerId = await this.findOwner(nativeId);
    if (!ownerId) throw new DesktopRejection("no-client-found");
    const input = [{ type: "text", text: prompt, text_elements: [] }];
    if (!active)
      return this.request({
        method: "thread-follower-start-turn",
        version: 2,
        targetClientId: ownerId,
        params: {
          conversationId: nativeId,
          turnStart: {
            request: { threadId: nativeId, input },
            context: { inheritThreadSettings: true },
          },
        },
      });
    const messageId = randomUUID();
    return this.request({
      method: "thread-follower-steer-turn",
      targetClientId: ownerId,
      params: {
        conversationId: nativeId,
        input,
        restoreMessage: {
          id: messageId,
          text: prompt,
          cwd,
          createdAt: Date.now(),
          context: {
            prompt,
            addedFiles: [],
            fileAttachments: [],
            ideContext: null,
            imageAttachments: [],
            workspaceRoots: [cwd],
          },
        },
        attachments: [],
        clientUserMessageId: messageId,
      },
    });
  }
  private failPending() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new OperationError(
          "OUTCOME_UNKNOWN",
          "Desktop connection closed; delivery may have occurred.",
        ),
      );
    }
    this.pending.clear();
  }
  close() {
    this.socket.end();
    this.socket.destroySoon();
    this.failPending();
  }
}
