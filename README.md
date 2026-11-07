# tabby-agent-recovery

Resume the same Codex or Claude Code conversation in the same Tabby pane after a restart. Keep nested splits and finished panes. No separate launcher is required.

## Install

Tabby → **Settings → Plugins** → search **agent-recovery** → Install → restart Tabby.

If the search has not indexed the package yet, open **Plugins folder** in those settings and run:

```bash
npm install tabby-agent-recovery@latest
```

Restart Tabby after installing or updating. Enable Tabby's **Restore tabs on start** option. The agent CLI must already be installed and authenticated.

If you use a development copy through a symlink in the plugins directory, update that source copy instead: npm installation would replace the symlink.

## Standalone recovery

On Linux, the plugin inspects the processes belonging to each local pane when Tabby saves its tabs. For Codex and Claude Code, it records the **exact conversation UUID**, executable, working directory, and supported CLI options. After a restart, the pane runs `codex resume <UUID>` or `claude --resume <UUID>`.

- New conversations are identified from the pane's open transcript or Claude's process registry. Explicit resume commands also work.
- Nested splits, their order, titles, and ratios are kept by Tabby's existing recovery system.
- Identified panes stay in the layout when their process finishes.
- Bound background panes start without selecting the tab or focusing the window.
- The plugin keeps the latest layout checkpoint and the last 20 startup snapshots.

This starts a **new agent process with the saved conversation**. It does not keep computation alive while the computer is off or submit a new prompt. CLI login, conversation files, and the executable must still be available. After a crash, only Tabby's most recently saved layout can be recovered.

### Supported cases and fallback

Automatic process discovery currently supports **Linux**, Codex, and Claude Code. It does not guess by folder, modification time, `--last`, or `--continue`. Headless jobs, ambiguous panes, subagent transcripts, unknown CLI flags, and shared daemons without an identifiable pane transcript are left unchanged.

For those cases, or on **macOS and Windows**, create a local Tabby profile with an explicit resume command:

| Profile field | Codex | Claude Code |
| --- | --- | --- |
| Command | Full path to `codex` | Full path to `claude` |
| Arguments | `resume <UUID>` | `--resume <UUID>` |
| Working directory | Your project directory | Your project directory |

Replace `<UUID>` with the actual conversation ID. The arguments are separate from the executable path. On Codex versions that support it, `--no-daemon` can make a new conversation's transcript identifiable inside its pane; an explicit UUID is the reliable fallback for an existing conversation.

Recognized options include model, profile, sandbox/approval or permission mode, additional directories, and selected UI flags. Already selected permission bypass flags are preserved, never enabled by the plugin. Unknown or sensitive inline configuration makes automatic recovery skip that invocation. Ordinary shells and arbitrary commands are not converted into agent sessions.

## Check it

1. Start a conversation with Codex or Claude Code inside a Tabby pane.
2. Create a split and close Tabby normally so it saves the layout.
3. Open Tabby again. Check the conversation identity, working directory, and split arrangement.
4. If it opens an ordinary shell, use an explicit resume profile as described above.

## Optional existing agent-sessions integration

If you already run a compatible local `agent-sessions` launcher, the plugin can preserve `agent-sessions attach <key>` bindings and migrate saved PTY bindings before Tabby builds its tabs. The launcher is optional and is not installed by this package. Existing reconnect scripts are not replaced when the launcher is missing.

| Environment variable | Default / effect |
| --- | --- |
| `AGENT_SESSIONS_LAUNCHER` | `~/.local/bin/agent-sessions` |
| `AGENT_SESSIONS_STATE` | `~/.local/state/agent-sessions` if its `state.json` exists; otherwise `~/.local/state/tabby-agent-recovery` |
| `TABBY_AGENT_RECOVERY_SCROLLBACK=1` | Include terminal scrollback and full profile environment in extra snapshots; off by default |
| `TABBY_AGENT_RECOVERY_LOG=1` | Write terminal output to `<state>/terminal-logs/`; off by default |

Set these in the environment that launches Tabby. No configuration is needed for ordinary standalone use.

## Privacy

No network requests or analytics are made by the plugin. Default extra snapshots omit terminal scrollback and environment variables other than `CODEX_HOME` / `CLAUDE_CONFIG_DIR`. Paths and commands are still saved and may be sensitive. Tabby's own recovery storage is separate and retains its existing behavior. See [PRIVACY.md](PRIVACY.md).

## Development

```bash
npm test
TABBY_PLUGINS="$PWD" tabby --debug
```

Tests cover native identity discovery, ambiguity, CLI wrappers, missing launchers, nested layouts, background initialization, privacy defaults, and snapshot retention. Integration was checked in an isolated Tabby 1.0.238 on Linux, using local CLI fixtures without network/model calls: two conversations resumed with their exact IDs after a full app restart, splits retained their ratios, and an exited pane stayed open. Native metadata formats can change between agent versions; explicit resume profiles remain the fallback.

## License

MIT
