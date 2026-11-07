# Changelog

## 1.1.0

- Standalone exact-conversation recovery for Codex and Claude Code. Linux detects running agents; explicit UUID resume profiles work without process discovery.
- Native and external bound panes stay open after process exit and initialize in background tabs.
- Missing external launchers no longer replace existing reconnect scripts with a broken command.
- Extra snapshots omit scrollback and nonessential environment by default; retain the last 20 startup snapshots.
- Document the difference between resuming conversation history and keeping a process alive, platform support, and explicit-profile fallback.

## 1.0.0

- Initial Tabby recovery bridge for existing agent-sessions bindings, split layouts, and optional terminal logs.
