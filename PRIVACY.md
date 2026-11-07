# Privacy

`tabby-agent-recovery` makes no network requests and has no analytics endpoint. Agent CLIs and Tabby have their own network behavior.

## Read locally

On Linux, native detection reads the current user's process ancestry and, for candidate agent processes in a pane, command lines, working directories, executable links, and environment. Only `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are carried into the recovered command; other process environment values are discarded. The plugin reads the first metadata record of an open transcript or Claude's local process registry to identify the conversation. It does not search unrelated conversations by recency.

If a compatible `agent-sessions` launcher is installed, its `pane-bindings` command and local state provide the optional external bindings.

## Written locally

Under `$AGENT_SESSIONS_STATE`, or `~/.local/state/agent-sessions` when its state file exists, otherwise `~/.local/state/tabby-agent-recovery`:

- `tabby-layout.json`: external pane keys and positions.
- `tabby-latest-snapshot.json`: the latest saved recovery layout.
- `layout-snapshots/`: up to 20 startup snapshots.
- `tabby-layout-before-binding.json`: the first layout backup before external binding migration.
- `terminal-logs/`: terminal output, only with `TABBY_AGENT_RECOVERY_LOG=1`.

By default the extra layout snapshots omit scrollback and profile environment except `CODEX_HOME` / `CLAUDE_CONFIG_DIR`. They still contain conversation IDs, titles, paths, and commands, which can be sensitive. `TABBY_AGENT_RECOVERY_SCROLLBACK=1` opts into full recovery tokens, including terminal scrollback and profile environment. Output logs may contain secrets printed by programs and are not automatically pruned.

Files are created with mode `0600` and directories with `0700` where supported by the operating system. Tabby's own local recovery storage remains separate: the plugin updates its resume commands but does not remove Tabby's saved scrollback or existing profile environment.

Keyboard input is not logged by the plugin. No credentials are uploaded. Resumed agents use their existing local authentication.
