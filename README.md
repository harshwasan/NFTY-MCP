# NTFY MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that enables AI agents to send and receive messages through [ntfy.sh](https://ntfy.sh) with real-time subscriptions. Perfect for building AI agents that can communicate via push notifications.

## Features

- 📨 **Send Messages**: Publish messages to ntfy topics with optional title, priority, tags, and attachments
- 📬 **Real-time Subscriptions**: Maintains persistent connections to receive messages instantly
- 🔄 **Topic Management**: Change topics on the fly without restarting
- 📊 **Message Caching**: Keeps recent messages in memory and on disk
- 🔐 **Authentication**: Supports bearer tokens and basic auth for protected topics
- ⚡ **Zero Configuration**: Works out of the box with public ntfy.sh

## Installation

### Via npm (for MCP clients)

```bash
npm install -g nfty-mcp-server
```

### Via npx (no installation needed)

```bash
npx nfty-mcp-server
```

## Quick Start

### 1. Get a topic

Visit [ntfy.sh](https://ntfy.sh) and create a topic (or use an existing one). Topics are public by default, so choose a unique name.

### 2. Configure your MCP client

#### For Cursor/VS Code

Add to your MCP settings (typically `~/.cursor/mcp.json` or `C:\Users\<user>\.cursor\mcp.json`):

```json
{
  "mcpServers": {
    "nfty": {
      "command": "npx",
      "args": ["-y", "nfty-mcp-server"],
      "env": {
        "NTFY_TOPIC": "your-topic-name",
        "NTFY_BASE_URL": "https://ntfy.sh"
      }
    }
  }
}
```

**Note:** `NTFY_TOPIC` is required. Set it in the `env` section of mcp.json.

#### For Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nfty": {
      "command": "npx",
      "args": ["-y", "nfty-mcp-server"],
      "env": {
        "NTFY_TOPIC": "your-topic-name",
        "NTFY_BASE_URL": "https://ntfy.sh"
      }
    }
  }
}
```

**Note:** `NTFY_TOPIC` is required. Set it in the `env` section of mcp.json.

### 3. Restart your MCP client

Restart Cursor, VS Code, or Claude Desktop to load the MCP server.

## Usage

### Available Tools

#### `send-ntfy`

Publish a message to the configured ntfy topic (set in mcp.json).

**Parameters:**
- `message` (required): The message body
- `title` (optional): Message title
- `priority` (optional): Priority level 1-5 (1=min, 3=default, 5=max)
- `tags` (optional): Array of tags/emojis
- `attachUrl` (optional): URL to attach

**Example:**
```json
{
  "message": "Hello from AI agent!",
  "title": "AI Notification",
  "priority": 4,
  "tags": ["robot", "ai"]
}
```

#### `set-ntfy-topic`

Change the ntfy topic for this session (no restart needed).

**Parameters:**
- `topic` (required): New topic name
- `baseUrl` (optional): New base URL

#### `wait-and-read-inbox`

Wait for new messages on the configured topic (set in mcp.json) and return any that arrive. Uses the existing subscription.

**Parameters:**
- `delaySeconds` (optional, default: 20): Seconds to wait between checks
- `maxTries` (optional, default: 1): Maximum number of attempts
- `since` (optional): Message ID or cursor to start from
- `sinceTime` (optional): Unix timestamp - only return messages with time >= sinceTime
- `sinceNow` (optional, default: true): Filter to only messages sent after this call

**Example:**
```json
{
  "delaySeconds": 5,
  "maxTries": 10,
  "sinceNow": true
}
```

### Available Resources

#### `ntfy://inbox`

Read recent messages for the configured topic. Returns JSON:

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

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NTFY_TOPIC` | Topic to send/receive messages (required) | (required) |
| `NTFY_BASE_URL` | ntfy server URL | `https://ntfy.sh` |
| `NTFY_AUTH_TOKEN` | Bearer token for protected topics | (optional) |
| `NTFY_USERNAME` | Username for basic auth | (optional) |
| `NTFY_PASSWORD` | Password for basic auth | (optional) |
| `NTFY_SINCE` | Initial backlog cursor | `1h` |
| `NTFY_FETCH_TIMEOUT_MS` | Fetch timeout in milliseconds | `10000` |
| `NTFY_CLEAN_ON_STARTUP` | Clear logs/cache on startup | `true` |
| `NTFY_KILL_EXISTING` | Kill existing server instances | `true` |

### CLI Arguments

You can also pass configuration via CLI arguments:

```bash
npx nfty-mcp-server --topic my-topic --base-url https://ntfy.sh --auth-token your-token
```

Available arguments:
- `--topic`: Topic name
- `--base-url` or `--server`: Base URL
- `--auth-token`: Bearer token
- `--username`: Username for basic auth
- `--password`: Password for basic auth
- `--since`: Initial backlog cursor
- `--log-incoming`: Log all incoming messages

## How It Works

1. **Subscription**: When the server starts, it automatically creates a persistent HTTP connection to the ntfy topic
2. **Real-time Delivery**: Messages arrive in real-time through the open connection
3. **Message Caching**: Recent messages (up to 50) are kept in memory and persisted to disk
4. **No Polling**: The connection stays open indefinitely - no need to poll for messages

## Use Cases

- 🤖 **AI Agent Communication**: Enable AI agents to send and receive notifications
- 📱 **Push Notifications**: Send push notifications from AI workflows
- 🔔 **Alert Systems**: Create alert systems that AI agents can interact with
- 💬 **Message Queues**: Use as a simple message queue for AI agent coordination
- 🔄 **Bidirectional Communication**: Enable two-way communication between AI agents and external systems

## Examples

### Example: AI Agent Sends Notification

```javascript
// AI agent uses the send-ntfy tool (topic is configured in mcp.json)
{
  "message": "Task completed successfully!",
  "title": "Task Status",
  "priority": 4
}
```

### Example: Wait for User Response

```javascript
// AI agent sends a question (topic is configured in mcp.json)
send-ntfy({
  message: "What is 2+2?",
  title: "Math Question"
})

// Then waits for response (uses topic from mcp.json)
wait-and-read-inbox({
  delaySeconds: 5,
  maxTries: 10,
  sinceNow: true
})
```

## Development

### Local Development

```bash
# Clone the repository
git clone https://github.com/harshwasan/NFTY-MCP.git
cd NFTY-MCP

# Install dependencies
npm install

# Run tests
npm test

# Run in development mode
npm run dev
```

### Project Structure

```
NFTY-MCP/
├── src/
│   └── server.js          # Main MCP server implementation
├── tests/
│   └── server.test.js     # Test suite
├── package.json
└── README.md
```

## Troubleshooting

### Messages not arriving

- Check that `NTFY_TOPIC` is set correctly
- Verify the topic exists on ntfy.sh
- Check the debug log at `src/nfty-debug.log`
- Ensure the subscription is running (check logs)

### Connection issues

- Verify network connectivity to ntfy.sh
- Check if using a custom `NTFY_BASE_URL` that it's accessible
- Review authentication settings if using protected topics

### Rate limiting

- The server automatically handles rate limiting with backoff
- Check `NTFY_HYDRATE_BACKOFF_MS` if you need to adjust backoff timing

## License

MIT

## Contributing

Contributions welcome! Please open an issue or submit a pull request.

## Note

This is a hobby personal project I made using AI and vibe coding - built organically through experimentation and iteration with AI assistance. 🎨🤖

## Links

- [ntfy.sh Documentation](https://docs.ntfy.sh)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [GitHub Repository](https://github.com/harshwasan/NFTY-MCP)
