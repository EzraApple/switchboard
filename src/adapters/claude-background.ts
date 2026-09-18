import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { OperationError, errorMessage } from "../errors.js";
import { workspaceDirectory } from "../files.js";
import { SessionQueue } from "../queue.js";
import { findClaudeExecutable } from "./claude-workers.js";
import { claudeTranscriptPath } from "./claude-transcript.js";
import type {
  ClaudeDesktopStore,
  DesktopSession,
} from "./claude-desktop-store.js";

const exec = promisify(execFile);
const agentsSchema = z.array(
  z.object({
    id: z.string().optional(),
    sessionId: z.string(),
    cwd: z.string(),
    kind: z.string(),
    pid: z.number().optional(),
  }),
);
type Run = (binary: string, args: string[], cwd: string) => Promise<string>;
const run: Run = async (binary, args, cwd) =>
  (
    await exec(binary, args, {
      cwd,
      timeout: 20_000,
      maxBuffer: 512 * 1024,
      env: process.env,
    })
  ).stdout;

/** Wake the original CLI conversation without sending a prompt or opening Desktop. */
export class ClaudeBackground {
  private readonly queue = new SessionQueue();
  private readonly supported = new Set<string>();
  constructor(
    private readonly desktop: Pick<ClaudeDesktopStore, "list">,
    private readonly options: {
      executable?: () => Promise<string>;
      run?: Run;
      checkTranscript?: (session: DesktopSession) => Promise<void>;
      pause?: () => Promise<void>;
    } = {},
  ) {}
  async wake(session: DesktopSession) {
    if (
      !session.cliSessionId ||
      !z.uuid().safeParse(session.cliSessionId).success
    )
      throw new OperationError(
        "CLAUDE_NOT_CONNECTED",
        "This chat has no local Claude conversation ID to resume. No message was sent.",
      );
    return this.queue.run(session.cliSessionId, () =>
      this.resumeSession(session),
    );
  }
  private async resumeSession(session: DesktopSession) {
    const current = await this.findSession(session);
    if (current.livePid) return this.waitForInbox(current);
    await (this.options.checkTranscript ?? checkTranscript)(current);
    const binary = await (this.options.executable ?? findClaudeExecutable)();
    const command = this.options.run ?? run;
    if (!this.supported.has(binary)) {
      const help = await command(binary, ["--help"], current.cwd);
      if (!/--bg\b/.test(help) || !/--resume\b/.test(help))
        throw new OperationError(
          "CLAUDE_BACKGROUND_UNSUPPORTED",
          "Update Claude Code to a version supporting --bg --resume to wake dormant chats. No message was sent.",
        );
      this.supported.add(binary);
    }
    const before = agentsSchema.parse(
      JSON.parse(
        await command(binary, ["agents", "--json", "--all"], current.cwd),
      ),
    );
    if (
      before.some(
        (agent) => agent.sessionId === current.cliSessionId && agent.pid,
      )
    )
      return this.waitForInbox(current);
    const latest = await this.findSession(current);
    if (latest.livePid) return this.waitForInbox(latest);
    const existingBackground = before.some(
      (agent) =>
        agent.sessionId === current.cliSessionId && agent.kind === "background",
    );
    // Existing background sessions retain their saved options; extra flags request a copy.
    const args = [
      "--bg",
      "--resume",
      current.cliSessionId!,
      ...(existingBackground ? [] : ["--no-chrome"]),
    ];
    // No initial prompt: native resume can fork if Desktop wins the startup race.
    // Verify the resulting full identity before allowing any message through.
    let output: string;
    try {
      output = await command(binary, args, current.cwd);
    } catch (error) {
      throw new OperationError(
        "CLAUDE_WAKE_UNCONFIRMED",
        `Claude background startup failed or timed out (${errorMessage(error)}). It may have started; inspect before retrying. No message was sent.`,
      );
    }
    const launchedId = /backgrounded\s*·\s*([a-zA-Z0-9_-]+)/.exec(
      stripVTControlCharacters(output),
    )?.[1];
    const after = agentsSchema.parse(
      JSON.parse(
        await command(binary, ["agents", "--json", "--all"], current.cwd),
      ),
    );
    const matches = launchedId
      ? after.filter((agent) => agent.id === launchedId)
      : [];
    const launched = matches.length === 1 ? matches[0] : undefined;
    if (
      !launched ||
      launched.sessionId !== current.cliSessionId ||
      launched.cwd !== current.cwd
    ) {
      if (
        launched?.kind === "background" &&
        launched.cwd === current.cwd &&
        !before.some((agent) => agent.sessionId === launched.sessionId)
      ) {
        await command(binary, ["stop", launched.id!], current.cwd);
      }
      throw new OperationError(
        "CLAUDE_WAKE_IDENTITY_MISMATCH",
        "Claude did not confirm resuming the original conversation. No message was sent; inspect the session before retrying.",
      );
    }
    return this.waitForInbox(current);
  }
  private async findSession(expected: DesktopSession) {
    const current = (await this.desktop.list()).find(
      (row) => row.sessionId === expected.sessionId,
    );
    if (
      !current ||
      current.cliSessionId !== expected.cliSessionId ||
      current.cwd !== expected.cwd
    )
      throw new OperationError(
        "CLAUDE_SESSION_CHANGED",
        "Claude's saved conversation changed during wake. Refresh before sending; no message was sent.",
      );
    if (current.isArchived)
      throw new Error("Unarchive the session before sending");
    return current;
  }
  private async waitForInbox(session: DesktopSession) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const current = await this.findSession(session);
      if (current.livePid && current.messagingSocketPath && current.procStart)
        return current;
      await (this.options.pause ?? (() => delay(250)))();
    }
    throw new OperationError(
      "CLAUDE_WAKE_NOT_READY",
      "Claude started but its original conversation has no ready peer inbox. Check Claude for workspace trust or login prompts. No message was sent.",
    );
  }
}
async function checkTranscript(session: DesktopSession) {
  await workspaceDirectory(session.cwd);
  const path = claudeTranscriptPath(session);
  if (!path || !(await stat(path).catch(() => undefined))?.isFile())
    throw new OperationError(
      "CLAUDE_TRANSCRIPT_UNAVAILABLE",
      "The original local Claude transcript is unavailable. Cannot resume this chat; no message was sent.",
    );
}
