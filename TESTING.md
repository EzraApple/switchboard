# Testing Switchboard

## Focused checks

```sh
npm ci
npm test
npm run format:check
```

`npm test` builds the project and runs nine focused tests for MCP stdio transport, routing, transcript filtering, structured errors, ownership conflicts, partial updates, and prevention of duplicate sends. These checks do not start real provider turns.

## Live lifecycle

Live tests use your signed-in accounts and create real sessions. They exercise create, read, rename, search, archive, restore, send, and delete in both harnesses, including a caller disconnect/reconnect. Only successfully tested sessions created by that run are deleted.

The current fixtures specify `gpt-5.6-sol` and `claude-fable-5`. Check their availability in your accounts, or adjust the fixtures in `test/lifecycle.ts` before running. This is a local compatibility test, not a universal provider test suite.

```sh
npm run build
SWITCHBOARD_TEST_CWD=/absolute/trusted/workspace npm run test:live
```

The workspace must already be trusted in Claude Code. Receipts go under `evidence/`, excluded from Git and the npm package. If a run fails, inspect its receipt and native sessions before repeating it; failed runs may leave sessions for diagnosis.

Set `SWITCHBOARD_TEST_CLI` to an installed package's absolute `dist/cli.js` to test that build. Give it a separate `SWITCHBOARD_STATE_DIR` to avoid reusing the development daemon.

## Agent-to-agent checks

Register Switchboard in both harnesses and start fresh sessions. Ask Claude to create a Codex task whose prompt requests one Claude session, then have each parent read its child's actual reply. Verify recorded tool calls, not just a success claim.

`test/reciprocal.ts` contains the local fixture and uses the same model names as the lifecycle test. It leaves three real sessions for inspection and writes `evidence/reciprocal-dispatch.json`. Create the `evidence` directory first if absent. The fixture refuses to overwrite an existing receipt. It dispatches the test; completion still needs checking through session reads.

## Desktop checks

Check whether new sessions appear immediately in the sidebar, whether they group under the intended project, and whether following up from Desktop behaves as expected. Native API success alone does not establish full Desktop UI parity.

## Local verification on September 9, 2026

All nine focused tests passed. Both harnesses passed the lifecycle from source and again from a clean local tarball installation with an isolated daemon. A Claude → Codex → Claude round trip used Switchboard MCP for session operations and produced the expected actual replies. Immediate new-session visibility and project grouping still need broader hands-on testing.

Private receipts and native session IDs are kept locally and are not included in this repository.
