import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopSession } from "./claude-desktop-store.js";

/** Read a bounded tail and expose text blocks only, never reasoning or tool data. */
export async function readClaudeTranscript(
  session: DesktopSession,
  limit: number,
) {
  const path = claudeTranscriptPath(session);
  if (!path) return;
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const stat = await file.stat();
    const size = Math.min(stat.size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read(buffer, 0, size, stat.size - size);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (stat.size > size) lines.shift();
    const messages = lines.flatMap(parseMessages);
    return {
      messages: messages.slice(-limit),
      history_source: "claude_local_transcript",
      history_tail_bytes: size,
    };
  } finally {
    await file.close();
  }
}

export function claudeTranscriptPath(session: DesktopSession) {
  if (!session.cliSessionId || !/^[0-9a-f-]{36}$/.test(session.cliSessionId))
    return;
  return join(
    homedir(),
    ".claude/projects",
    session.cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    `${session.cliSessionId}.jsonl`,
  );
}
export async function readClaudeSearchText(path: string) {
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  const text: string[] = [];
  for await (const line of reader)
    for (const message of parseMessages(line)) text.push(message.text);
  return text.join("\n");
}
function parseMessages(line: string) {
  try {
    const row = JSON.parse(line);
    if (
      (row.type !== "user" && row.type !== "assistant") ||
      row.isMeta === true
    )
      return [];
    const content: unknown = row.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .flatMap((part) =>
                part?.type === "text" && typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : "";
    return text
      ? [
          {
            role: row.type as string,
            text,
            timestamp: row.timestamp,
            uuid: row.uuid,
          },
        ]
      : [];
  } catch {
    return [];
  }
}
