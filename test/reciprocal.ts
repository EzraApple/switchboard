import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFile, open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
const receiptPath = join(root, "evidence/reciprocal-dispatch.json");
await (await open(receiptPath, "wx")).close();
const cwd = process.env.SWITCHBOARD_TEST_CWD;
if (!cwd)
  throw new Error("Set SWITCHBOARD_TEST_CWD to the trusted test directory");
const leafPrompt =
  "Reply exactly SWITCHBOARD_CLAUDE_CREATED_BY_CODEX. Do not call tools or edit files.";
const codexPrompt = `This is an authorized local Switchboard integration test. Use the installed switchboard MCP tools for all session operations; do not use a CLI or Codex-specific task tools as a substitute. Create exactly one Claude session with harness claude, model claude-fable-5, cwd ${cwd}, title "switchboard claude from codex", and prompt ${JSON.stringify(leafPrompt)}. Read its session until you see the actual assistant reply. Do not repeat creation or resend after acceptance. Report SWITCHBOARD_CODEX_TO_CLAUDE_OK and the Claude session_id only after observing the expected reply. Leave the session available for the user to inspect. If a permission or tool problem blocks you, report the exact problem instead of claiming success.`;
const claudePrompt = `This is an authorized local Switchboard integration test. Confirm that this fresh session has the installed switchboard MCP tools by using search_sessions with harness codex and query "switchboard". Then use create_session to create exactly one Codex session with harness codex, model gpt-5.6-sol, cwd ${cwd}, title "switchboard codex from claude", and prompt ${JSON.stringify(codexPrompt)}. Read that session until it completes the requested cross-harness test. Use only Switchboard for session operations, not shell/CLI session commands. Do not repeat creation or resend after acceptance. Report SWITCHBOARD_RECIPROCAL_OK plus the Codex and descendant Claude session IDs only after the Codex assistant reports the expected success. Leave all test sessions available for the user to inspect. Report exact blockers honestly.`;
const client = new Client({
  name: "switchboard-reciprocal-test",
  version: "0.1.0",
});
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist/cli.js")],
  }),
);
try {
  const response = await client.callTool({
    name: "create_session",
    arguments: {
      harness: "claude",
      model: "claude-fable-5",
      cwd,
      title: "switchboard reciprocal test",
      prompt: claudePrompt,
    },
  });
  await writeFile(receiptPath, JSON.stringify(response, null, 2));
  console.log(JSON.stringify(response.structuredContent));
  if (response.isError) process.exitCode = 1;
} finally {
  await client.close();
}
