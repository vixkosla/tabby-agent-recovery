# Privacy

`tabby-agent-recovery` does not send network requests. It only reads and writes files on the local machine.

## Written locally

Under the state directory (`$AGENT_SESSIONS_STATE`, or `~/.local/state/agent-sessions` when that tree already exists, otherwise `~/.local/state/tabby-agent-recovery`):

- `tabby-layout.json` — pane keys and split paths
- `tabby-latest-snapshot.json` and `layout-snapshots/` — recovery tokens, including cwd, command, and Tabby's saved scrollback
- `terminal-logs/` — pane output, only when `TABBY_AGENT_RECOVERY_LOG=1`

Files are created mode `0600` in a `0700` directory.

## Not collected

Keyboard input is not recorded by this plugin. Credentials, cookies, and npm/GitHub tokens are not read. There is no analytics endpoint.
