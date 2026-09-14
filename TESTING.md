# Testing Switchboard

## Focused checks

```sh
npm ci
npm test
npm run format:check
```

`npm test` builds the project and runs focused tests for MCP stdio transport, routing, transcript filtering, structured errors, ownership conflicts, partial updates, and prevention of duplicate sends. These checks do not start real provider turns.

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

## September 10 follow-up: background-only requirement

The dormant Desktop deep-link test reopened the exact `desktop bridge test` conversation, submitted a local peer message, and received `SWITCHBOARD_DORMANT_4_A19`. It also brought Claude forward, which violates the user's background-only requirement. The fallback and its tests were removed; it is not an accepted MVP path.

Fresh native MCP verification in the trusted ezra-apple folder passed Claude creation and an actual reply, rename, archived search, restore, and an actual follow-up reply (`CLAUDE_CREATE_OK_B72`, `CLAUDE_RESTORE_OK_C31`). The fixture remains available as `switchboard verified`. No publication or deletion occurred in this run.

Dormant Desktop owners must fail without opening windows, starting a competing worker, or submitting a message. Local-peer sends to running owners remain supported. Full Claude MVP verification is blocked on background wake of arbitrary dormant Desktop sessions. Desktop-owned lifecycle operations remain explicitly unsupported rather than changing only the API mirror.

## Codex ownership release regression (2026-09-10)

The old shared App Server retained completed tasks as active writers, producing Desktop's “open in another app” restriction. Each task now has an independent engine; completion closes its input and waits for process exit before forgetting ownership. Follow-ups then try Desktop IPC first. Active child turns and background terminals prevent closure.

Build and 23 tests passed, including independent concurrent engines, routing to Desktop after release, resuming after release, and preserving background terminals. Live Switchboard MCP creation of `01a08cf8-e3a0-73e2-aa45-7f9abb498acc` answered 42; its worker exited, native Desktop continued with 15, and a Switchboard follow-up used `codex_desktop_ipc` and answered 42. After adding the terminal guard, `01a08cfa-5d71-7491-a747-1b1ec726acf4` answered 17 and its worker also exited. Desktop accepted a subsequent follow-up. UI composer click-through remains unobserved; actual Desktop ownership and message execution are the verification witness.

## Shared server and worker persistence investigation

The suite at this checkpoint had 27 tests. Added Unix WebSocket transport checks confirm client disconnect does not stop the shared server and that shared mode does not automatically reject native approval requests. Claude process tests cover supervisor survival and reuse by a fresh manager.

Actual Switchboard MCP created `shared daemon check` (`01a08d12-c52a-7301-85d2-d160a4944f0e`) using `codex_shared_daemon`, which answered 29. A subsequent send through the exact Unix WebSocket URL was accepted after Switchboard restart. These are backend tests, not Desktop UI proof.

Actual Claude MCP persistence proof: `worker restart check` (`cse_01CMFNGSd2mGTkGt285ePgyj`) answered 43 before daemon restart and 59 afterward, retaining supervisor PID35816 and environment env_01BvHSz3vJ6PsNwJ46eQSJWn; connected and unarchived.

Native Claude create remains unavailable on this installation: the `start_session` tool was absent during an actual deferred-tool lookup, and the alternative requires a user-click proposal. A resident relay successfully woke a dormant session without focus changes, but the user rejected helper chats, so relay runtime code and configuration were removed.

Shared app-tool follow-up: actual MCP creation with the official wrapper configuration still returned `APP_TOOL_UNAVAILABLE`. Desktop logged `dynamic_app_tools_peer_rejected reason=missing-code-signing-identity` at the same startup time. Shared-mode configuration is experimental and does not establish usable native app tools. The normal MCP launcher also lacked the inherited app-runtime environment; an explicit daemon launch with that environment was needed for this test.

Claude direct Desktop serving was found in installed source but its current provider feature gate is false. Live environment discovery found no Desktop serving environment. No feature gates, app settings, or native peer checks were changed.

The failed app-tool setup was withdrawn from the active creation path. Its candidate source/tests are retained only in the investigation workspace. Codex creation no longer requires caller-inherited app-runtime variables. The user declined remote access; it was not enabled.

## September 11–14 verification and release status

Claude Code CLI authentication was restored through `claude auth login --claudeai`; `claude auth status` then reported logged in and an actual Switchboard MCP search succeeded. Being signed into Claude Desktop alone had not supplied a usable CLI token. Automatic expired-token renewal remains unimplemented.

After changing worker launches to auto permissions, actual Switchboard MCP creation of `auto mode check` connected and answered 42. Process inspection confirmed `--permission-mode auto` on both its Remote Control worker and the spawned Claude session. The focused worker test also checks the launch argument. This verifies mode selection, not that every tool action will avoid approval prompts.

The user reported Codex → Claude working smoothly in normal use. For Codex creation, the user accepted missing initial progress as a current limitation after observing working Desktop-routed follow-ups and an available composer. These observations do not prove first-turn UI parity or background wake of arbitrary dormant Claude Desktop sessions.

On September 14, the current source built successfully, all 27 automated tests passed, and the source/test/script formatting check passed. A freshly packed tarball contained 46 allowlisted files (build output, docs, package metadata, and the install helper), installed successfully into a temporary directory, and exposed all six tools through its installed executable over MCP stdio. No real provider turns were started by that package smoke check. Earlier live lifecycle and cross-harness results above are dated historical evidence, not a fresh full lifecycle run of this revision.

## Package release checklist

Before publishing the first package:

- Run both harnesses' live lifecycle and reciprocal MCP checks against the final installed tarball, then inspect actual replies and Desktop follow-up behavior. Repeat with a clean setup or second installation to check onboarding assumptions.
- Choose and add a license; the repository currently has no license file. Confirm the scoped package name, version, npm account access, and intended public visibility. Remove `private: true` only when ready to publish.
- Verify the final tarball contents, fresh installation, executable entry point, and MCP tool discovery. Keep credentials, evidence, native session transcripts, and machine-specific state out of the package.
- Keep shared Codex mode experimental. Document unsupported dormant Claude wake, CLI reauthentication, worker/reboot recovery, approval relay, and first-turn Codex UI behavior as preview limitations unless resolved before release.

The first three items are release gates. The last item bounds the preview's claims; full Desktop parity is not a prerequisite for an honestly labeled preview. This checklist does not authorize an npm publication.
