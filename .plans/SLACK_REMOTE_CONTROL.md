# Slack Remote Control — Session Handoff to Slack Channel

## Objective

Allow a running OMP coding-agent session to be "handed off" to a Slack channel so that:
- Users can send messages in that channel to drive the agent (equivalent to typing in the terminal)
- Agent responses are posted back to the channel as messages
- The local session stays running (local environment, tools, MCP servers all remain available)
- Interaction can happen from terminal AND Slack simultaneously (like Claude's remote control)

## Architecture Decision

### Transport: Slack Socket Mode + Web API

**Why Socket Mode** (not webhooks):
- No public HTTP endpoint required — works behind firewalls and NAT
- WebSocket-based, low latency, bidirectional
- Simple auth: single app-level token (`xapp-*`) for connection, bot token for posting
- Already the recommended approach for internal/private Slack apps

**Slack SDK packages needed** (new dependencies):
- `@slack/web-api` — posting messages, editing messages, uploading files
- `@slack/socket-mode` — real-time event reception via WebSocket

### Design: Slack Transport Layer (not a new mode)

This is implemented as a **transport bridge** that attaches to an existing `AgentSession`, similar to how RPC mode wraps a session with stdin/stdout. The bridge:
1. Connects to Slack via Socket Mode
2. Listens for messages in a configured channel
3. Forwards them to `session.prompt()`
4. Subscribes to session events and posts agent output back to Slack

This is NOT a separate "mode" — it's an overlay that can be activated on an interactive session (like Claude's `/remote-control` command) or as a dedicated server mode.

## Implementation Plan

### Phase 1: Core Slack Bridge (`packages/coding-agent/src/slack/`)

#### Files to Create

| File | Purpose |
|------|---------|
| `src/slack/index.ts` | Barrel exports |
| `src/slack/slack-bridge.ts` | Core bridge class: manages Socket Mode connection, message routing |
| `src/slack/slack-formatter.ts` | Convert agent output (markdown, tool results, diffs) to Slack Block Kit format |
| `src/slack/slack-config.ts` | Configuration types and validation |
| `src/slack/slack-session-observer.ts` | AgentSessionEvent listener that posts updates to Slack |

#### `SlackBridge` class responsibilities:
- Connect to Slack via `SocketModeClient`
- Filter messages: respond to @mentions in channel top-level; respond to ALL messages in bot-owned threads
- Convert Slack message text → `session.prompt()` calls
- Each session owns a single thread in the channel (thread created on first agent response)
- Post streaming progress indicators (emoji reactions, message edits)
- Handle disconnect/reconnect gracefully
- Expose `start()` / `stop()` lifecycle
- Download file/image uploads from Slack and forward as agent context

### Phase 2: Configuration

#### Settings Schema additions (`settings-schema.ts`)

```
"slack.enabled": boolean (default: false)
"slack.appToken": string (xapp-* token for Socket Mode)
"slack.botToken": string (xoxb-* token for Web API)
"slack.channelId": string (channel to bind to)
```

These can also be set via environment variables:
- `SLACK_APP_TOKEN` — app-level token
- `SLACK_BOT_TOKEN` — bot OAuth token
- `SLACK_CHANNEL_ID` — channel to operate in

### Phase 3: CLI / Slash Command Integration

#### Activation methods (mirroring Claude's remote control patterns):

1. **Slash command**: `/slack` — starts Slack bridge on current session (like `/remote-control`)
2. **CLI flag**: `omp --slack` or `omp --slack "#channel-name"` — start with Slack bridge active
3. **Server mode**: `omp slack` — dedicated headless mode that only accepts input from Slack

#### Files to Modify

| File | Change |
|------|--------|
| `src/config/settings-schema.ts` | Add `slack.*` settings |
| `src/cli/args.ts` | Add `--slack` flag |
| `src/main.ts` | Handle `--slack` flag, start bridge alongside interactive/print mode |
| `src/slash-commands/builtin-registry.ts` | Add `/slack` command |
| `src/modes/controllers/command-controller.ts` | Add `handleSlackCommand()` |
| `src/commands/slack.ts` | New subcommand definition (for `omp slack` server mode) |
| `src/cli/slack-cli.ts` | CLI handler for server mode |

### Phase 4: Session Observer (streaming output to Slack)

