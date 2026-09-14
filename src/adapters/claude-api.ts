import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { OperationError } from "../errors.js";

const executeFile = promisify(execFile);
const credentialsSchema = z.object({
  claudeAiOauth: z.object({ accessToken: z.string().min(1) }),
});
const configSchema = z.object({
  oauthAccount: z.object({ organizationUuid: z.string().min(1) }),
});
export class ClaudeAPI {
  async request({
    method,
    path,
    body,
  }: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<unknown> {
    if (
      !/^\/v1\/code\/sessions(?:$|[/?])/.test(path) &&
      !(method === "GET" && path === "/v1/environment_providers")
    )
      throw new Error(
        "Only the Claude session API and read-only environment discovery are allowed",
      );
    if (process.platform !== "darwin")
      throw new Error(
        "Claude login discovery currently requires macOS Keychain",
      );
    const config = configSchema.parse(
      JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")),
    );
    let credentials: z.infer<typeof credentialsSchema>;
    try {
      const result = await executeFile(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 10_000 },
      );
      credentials = credentialsSchema.parse(JSON.parse(result.stdout));
    } catch {
      throw new Error(
        "Claude Code login is unavailable in Keychain. Sign in through Claude Code.",
      );
    }
    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${credentials.claudeAiOauth.accessToken}`,
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "ccr-byoc-2025-07-29",
          "anthropic-client-feature": "ccr",
          "x-organization-uuid": config.oauthAccount.organizationUuid,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new OperationError(
        "OUTCOME_UNKNOWN",
        "Claude session API connection failed or timed out; inspect before retrying.",
      );
    }
    const text = await response.text();
    if (!response.ok)
      throw new OperationError(
        "PROVIDER_ERROR",
        `Claude session API HTTP ${response.status}: ${text.slice(0, 1500)}`,
      );
    return text ? JSON.parse(text) : {};
  }
}
