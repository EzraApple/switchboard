import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const desktopSessionSchema = z.object({
  sessionId: z.string().regex(/^local_[0-9a-f-]{36}$/),
  cliSessionId: z.string().optional(),
  title: z.string().default(""),
  cwd: z.string(),
  isArchived: z.boolean().default(false),
  lastActivityAt: z.number().optional(),
  bridgeSessionIds: z.array(z.string()).default([]),
  remoteControlUserEnabled: z.boolean().optional(),
  livePid: z.number().optional(),
  liveBridgeSessionId: z.string().optional(),
  messagingSocketPath: z.string().optional(),
  procStart: z.string().optional(),
});
export type DesktopSession = z.infer<typeof desktopSessionSchema>;

export function remoteSessionId(id: string) {
  return id.replace(/^session_/, "cse_");
}

/** Read only identity metadata; never return saved prompts or MCP configuration. */
export class ClaudeDesktopStore {
  constructor(
    private readonly root = join(
      homedir(),
      "Library/Application Support/Claude/claude-code-sessions",
    ),
  ) {}

  async list(): Promise<DesktopSession[]> {
    const sessions: DesktopSession[] = [];
    let entries;
    try {
      entries = await readdir(this.root, {
        recursive: true,
        withFileTypes: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^local_.*\.json$/.test(entry.name)) continue;
      try {
        const parsed = desktopSessionSchema.safeParse(
          JSON.parse(
            await readFile(join(entry.parentPath, entry.name), "utf8"),
          ),
        );
        if (parsed.success) sessions.push(parsed.data);
      } catch (error) {
        // A Desktop save can replace a file during discovery. Retry on the next call.
        if (
          error instanceof SyntaxError ||
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
          continue;
        throw error;
      }
    }
    const live = await this.liveSessions();
    return sessions.map((session) => ({
      ...session,
      ...live.get(session.cliSessionId ?? ""),
    }));
  }

  private async liveSessions() {
    const sessions = new Map<
      string,
      {
        livePid: number;
        liveBridgeSessionId?: string;
        messagingSocketPath?: string;
        procStart?: string;
      }
    >();
    const root = join(homedir(), ".claude/sessions");
    let files: string[];
    try {
      files = await readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return sessions;
      throw error;
    }
    for (const file of files) {
      if (!/^\d+\.json$/.test(file)) continue;
      try {
        const row = z
          .object({
            pid: z.number().int().positive(),
            sessionId: z.string(),
            bridgeSessionId: z.string().optional(),
            messagingSocketPath: z.string().optional(),
            procStart: z.string().optional(),
          })
          .parse(JSON.parse(await readFile(join(root, file), "utf8")));
        if (String(row.pid) !== file.slice(0, -5)) continue;
        process.kill(row.pid, 0);
        sessions.set(row.sessionId, {
          livePid: row.pid,
          liveBridgeSessionId: row.bridgeSessionId,
          messagingSocketPath: row.messagingSocketPath,
          procStart: row.procStart,
        });
      } catch {
        /* Stale or torn runtime registrations are not live owners. */
      }
    }
    return sessions;
  }
}