The observer subscribes to `AgentSessionEvent` and posts:
- **Assistant text**: Posted as Slack messages (chunked if long, using threads)
- **Tool calls**: Posted as brief status messages (e.g., "Reading `src/main.ts`...")
- **Tool results**: Posted as collapsed/threaded follow-ups (file contents truncated)
- **Errors**: Posted with error emoji/formatting
- **Completion**: Reaction added (checkmark) when agent turn finishes

Streaming approach:
- Post an initial message when agent starts responding
- Edit the message as content streams in (debounced, ~500ms intervals)
- Finalize the message when the turn completes

### Phase 5: Input Handling (Slack → Agent)

**Message routing rules:**
- **Channel top-level**: Only messages that @mention the bot are processed
- **Bot-owned thread**: ALL messages are processed (no @mention required)
- Bot's own messages and other bot messages are always ignored

Messages from Slack are processed as follows:
1. Filter: Apply routing rules above (top-level needs @mention, thread does not)
2. Parse: Strip Slack formatting (user mentions, links, etc.) into plain text
3. Handle special commands: `/stop` (abort current), `/handoff` (generate handoff doc)
4. Forward to `session.prompt(text)` (identical to typing in terminal)
5. File uploads: Download file content via Slack API; for text files include content as context, for images forward to vision model if available

### Phase 6: Tests

| Test File | Coverage |
|-----------|----------|
| `test/slack/slack-bridge.test.ts` | Bridge lifecycle, message routing |
| `test/slack/slack-formatter.test.ts` | Markdown → Block Kit conversion |
| `test/slack/slack-session-observer.test.ts` | Event → Slack message mapping |

## Key Design Decisions

### 1. Threading & Channel Binding Model
**Decision**: @mention-to-activate in channel, free-form in thread.
- Bot only responds to @mentions in the main channel
- The first @mention (or `/slack` activation) creates a thread — this thread IS the session
- Within the thread, all messages are forwarded to the agent (no @mention needed)
- Each session gets its own thread; multiple sessions can coexist in the same channel via different threads
- Keeps the channel usable for other conversation while giving dedicated threads full agent interaction

