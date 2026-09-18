import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { SessionSearchIndex } from "../src/search.js";
import { CodexStore } from "../src/adapters/codex-store.js";
import { readClaudeSearchText } from "../src/adapters/claude-transcript.js";
import { SessionQueue } from "../src/queue.js";
import type { Summary } from "../src/contracts.js";
const summary = (id: string, title: string, updated_at = 1): Summary => ({
  session_id: id,
  native_id: id,
  harness: "codex",
  title,
  archived: false,
  updated_at,
});

test("search ranks conversation content, stems words, returns snippets, and refreshes changed documents", async () => {
  const index = new SessionSearchIndex(":memory:");
  const sessions = [
    summary("a", "past discussion"),
    summary("b", "recent unrelated", 100),
  ];
  let reads = 0;
  const read = async () => {
    reads++;
    return "We fixed reconnecting workers with a retry after upgrades.";
  };
  try {
    await index.sync(sessions[0]!, "v1", read);
    await index.sync(sessions[0]!, "v1", read);
    await index.sync(sessions[1]!, "v1", async () => "lunch plans");
    assert.equal(reads, 1);
    const found = index.search("how did we reconnect a worker", sessions, 10);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.session_id, "a");
    assert.match(String(found[0]!.match_snippet), /\[reconnecting\]/);
    assert.equal(index.search("", sessions, 1)[0]!.session_id, "b");
    await index.sync(sessions[0]!, "v2", async () => "different conversation");
    assert.deepEqual(index.search("reconnect", sessions, 10), []);
    assert.deepEqual(index.search('" OR * --', sessions, 10), []);
  } finally {
    index.close();
  }
});

test("Codex searches old text beyond the read limit, excludes reasoning, refreshes appends, and filters archives before limiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-search-"));
  const index = new SessionSearchIndex(":memory:");
  const store = new CodexStore(root, index);
  const path = join(root, "rollout.jsonl");
  const message = (text: string, phase = "final") =>
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase,
        content: [{ type: "output_text", text }],
      },
    });
  try {
    const db = new DatabaseSync(join(root, "state_5.sqlite"));
    db.exec(
      "CREATE TABLE threads (id TEXT, name TEXT, title TEXT, cwd TEXT, archived INTEGER, updated_at INTEGER, source TEXT, rollout_path TEXT)",
    );
    db.prepare(
      "INSERT INTO threads VALUES (?, NULL, 'ordinary title', '/project', ?, 1, 'cli', ?)",
    ).run("519327f4-fc54-4140-8eef-25e1234bed57", 0, path);
    db.prepare(
      "INSERT INTO threads VALUES (?, NULL, 'archived quasar', '/project', ?, 2, 'cli', ?)",
    ).run("519327f4-fc54-4140-8eef-25e1234bed58", 1, path);
    db.close();
    await writeFile(
      path,
      [
        message("quasar database fix"),
        message("secretreasoning", "analysis"),
        ...Array.from({ length: 120 }, () => message("ordinary reply")),
      ].join("\n") + "\n",
    );
    const found = await store.search({
      query: "quasar",
      archived: false,
      limit: 1,
    });
    assert.equal(found.sessions.length, 1);
    assert.equal(found.sessions[0]!.archived, false);
    assert.match(String(found.sessions[0]!.match_snippet), /quasar/);
    assert.deepEqual(
      (
        await store.search({
          query: "secretreasoning",
          archived: false,
          limit: 10,
        })
      ).sessions,
      [],
    );
    await appendFile(path, message("newuniqueterm") + '\n{"partial":');
    assert.equal(
      (
        await store.search({
          query: "newuniqueterm",
          archived: false,
          limit: 10,
        })
      ).sessions.length,
      1,
    );
    assert.equal(
      (await store.search({ query: "quasar", archived: true, limit: 10 }))
        .sessions[0]!.archived,
      true,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude full transcript search excludes thinking, tool results, and metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "sb-claude-search-"));
  try {
    const path = join(root, "chat.jsonl");
    await writeFile(
      path,
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "secret" },
              { type: "text", text: "visible reply" },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "private output" }],
          },
        },
        {
          type: "user",
          isMeta: true,
          message: { content: "injected context" },
        },
        { type: "user", message: { content: "visible question" } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    assert.equal(
      await readClaudeSearchText(path),
      "visible reply\nvisible question",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session mutations remain ordered while unrelated sessions proceed after a failure", async () => {
  const queue = new SessionQueue();
  let release!: () => void;
  const events: string[] = [];
  const slow = queue.run("a", async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    events.push("first");
    throw new Error("failed");
  });
  const rejected = assert.rejects(slow, /failed/);
  const same = queue.run("a", async () => {
    events.push("second");
  });
  await queue.run("b", async () => {
    events.push("unrelated");
  });
  assert.deepEqual(events, ["unrelated"]);
  release();
  await rejected;
  await same;
  assert.deepEqual(events, ["unrelated", "first", "second"]);
});
