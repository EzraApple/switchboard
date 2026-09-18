import { DatabaseSync } from "node:sqlite";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { z } from "zod";
import { SessionSearchIndex, compareSessions } from "../search.js";
import { codexHome } from "../config.js";
import { isErrno } from "../files.js";
import { parseSessionId, type Summary } from "../contracts.js";

const rowSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  title: z.string(),
  cwd: z.string(),
  archived: z.number(),
  updated_at: z.number(),
  source: z.string(),
  rollout_path: z.string(),
});
const recordSchema = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  payload: z
    .object({
      type: z.string().optional(),
      turn_id: z.string().optional(),
      role: z.string().optional(),
      phase: z.string().optional(),
      content: z
        .array(
          z.object({ type: z.string(), text: z.string().optional() }).loose(),
        )
        .optional(),
      internal_chat_message_metadata_passthrough: z
        .object({ content_item_kinds: z.array(z.string()).optional() })
        .nullish(),
    })
    .loose(),
});
export type Transcript = {
  status: string;
  turn_id: string | null;
  messages: {
    role: string;
    text: string;
    phase?: string;
    timestamp?: string;
  }[];
};
export class CodexStore {
  constructor(
    private readonly home = codexHome,
    private readonly index = new SessionSearchIndex(),
  ) {}
  forget(sessionId: string) {
    this.index.remove(sessionId);
  }
  close() {
    this.index.close();
  }
  private query({
    sql,
    parameters,
  }: {
    sql: string;
    parameters: (string | number)[];
  }) {
    const database = new DatabaseSync(
      join(process.env.CODEX_SQLITE_HOME ?? this.home, "state_5.sqlite"),
      { readOnly: true },
    );
    try {
      return z.array(rowSchema).parse(database.prepare(sql).all(...parameters));
    } finally {
      database.close();
    }
  }
  get(sessionId: string) {
    const { nativeId } = parseSessionId(sessionId);
    const row = this.query({
      sql: "SELECT * FROM threads WHERE id = ?",
      parameters: [nativeId],
    })[0];
    if (!row) throw new Error("Session not found");
    return row;
  }
  async search({
    query,
    archived,
    limit,
  }: {
    query: string;
    archived: boolean;
    limit: number;
  }) {
    const rows = this.query({
      sql: "SELECT * FROM threads WHERE source IN ('cli', 'vscode', 'app-server') AND archived = ? ORDER BY updated_at DESC",
      parameters: [Number(archived)],
    });
    if (!query.trim())
      return {
        sessions: rows.map(summarize).sort(compareSessions).slice(0, limit),
        warnings: [],
      };
    const warnings: string[] = [];
    const candidates: Summary[] = [];
    for (const row of rows) {
      const summary = summarize(row);
      try {
        const info = await stat(row.rollout_path);
        await this.index.sync(
          summary,
          JSON.stringify([row.rollout_path, info.size, info.mtimeMs]),
          async () =>
            (
              await readTranscript({ path: row.rollout_path, limit: Infinity })
            ).messages
              .map((message) => message.text)
              .join("\n"),
        );
      } catch (error) {
        warnings.push(
          `${summary.session_id}: transcript unavailable; only metadata was searched`,
        );
        await this.index.sync(summary, "unavailable", async () => "");
      }
      candidates.push(summary);
    }
    return { sessions: this.index.search(query, candidates, limit), warnings };
  }
  async read({ session_id, limit }: { session_id: string; limit: number }) {
    const row = this.get(session_id);
    return {
      ...summarize(row),
      ...(await readTranscript({ path: row.rollout_path, limit })),
    };
  }
}
function summarize(row: z.infer<typeof rowSchema>): Summary {
  return {
    session_id: `codex:${row.id}`,
    native_id: row.id,
    harness: "codex",
    title: (row.name || row.title).slice(0, 240),
    cwd: row.cwd,
    archived: Boolean(row.archived),
    updated_at: row.updated_at,
    source: row.source,
  };
}
export async function readTranscript({
  path,
  limit,
}: {
  path: string;
  limit: number;
}): Promise<Transcript> {
  const result: Transcript = { status: "unknown", turn_id: null, messages: [] };
  try {
    await access(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { ...result, status: "pending" };
    throw error;
  }
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) continue;
    const record = parsed.data,
      payload = record.payload;
    if (record.type === "event_msg") {
      if (payload.type === "task_started") {
        result.status = "active";
        result.turn_id = payload.turn_id ?? null;
      } else if (payload.type === "task_complete") result.status = "idle";
      else if (payload.type === "turn_aborted") result.status = "interrupted";
    }
    if (
      record.type !== "response_item" ||
      payload.type !== "message" ||
      payload.phase === "analysis" ||
      !["user", "assistant"].includes(payload.role ?? "")
    )
      continue;
    if (
      payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.some(
        (kind) =>
          [
            "agents_md.instructions",
            "environments.environment_context",
            "plugins.recommendations",
          ].includes(kind),
      )
    )
      continue;
    const text = payload.content
      ?.filter((part) => ["input_text", "output_text"].includes(part.type))
      .flatMap((part) => (part.text ? [part.text] : []))
      .join("\n");
    if (text)
      result.messages.push({
        role: payload.role ?? "user",
        text,
        phase: payload.phase,
        timestamp: record.timestamp,
      });
    if (result.messages.length > limit) result.messages.shift();
  }
  return result;
}