### 2. Concurrent Access
**Decision**: Allow simultaneous terminal + Slack input (like Claude's remote control).
- Both inputs go through `session.prompt()` which already handles queuing
- Agent responses are emitted to ALL observers (terminal TUI + Slack bridge)
- The session's event system already supports multiple listeners

### 3. Authentication Storage
**Decision**: Slack tokens stored in settings (encrypted at rest if `security.encryptCredentials` is enabled).
- Environment variables take precedence over stored settings
- Tokens validated on bridge startup

### 4. Message Size Limits
**Decision**: Slack messages are capped at 40,000 characters. Long responses are:
- Split across multiple messages in the thread
- Code blocks and diffs are posted as Slack file snippets if they exceed ~3000 chars

### 5. Graceful Degradation
- If Slack connection drops, session continues locally (just like Claude remote control)
- Bridge attempts reconnection automatically
- Terminal shows connection status

## Dependencies to Add

In `packages/coding-agent/package.json`:
```json
"@slack/web-api": "^7.x",
"@slack/socket-mode": "^2.x"
```

## Slack App Requirements (for user setup)

The user needs a Slack app with:
- **Socket Mode** enabled
- **Bot Token Scopes**: `chat:write`, `channels:history`, `groups:history`, `app_mentions:read`, `files:write`
- **Event Subscriptions**: `message.channels`, `message.groups`, `app_mention`
- **App-level token** with `connections:write` scope

## Verification

1. Unit tests pass for bridge, formatter, observer
2. `bun check:ts` passes with new code
3. Manual test: start session with `--slack`, send message in channel, verify response appears
4. Verify concurrent terminal + Slack input works
5. Verify reconnection after simulated disconnect
6. Verify long message splitting works correctly
7. Verify thread model works as expected

## Resolved Questions

1. **Channel binding**: Bot responds to @mentions in main channel; all messages within bot-owned threads → no @mention needed
2. **Multiple sessions**: Each session gets its own thread in the channel (not its own channel)
3. **File/image support**: Yes — text files read and included as context; images forwarded to vision model if available

## Codebase Context (for implementation)

### Key Files and Patterns

| File | Relevance |
|------|-----------|
| `packages/coding-agent/src/session/agent-session.ts` | Core session class (7607 lines). Has `prompt()`, event listeners (`#eventListeners`), `respondAsBackground()` for injecting messages. IRC relay pattern is closest analog. |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | RPC mode wraps session with stdin/stdout — architectural reference for how a transport bridges to session |
| `packages/coding-agent/src/modes/acp/acp-mode.ts` | ACP mode for remote control via Agent Client Protocol — another transport bridge reference |
| `packages/coding-agent/src/tools/irc.ts` | Agent-to-agent messaging; shows how messages get injected into session |
| `packages/coding-agent/src/config/settings-schema.ts` | Settings definitions (~2838 lines). IRC settings at line 1779. Add `slack.*` settings nearby. |
| `packages/coding-agent/src/main.ts` | Mode dispatch at line 849: `if (mode === "rpc") ... else if (mode === "acp") ...`. Slack bridge starts ALONGSIDE interactive mode, not as a replacement. |
| `packages/coding-agent/src/cli/args.ts` | CLI arg parsing. `Mode` type is `"text" | "json" | "rpc" | "acp"`. Slack is NOT a mode — it's an overlay flag. |
| `packages/coding-agent/src/slash-commands/` | Slash command registration for `/slack` in-session activation |

### Session Interaction Patterns

- `session.prompt(text)` — main entry point for user input
- `AgentSessionEvent` — event type emitted to all listeners (text chunks, tool calls, errors, completion)
- `#eventListeners: AgentSessionEventListener[]` — array of listeners; bridge registers here
- `respondAsBackground()` (line ~6559) — handles injected messages without blocking current tool calls
- IRC relay at line 536-540 shows `#pendingBackgroundExchanges` pattern for queuing messages during streaming

### Conventions to Follow

- No `console.log` — use `logger` from `@oh-my-pi/pi-utils`
- Use `Bun.sleep()` not `setTimeout` promises
- Use `$` from `bun` for shell commands
- Namespace imports for node modules (`import * as fs from "node:fs/promises"`)
- No `private`/`public` keywords — use `#` for private fields
- No `ReturnType<>` — use actual types
- No inline imports — top-level only
- Star re-exports in barrel files
- `Promise.withResolvers()` instead of `new Promise()`
- Audit events for security-relevant operations via `emitSecurityEvent`

### Package Management

- Dependencies use `catalog:` references in workspace `package.json`
- Add new deps to both `packages/coding-agent/package.json` and root `package.json` catalog
- Run `bun install` after adding deps

## NIST 800-53 Compliance Notes

| Control | Title | Applicability | Implementation |
|---------|-------|---------------|----------------|
| AC-17 | Remote Access | Direct — Slack is a remote access channel to the agent | Audit bridge start/stop; tokens validated before connection; bridge can be disabled via settings |
| AC-17(1) | Monitoring and Control | Direct | All Slack→agent interactions logged as audit events; connection status visible in terminal |
| AC-17(2) | Protection of Confidentiality and Integrity Using Encryption | Direct | Socket Mode uses WSS (TLS); Slack Web API uses HTTPS; tokens encrypted at rest per existing `security.encryptCredentials` |
| AC-12 | Session Termination | Direct | Bridge auto-disconnects on session dispose; `/stop` command terminates from Slack side |
| SC-8 | Transmission Confidentiality and Integrity | Satisfied by design | All Slack communication over TLS (WSS/HTTPS) — Slack enforces this; no plaintext path exists |
| AU-6 | Audit Record Review, Analysis, and Reporting | Direct | Emit audit events: `slack_bridge_start`, `slack_bridge_stop`, `slack_message_received`, `slack_message_sent` |

### Security Implementation Requirements

1. **Credential handling**: Slack tokens (`xapp-*`, `xoxb-*`) stored encrypted when `security.encryptCredentials` is enabled; never logged in plaintext
2. **Audit trail**: All Slack bridge lifecycle events and message routing emit security audit events via `emitSecurityEvent`
3. **Input validation**: Messages from Slack are treated as untrusted input — same sanitization as terminal input
4. **Disconnect behavior**: Session continues locally if Slack connection drops; no data loss
5. **Token validation**: Tokens validated (auth.test API call) before accepting messages; invalid tokens prevent bridge start