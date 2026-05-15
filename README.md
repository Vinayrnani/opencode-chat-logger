# chat-logger

OpenCode plugin that logs chat sessions to `.md` files and restores them on demand.

## Features

- **Auto-logging**: Every session's messages are appended to `.opencode/chats/<title>.md`
- **Crash-safe**: Append-only writes — never overwrites, safe from data loss
- **Context recovery**: Restore a previous session's context invisibly to the AI
- **File picker**: Optional TUI plugin for interactive chat selection

## Install

In your project's `.opencode/opencode.json`:

```json
{
  "plugin": ["github:Vinayrnani/chat-logger/plugin.ts"]
}
```

For the TUI file picker (optional), symlink into your plugins directory:

```bash
ln -s https://github.com/Vinayrnani/chat-logger/tui.tsx .opencode/plugins/tui-chat-logger.tsx
```

## Usage

| Command | Behavior |
|---|---|
| `/read-chat` | Restores current session's own saved chat log |
| `/read-chat <title>` | Restores the named chat log |
| `/read-chat` (TUI) | Opens an interactive file picker; dismiss → falls back to current session title |

The restored context is injected invisibly — the AI sees it as system context but the user sees only a brief confirmation.
