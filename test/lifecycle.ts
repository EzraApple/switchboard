import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, open, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const root = fileURLToPath(new URL("..", import.meta.url));
const path = join(
  root,
  "evidence",
  process.argv[2] ?? `typescript-lifecycle-${Date.now()}.json`,
);
await mkdir(join(root, "evidence"), { recursive: true });
await (await open(path, "wx")).close();
const receipt: { tests: Record<string, unknown>[]; tools?: string[] } = {
  tests: [],
};
const save = () => writeFile(path, JSON.stringify(receipt, null, 2));
const cli = process.env.SWITCHBOARD_TEST_CLI ?? join(root, "dist/cli.js");
async function connect() {
  const client = new Client({
    name: "switchboard-lifecycle",
    version: "0.1.0",
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    }),
  );
  return client;
}
async function call(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
) {
  const response = await client.callTool({ name, arguments: arguments_ });
  const data = z
    .record(z.string(), z.unknown())
    .parse(response.structuredContent);
  if (response.isError || data.status === "failed" || data.status === "partial")
    throw new Error(JSON.stringify(data));
  return data;
}
async function expectReply(
  client: Client,
  sessionId: string,
  expected: string,
) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = await call(client, "read_session", {
      session_id: sessionId,
    });
    const messages = z
      .array(z.object({ role: z.string(), text: z.string() }).loose())
      .parse(response.messages);
    if (
      messages.some(
        (message) =>
          message.role === "assistant" && message.text.trim() === expected,
      )
    )
      return;
    await delay(2000);
  }
  throw new Error("Reply not observed: " + expected);
}
for (const { harness, model } of [
  { harness: "codex", model: "gpt-5.6-sol" },
  { harness: "claude", model: "claude-fable-5" },
]) {
  let client = await connect();
  const result: Record<string, unknown> = { harness };
  receipt.tests.push(result);
  await save();
  try {
    receipt.tools = (await client.listTools()).tools.map((tool) => tool.name);
    const title = `switchboard ${harness} test`;
    const created = await call(client, "create_session", {
      harness,
      model,
      title,
      cwd: process.env.SWITCHBOARD_TEST_CWD ?? root,
      prompt:
        "Reply exactly SWITCHBOARD_INITIAL_READY. Do not call tools or edit files.",
    });
    const sessionId = z.string().parse(created.session_id);
    result.session_id = sessionId;
    await save();
    await client.close();
    client = await connect();
    await expectReply(client, sessionId, "SWITCHBOARD_INITIAL_READY");
    result.create_read_after_caller_disconnect = true;
    await save();
    await call(client, "update_session", {
      session_id: sessionId,
      title: `${title} renamed`,
    });
    const found = await call(client, "search_sessions", {
      harness,
      query: `${title} renamed`,
    });
    if (!JSON.stringify(found.sessions).includes(sessionId))
      throw new Error("Renamed session missing");
    result.rename_search = true;
    await save();
    await call(client, "update_session", {
      session_id: sessionId,
      archived: true,
    });
    const archived = await call(client, "search_sessions", {
      harness,
      query: title,
      archived: true,
    });
    if (!JSON.stringify(archived.sessions).includes(sessionId))
      throw new Error("Archived session missing");
    result.archive = true;
    await save();
    await call(client, "update_session", {
      session_id: sessionId,
      archived: false,
    });
    await call(client, "send_message", {
      session_id: sessionId,
      prompt:
        "Reply exactly SWITCHBOARD_RESUMED_READY. Do not call tools or edit files.",
    });
    await expectReply(client, sessionId, "SWITCHBOARD_RESUMED_READY");
    result.unarchive_send_read = true;
    await save();
    await call(client, "delete_session", { session_id: sessionId });
    const deleted = await call(client, "search_sessions", {
      harness,
      query: title,
    });
    if (JSON.stringify(deleted.sessions).includes(sessionId))
      throw new Error("Deleted session still present");
    result.delete_search = true;
    await save();
    console.log(harness, "PASS");
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    await save();
    console.error(harness, "FAIL", result.error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
console.log("Receipt:", path);
