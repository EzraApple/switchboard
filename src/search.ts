import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { stateDirectory } from "./config.js";
import type { Summary } from "./contracts.js";

export type SearchPage = { sessions: Summary[]; warnings: string[] };
const stopwords = new Set(
  "a an and are as at be by did do for from had has have how i in is it me my of on or our that the their this to was we were what when where which who why with you your".split(
    " ",
  ),
);

/** A private, rebuildable index containing only visible conversation text. */
export class SessionSearchIndex {
  private database?: DatabaseSync;
  constructor(private readonly path = join(stateDirectory, "search.sqlite")) {}
  private get db() {
    if (this.database) return this.database;
    if (this.path !== ":memory:") {
      mkdirSync(join(this.path, ".."), { recursive: true, mode: 0o700 });
    }
    const db = new DatabaseSync(this.path);
    if (this.path !== ":memory:") chmodSync(this.path, 0o600);
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, signature TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS content USING fts5(id UNINDEXED, title, cwd, body, tokenize='porter unicode61');`);
    this.database = db;
    return db;
  }
  async sync(summary: Summary, signature: string, read: () => Promise<string>) {
    const fingerprint = JSON.stringify([signature, summary.title, summary.cwd]);
    const previous = this.db
      .prepare("SELECT signature FROM documents WHERE id = ?")
      .get(summary.session_id);
    if (previous?.signature === fingerprint) return;
    const body = await read();
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM content WHERE id = ?")
        .run(summary.session_id);
      this.db
        .prepare(
          "INSERT INTO content (id, title, cwd, body) VALUES (?, ?, ?, ?)",
        )
        .run(summary.session_id, summary.title, summary.cwd ?? "", body);
      this.db
        .prepare("INSERT OR REPLACE INTO documents VALUES (?, ?)")
        .run(summary.session_id, fingerprint);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  search(query: string, candidates: Summary[], limit: number): Summary[] {
    const words = [
      ...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []),
    ];
    const terms = words.filter((word) => !stopwords.has(word));
    const tokens = terms.length ? terms : words;
    if (!tokens.length)
      return [...candidates].sort(compareSessions).slice(0, limit);
    const match = tokens.map((word) => `"${word}"*`).join(" AND ");
    const byId = new Map(
      candidates.map((session) => [session.session_id, session]),
    );
    return this.db
      .prepare(
        `SELECT id, -bm25(content, 0, 8, 2, 1) AS score,
      snippet(content, -1, '[', ']', ' … ', 40) AS snippet
      FROM content WHERE content MATCH ? ORDER BY bm25(content, 0, 8, 2, 1)`,
      )
      .all(match)
      .flatMap((row) => {
        const summary = byId.get(String(row.id));
        return summary
          ? [
              {
                ...summary,
                relevance_score: Number(row.score),
                match_snippet: String(row.snippet),
              },
            ]
          : [];
      })
      .sort(compareSessions)
      .slice(0, limit);
  }
  remove(sessionId: string) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM content WHERE id = ?").run(sessionId);
      this.db.prepare("DELETE FROM documents WHERE id = ?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.database?.close();
    this.database = undefined;
  }
}
export function compareSessions(left: Summary, right: Summary) {
  return (
    Number(right.relevance_score ?? 0) - Number(left.relevance_score ?? 0) ||
    timestamp(right.updated_at) - timestamp(left.updated_at) ||
    left.session_id.localeCompare(right.session_id)
  );
}
function timestamp(value: Summary["updated_at"]) {
  if (typeof value === "number") return value;
  return typeof value === "string" ? Date.parse(value) / 1000 || 0 : 0;
}
