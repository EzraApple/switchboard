import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { OperationError } from "../errors.js";
import type { DesktopSession } from "./claude-desktop-store.js";
import { claudePeerMessage } from "./claude-message.js";

const run = promisify(execFile);

/** Uses Claude's published peer key, never its privileged child token. */
export class ClaudeLocalIPC {
  constructor(
    private readonly keyDirectory = join(homedir(), ".claude/sessions"),
  ) {}
  async send(session: DesktopSession, prompt: string) {
    const { livePid: pid, messagingSocketPath: socket, procStart } = session;
    if (!pid || !socket || !procStart || !session.cliSessionId)
      throw new OperationError(
        "CLAUDE_NOT_CONNECTED",
        "No verified local Claude owner is available. No message was sent.",
      );
    const { stdout } = await run(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
    );
    if (stdout.trim() !== procStart)
      throw new OperationError(
        "CLAUDE_NOT_CONNECTED",
        "Claude's owner process changed. Refresh before sending; no message was sent.",
      );
    const socketStat = await lstat(socket);
    if (!socketStat.isSocket() || socketStat.uid !== process.getuid?.())
      throw new OperationError(
        "CLAUDE_NOT_CONNECTED",
        "Claude's local socket owner could not be verified. No message was sent.",
      );
    const hash = createHash("sha256").update(resolve(socket)).digest("hex");
    const file = await open(
      join(this.keyDirectory, `${pid}.${hash}.key`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let token: string;
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > 4096
      )
        throw new Error("Claude peer key is not a private regular file");
      const key = JSON.parse(await file.readFile("utf8"));
      if (key.procStart !== procStart || !/^[0-9a-f]{32}$/.test(key.peerToken))
        throw new Error("Claude peer key does not match its live owner");
      token = key.peerToken;
    } finally {
      await file.close();
    }
    const eventId = randomUUID();
    const payload =
      JSON.stringify({ type: "auth", token }) +
      "\n" +
      JSON.stringify({
        type: "user",
        session_id: session.cliSessionId,
        uuid: eventId,
        from: "switchboard",
        priority: "next",
        message: { content: claudePeerMessage(prompt) },
      }) +
      "\n";
    await new Promise<void>((complete, reject) => {
      let attempted = false;
      const connection = createConnection(socket);
      const fail = () => {
        connection.destroy();
        reject(
          new OperationError(
            attempted ? "OUTCOME_UNKNOWN" : "CLAUDE_NOT_CONNECTED",
            attempted
              ? "Claude's local socket closed without a delivery receipt. Inspect the session before retrying."
              : "Could not connect to Claude's local owner. No message was sent.",
          ),
        );
      };
      connection.setTimeout(5000, fail);
      connection.on("error", fail);
      connection.on("connect", () => {
        attempted = true;
        connection.end(payload);
      });
      connection.on("close", (hadError) => {
        if (!hadError && attempted) complete();
      });
    });
    return {
      status: "submitted",
      delivery: "unconfirmed",
      event_id: eventId,
      transport: "claude_local_peer",
      sender: "Switchboard",
      authority: "peer",
      instruction:
        "Claude's peer inbox has no synchronous delivery receipt. Read the session to verify; do not automatically retry.",
    };
  }
}
