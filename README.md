# Switchboard

One MCP for finding, reading, and managing Claude and Codex sessions.

## Install

Run either command in your terminal:

```sh
# Codex
codex mcp add switchboard -- npx -y @ezraapple/switchboard@latest

# Or Claude Code
claude mcp add --scope user switchboard -- npx -y @ezraapple/switchboard@latest
```

Check the connection with `codex mcp get switchboard` or `claude mcp get switchboard`, then start a fresh session. Registering in either app lets that agent work with both installed harnesses; no second registration is needed.

**Requires:** macOS, Node.js 22.13+, and the harnesses installed and signed in. Claude creation also needs Remote Control and a trusted working directory. Its CLI login is separate from Desktop; check `claude auth status`.

## Tools

| Tool | What it does |
| --- | --- |
| `create_session` | Start a session with a prompt, directory, and optional model. |
| `search_sessions` | Search titles, directories, and conversation text with ranked snippets. |
| `read_session` | Read recent messages and status. |
| `send_message` | Continue a conversation, including waking dormant local Claude sessions. |
| `update_session` | Rename, archive, or restore a session. |
| `delete_session` | Permanently delete a session. |

## Preview limits

- New Codex sessions can lock the Desktop composer during their first turn; sidebar visibility and grouping may lag.
- Desktop-owned rename/archive/delete operations may require the owning app.
- Claude wake needs the original local transcript and a CLI supporting `--bg --resume`; Desktop-only tools may be unavailable.
- Search is keyword-based. Read back replies after sending; acceptance is not completion.
- Approval forwarding, attachments, and expired remote-only Claude recovery are unsupported. Some integrations use private interfaces that can change.

[Configuration, upgrades, and troubleshooting](docs/REFERENCE.md) · [Testing](TESTING.md) · [MIT license](LICENSE)
