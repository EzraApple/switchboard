# Switchboard

Let an agent in Claude Code start a Codex task, read its response, and continue the conversation—or do the same in the other direction. Switchboard exposes six MCP tools for managing native sessions across both harnesses, with one shared interface.

**Early local preview. The source is public; the npm package is not published.** Run from a checkout while it is being tested. `private: true` remains enabled in `package.json`.

The goal is to work with sessions you can see in your Desktop apps. Native session creation and cross-harness prompting work in local tests; immediate sidebar visibility and project grouping still have limitations. This is an independent project. Some adapter interfaces are private and may change.

## Requirements

- macOS: Claude login discovery currently uses macOS Keychain.
- Node.js 22.13 or newer. Local tests used Node 22.22.2, pinned in `.node-version`.
- Installed, signed-in Codex and Claude Code, with Claude Remote Control available for your account.
- An existing local working directory that you have already opened and trusted in Claude Code.

Claude session creation uses the **Claude Code CLI login**, which is separate from being signed into Claude Desktop. Check `claude auth status`; if it reports logged out, run `claude auth login --claudeai` and complete its browser flow. Switchboard does not refresh expired OAuth tokens itself.

Switchboard uses your existing harness logins. There is no separate Switchboard account or API key to paste. Agent turns still use your normal provider account and its limits.

## Run from source

```sh
git clone https://github.com/ezraapple/switchboard.git
cd switchboard
node --version
npm ci
npm run build
npm test
```

Check the Node version before installing. The install script restores executable permissions on node-pty's macOS helper. Switchboard does not use a Python runtime.

Capture absolute paths while you are in the checkout; Desktop apps may have a different PATH from your shell:

```sh
SWITCHBOARD_NODE="$(node -p 'process.execPath')"
SWITCHBOARD_CLI="$PWD/dist/cli.js"
```

### Connect Codex

```sh
codex mcp add switchboard -- "$SWITCHBOARD_NODE" "$SWITCHBOARD_CLI"
codex mcp get switchboard
```

Use a working Codex executable. If your installation bundles it at `/Applications/ChatGPT.app/Contents/Resources/codex`, that absolute path can replace `codex` in these commands.

Alternatively, add this table to `~/.codex/config.toml`, replacing both paths:

```toml
[mcp_servers.switchboard]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/switchboard/dist/cli.js"]
tool_timeout_sec = 180
```

