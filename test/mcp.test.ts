import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

test("all six tools retain their arguments and structured error flag over actual stdio", async () => {
  const moduleUrl = new URL("../dist/mcp.js", import.meta.url).href;
  const code = `import {serveMCP} from ${JSON.stringify(moduleUrl)}; await serveMCP(async request => request.arguments.session_id === 'codex:519327f4-fc54-4140-8eef-25e1234bed57' ? {status:'failed',error_code:'SESSION_OWNED_ELSEWHERE',applied:[]} : {status:'accepted',...request});`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", code],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  const client = new Client({ name: "switchboard-test", version: "0.1.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6);
    const validId = "codex:619327f4-fc54-4140-8eef-25e1234bed57";
    const cases = [
      { name: "search_sessions", arguments: { query: "test" } },
      { name: "read_session", arguments: { session_id: validId } },
      {
        name: "create_session",
        arguments: { harness: "codex", prompt: "test", cwd: "/tmp" },
      },
      {
        name: "send_message",
        arguments: { session_id: validId, prompt: "test" },
      },
      {
        name: "update_session",
        arguments: { session_id: validId, archived: true },
      },
      { name: "delete_session", arguments: { session_id: validId } },
    ];
    for (const item of cases) {
      const result = await client.callTool(item);
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent?.operation, item.name);
    }
    const failure = await client.callTool({
      name: "delete_session",
      arguments: { session_id: "codex:519327f4-fc54-4140-8eef-25e1234bed57" },
    });
    assert.equal(failure.isError, true);
    assert.equal(
      failure.structuredContent?.error_code,
      "SESSION_OWNED_ELSEWHERE",
    );
    const invalid = await client.callTool({
      name: "send_message",
      arguments: { session_id: validId, prompt: "" },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
});
