import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAPI } from "../src/adapters/claude-api.js";

test("environment discovery allows no mutations, subpaths, or arbitrary URLs", async () => {
  const api = new ClaudeAPI();
  for (const input of [
    { method: "POST", path: "/v1/environment_providers" },
    { method: "DELETE", path: "/v1/environment_providers" },
    { method: "GET", path: "/v1/environment_providers/cloud/create" },
    { method: "GET", path: "https://example.com/v1/environment_providers" },
  ]) {
    await assert.rejects(
      api.request(input),
      /Only the Claude session API and read-only environment discovery are allowed/,
    );
  }
});