The optional longer timeout accommodates first-use worker startup. See the [official Codex MCP configuration documentation](https://developers.openai.com/codex/mcp/).

### Connect Claude Code

```sh
claude mcp add --scope user --transport stdio switchboard -- "$SWITCHBOARD_NODE" "$SWITCHBOARD_CLI"
claude mcp get switchboard
```

This registers tools for Claude Code, including the Code sessions used by the Desktop workflow tested here. It does not configure ordinary Claude chat connectors. Use a fresh Code session after registration and approve tool requests through the host's normal permission flow.

Register in both harnesses for two-way coordination. Start fresh sessions to load the tools.

### Try a first conversation

In a fresh Codex task, ask:

> Use Switchboard to create one Claude session in `/absolute/path/to/my/project`, titled “hello from codex”. Ask it to reply with “hello from claude”, then read the session until you see its response. Leave it available for me to inspect.

In a fresh Claude Code session, swap Claude and Codex in that request. Reuse the returned session ID for follow-ups; do not create another session just because the first reply is still running.

For a read-only shell check:

```sh
node dist/cli.js call search_sessions '{"harness":"codex","limit":5}'
```

Running `node dist/cli.js` without arguments serves MCP over stdio. It waits for an MCP client, so a quiet terminal is expected. The backend starts automatically on the first tool call.

## Six shared tools

| Tool              | Inputs                                                | Purpose                                        |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------- |
| `create_session`  | `harness`, `prompt`, `cwd`; optional `title`, `model` | Start a native session and its first turn      |
| `search_sessions` | Optional `query`, `harness`, `archived`, `limit`      | Find sessions across one or both harnesses     |
| `read_session`    | `session_id`; optional `limit`                        | Read recent user/assistant messages and status |
| `send_message`    | `session_id`, `prompt`                                | Continue a session                             |
| `update_session`  | `session_id`; `title` and/or `archived`               | Rename, archive, or restore                    |
| `delete_session`  | `session_id`                                          | Delete a native session                        |

Harness names are `codex` and `claude`. IDs retain their native identity with a prefix: `codex:<UUID>` or `claude:cse_<ID>`. Local-only Claude Desktop identities use `claude:local_<UUID>`. Optional model names pass through without substitution. Reads omit reasoning and injected instructions.

`cwd` is an absolute execution directory. A matching saved Codex project ID is attached where available, but this does not guarantee Desktop grouping. Claude Remote Control sessions can also appear outside the expected project group.

Archive is reversible with `archived: false`. Delete targets the actual native session, not just a Switchboard listing.

### Understanding results

- Send acceptance means submitted; use `read_session` to observe completion.
- `created: true` means the session exists even if a later step failed. Reuse its ID.
- Failures set MCP `isError: true` with structured `status`, `error_code`, and `error` fields.
- `status: partial` includes `applied` fields when part of a compound update succeeded.
- `SESSION_OWNED_ELSEWHERE` means another Codex engine owns the task. Switchboard does not force ownership transfer.
- `OUTCOME_UNKNOWN` means inspect before retrying: the operation may already have happened.
- `DESKTOP_REFRESH_FAILED` concerns UI refresh; it does not undo a successful mutation.

## Architecture

```text
Codex / Claude Code / another MCP host
                  |
              MCP stdio
                  |
      shared local Switchboard daemon
            /                 \
  Codex adapter           Claude adapter
  separate App Server     session API + Remote Control
```

The daemon keeps native workers alive after individual MCP clients disconnect and serializes lifecycle requests. Each adapter implements the same typed contract. The caller does not need a Codex task ID or Codex's built-in app tools. The runtime does not use Computer Use or activate UI.

Codex uses one installed App Server per active task and closes that engine after completion, allowing Desktop to acquire the task. Tasks with active child turns or background terminals retain their engine; background-terminal cleanup is checked again at the next turn completion. Discovery uses read-only SQLite/JSONL for discovery and history, and optional Desktop IPC for existing-owner messages and sidebar refresh. Claude discovers Desktop titles and directories from local metadata, reads text from local transcripts, and messages running Desktop owners through authenticated local peer IPC. Remote sessions and creation use the existing Keychain login in memory, a session API, and Remote Control workers. Claude's session API and Codex Desktop IPC are private contracts, not stable public integrations.

Credentials are sent only to the fixed Anthropic API origin and are not saved in Switchboard state. Local state and the Unix socket use owner-only permissions. Granting an MCP host access gives it session-management capabilities for your signed-in harnesses; native approval handling has the limits below.

### Configuration and lifecycle

| Variable                 | Purpose                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `SWITCHBOARD_STATE_DIR`  | Override `~/.local/state/switchboard`; use a separate directory for isolated tests |
| `SWITCHBOARD_CODEX_BIN`  | Explicit Codex executable path                                                     |
| `SWITCHBOARD_CLAUDE_BIN` | Explicit Claude Code executable path                                               |
| `CODEX_HOME`             | Override native Codex storage/configuration                                        |

Set overrides in your MCP host's server environment. The first caller starts the shared daemon; a later caller's environment does not reconfigure an existing daemon.

Codex discovery checks `/Applications/ChatGPT.app/Contents/Resources/codex`, then `codex` on PATH. Claude discovery checks Desktop's installed Claude Code versions, then `~/.local/bin/claude`. Use explicit overrides for other layouts.

The state directory contains `daemon.json` (PID and entrypoint), `daemon.log`, worker metadata, and a Claude working-directory map. The directory map from the earlier `session-bridge` prototype is read as a migration fallback if present.

After updating source, run `npm ci` and `npm run build`. To load changed backend code, first let active work finish. Inspect the PID and entrypoint in `daemon.json`, verify that process is the Switchboard daemon, and send it SIGTERM. The next tool call starts the updated backend. Stopping it closes its separate Codex engines. Detached Claude workers and the experimental shared Codex server survive; restarting an MCP client alone does not restart the Switchboard backend.

To remove registrations:

```sh
codex mcp remove switchboard
claude mcp remove --scope user switchboard
```

Removing registrations does not stop an existing daemon or delete native sessions.

## Dormant Claude Desktop sessions

Background-only operation is required. The native open-session link was tested: it woke the correct conversation and delivered a reply, but brought Claude forward. That fallback has been removed. Running Desktop sessions remain reachable over local peer IPC. Dormant Desktop sessions without a connected remote worker return an explicit failure without opening a window or launching a competing engine.

## Current limits

- Immediate visibility of new sessions and Desktop project grouping are not guaranteed.
- A new Codex task may not stream its initial response in Desktop and may temporarily show “open in another app.” After the separate engine releases it and Desktop acquires it, Desktop-routed follow-ups have worked with streaming and an available composer in user testing. First-turn UI parity remains unresolved.
- Existing Desktop-owned Codex tasks can reject lifecycle operations, even while idle.
- Claude Desktop sessions are discoverable by their Desktop title. Running owners can receive local peer messages without Remote Control; dormant Desktop sessions cannot yet be reopened automatically.
- Claude relays are attributed to Switchboard with peer authority. They are not human approvals. The local inbox has no synchronous delivery receipt; read the session to verify a response before retrying.
- Claude Desktop title and lifecycle changes must use the owning app. Switchboard refuses to mutate only the remote mirror.
- Native approval/user-input requests are not relayed through the six tools. The separate Codex engine reports unsupported requests rather than approving them.
- Provider updates can break private API or IPC adapters. Compatibility has been tested locally, not across every installation or account tier.
- Machine-reboot recovery, expired-login renewal, attachments, and complete transcript pagination remain unverified.
- OpenCode is not implemented yet.

## Testing and contributing

Run `npm test` for the build and focused tests, and `npm run format:check` for formatting. [TESTING.md](TESTING.md) explains live checks and their effects on your account.

Useful issue reports include OS, Node and harness versions, operation, structured error code, and whether the native session changed or only its UI failed to refresh. Remove credentials, private prompts, and transcripts before posting.

## Before npm publication

The provisional package name is `@ezraapple/switchboard`; the unscoped name is taken. No registry install command is available yet. Use the checkout above, or make a local tarball with `npm pack` and run it with `npm exec --package=/absolute/path/to/the.tgz -- switchboard`. Packing does not publish anything. npm publication remains disabled during local testing.

## Claude worker behavior

Claude worker hosts run as detached OS processes, retaining their PTYs across Switchboard daemon restarts without creating helper chats. A live session retained its identity, environment, connection, and ability to answer across a daemon restart. Stopping the native Remote Control server or rebooting can still end its sessions; boot recovery is not proven.

Switchboard launches new Claude workers with `--permission-mode auto`. Claude retains its auto-mode safety classifier and may still require approvals. Already-running chats retain their existing mode. New creation workers use a separate reuse key so they do not inherit an older worker’s default permission mode.

## Experimental shared Codex server

Setting `codex_shared_daemon: true` in the state directory's `preferences.json` connects Switchboard to an existing native Codex daemon through its private Unix WebSocket. A missing daemon fails explicitly; it does not fall back to a separate engine. This option is off by default and does not make Desktop use the same server.

Creation, replies, follow-ups, and client reconnects were verified against the shared server. Desktop streaming, approval routing, and composer availability from the first turn remain unverified. This investigation is parked; it is not a recommended installation step. No Desktop startup settings or remote-access settings were changed.
