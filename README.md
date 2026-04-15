# NTFY MCP Server

MCP server for `ntfy.sh` notifications, asynchronous agent messaging, and human-in-the-loop workflows.

It provides a simple way for an MCP client to publish messages to an `ntfy` topic, maintain a live subscription, and wait for replies without building a custom messaging layer.

## What It Does

This server is useful when you need:

- push notifications from an MCP-connected agent
- asynchronous message exchange between a user and an agent
- a lightweight human approval or reply loop over `ntfy`
- a simple notification channel for long-running workflows

Typical flow:

1. A user or external system publishes a message to an `ntfy` topic.
2. The MCP client reads it through `wait-and-read-inbox` or `ntfy://inbox`.
3. The agent responds through `send-ntfy`.
4. The user receives the response as an `ntfy` push notification.

## Features

- publish messages with optional title, priority, tags, and attachments
- maintain a persistent subscription for near real-time delivery
- switch topics without restarting the server
- keep recent messages in memory and on disk
- support bearer-token and basic-auth protected topics
- work with public `ntfy.sh` out of the box

## Installation

Install globally:

```bash
npm install -g nfty-mcp-server
```

Or run through `npx`:

```bash
npx -y --yes nfty-mcp-server
```

## Quick Start

### 1. Choose a topic

Create or reuse a topic on [`ntfy.sh`](https://ntfy.sh). Public topics are easy to set up, so pick a unique name.

### 2. Configure your MCP client

For Cursor or VS Code, add this to your MCP settings:

```json
{
  "mcpServers": {
    "nfty": {
      "command": "npx",
      "args": ["-y", "--yes", "nfty-mcp-server"],
      "env": {
        "NTFY_TOPIC": "your-topic-name",
        "NTFY_BASE_URL": "https://ntfy.sh"
      }
    }
  }
}
```

For Claude Desktop, add the same server entry to `claude_desktop_config.json`.

Notes:

- `NTFY_TOPIC` is required
- `--yes` keeps `npx` installs in its own cache instead of polluting a project directory

### 3. Restart the client

Restart Cursor, VS Code, or Claude Desktop so the MCP server is loaded.

## Tools

### `send-ntfy`

Publishes a message to the configured topic.

Parameters:

- `message` required
- `title` optional
- `priority` optional, `1` through `5`
- `tags` optional
- `attachUrl` optional

Example:

```json
{
  "message": "Task completed successfully.",
  "title": "Task Status",
  "priority": 4
}
```

### `set-ntfy-topic`

Switches the active topic for the current session.

Parameters:

- `topic` required
- `baseUrl` optional

### `wait-and-read-inbox`

Waits for new messages on the configured topic and returns when at least one arrives.

Parameters:

- `since` optional
- `sinceTime` optional
- `sinceNow` optional, default `true`

Important:

- many MCP clients impose an approximately 60-second timeout
- if you are waiting on human input, the client or calling agent should retry on timeout

Recommended prompt behavior for agent chat flows:

> If `wait-and-read-inbox` times out while waiting for a user response, retry until a new message arrives.

## Resources

### `ntfy://inbox`

Returns recent messages for the configured topic as JSON.

Example shape:

```json
{
  "topic": "your-topic",
  "baseUrl": "https://ntfy.sh",
  "messages": [
    {
      "id": "message-id",
      "time": 1234567890,
      "title": "Message Title",
      "message": "Message body",
      "priority": 3,
      "tags": ["tag1"],
      "topic": "your-topic"
    }
  ]
}
```

## Configuration

### Data Storage

The server stores logs, cache files, and lock files in a dedicated data directory so it does not clutter the current project.

Default location:

- macOS / Linux: `~/.nfty-mcp-server/`
- Windows: `C:\Users\<user>\.nfty-mcp-server\`

Files written there include:

- `nfty-messages.json`
- `nfty-debug.log`
- `nfty-process.log`
- `nfty.lock`

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NTFY_TOPIC` | Topic to send/receive messages | required |
| `NTFY_BASE_URL` | ntfy server URL | `https://ntfy.sh` |
| `NTFY_AUTH_TOKEN` | Bearer token | optional |
| `NTFY_USERNAME` | Basic-auth username | optional |
| `NTFY_PASSWORD` | Basic-auth password | optional |
| `NTFY_SINCE` | Initial backlog cursor | `1h` |
| `NTFY_FETCH_TIMEOUT_MS` | Fetch timeout in milliseconds | `10000` |
| `NTFY_CLEAN_ON_STARTUP` | Clear logs/cache on startup | `true` |
| `NTFY_KILL_EXISTING` | Kill existing server instances | `true` |
| `NTFY_DATA_DIR` | Data directory override | default platform path |
| `NTFY_CACHE_FILE` | Cache file override | `{NTFY_DATA_DIR}/nfty-messages.json` |

### CLI Arguments

You can also configure the server directly:

```bash
npx nfty-mcp-server --topic my-topic --base-url https://ntfy.sh --auth-token your-token
```

Supported arguments:

- `--topic`
- `--base-url` or `--server`
- `--auth-token`
- `--username`
- `--password`
- `--since`
- `--log-incoming`

## How It Works

1. The server opens a persistent HTTP subscription to the configured topic.
2. Incoming messages are received through that live connection.
3. Recent messages are cached in memory and persisted to disk.
4. MCP tools expose send, topic-switching, and wait/read behavior on top of that subscription.

## Use Cases

- asynchronous user-agent messaging
- push notifications for long-running tasks
- human approval loops
- lightweight operator alerts
- agent-to-agent coordination through a shared topic

## Development

```bash
git clone https://github.com/harshwasan/NFTY-MCP.git
cd NFTY-MCP
npm install
npm test
npm run dev
```

Project layout:

```text
NFTY-MCP/
  src/server.js
  tests/server.test.js
  package.json
```

## Troubleshooting

Messages not arriving:

- verify `NTFY_TOPIC`
- confirm the topic exists and is reachable
- inspect the debug log in the configured data directory

Connection problems:

- verify network access to the configured `NTFY_BASE_URL`
- verify authentication settings if the topic is protected

## Recommended Improvements

The repository would benefit from:

- a short architecture diagram
- a release changelog
- a screenshot or example of a real notification flow in use

## License

MIT
