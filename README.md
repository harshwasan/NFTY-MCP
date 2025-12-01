# NTFY MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that enables AI agents to send and receive messages through [ntfy.sh](https://ntfy.sh) with real-time subscriptions. Perfect for building AI agents that can communicate via push notifications and enabling bidirectional chat workflows.

## Intended Use Case

This server was designed to enable **bidirectional communication** between you and AI agents through a shared ntfy topic. The typical workflow is:

1. **You send a message** to the ntfy topic (via the ntfy.sh web interface, mobile app, or API)
2. **The AI agent receives it** through the `wait-and-read-inbox` tool or `ntfy://inbox` resource
3. **The AI agent responds** using the `send-ntfy` tool
4. **You receive the response** as a push notification on your device
5. **The cycle continues** - you can reply, and the AI will wait for your next message

This creates an **asynchronous chat interface** where you can communicate with AI agents at your own pace, receiving push notifications when they respond, and they can wait for your replies even if you take hours or days to respond.

**Important for Chat Workflows:** The MCP protocol has a client-side timeout of approximately 60 seconds. When using `wait-and-read-inbox` for chat, you may need to:
- **Tell the AI to retry** the `wait-and-read-inbox` call if it times out without receiving a message
- **Configure the AI** to automatically retry after timeouts when waiting for your response
- **Use a prompt** that instructs the AI to keep waiting until it gets a response, retrying as needed

The AI agent can keep retrying `wait-and-read-inbox` indefinitely until it receives your message, making this suitable for long-running conversations where responses may take hours or days.

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
      "args": ["-y", "--yes", "nfty-mcp-server"],
      "env": {
        "NTFY_TOPIC": "your-topic-name",
        "NTFY_BASE_URL": "https://ntfy.sh"
      }
    }
  }
}
```

**Note:** `NTFY_TOPIC` is required. Set it in the `env` section of mcp.json.

**Important:** The `--yes` flag ensures npx installs the package in its cache directory instead of your project directory, preventing dependencies from being installed in your project's `node_modules`.

#### For Claude Desktop

Add to `claude_desktop_config.json`:

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

**Note:** `NTFY_TOPIC` is required. Set it in the `env` section of mcp.json.

**Important:** The `--yes` flag ensures npx installs the package in its cache directory instead of your project directory, preventing dependencies from being installed in your project's `node_modules`.

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

Wait for new messages on the configured topic (set in mcp.json) and return when a new message arrives. Does not return until at least one new message is received. Uses the existing subscription.

**Note:** The MCP protocol has a ~60s client-side timeout that cannot be controlled from the server, but this tool will wait as long as possible within that limit.

**Parameters:**
- `since` (optional): Cursor to filter messages after this point
- `sinceTime` (optional): Unix timestamp - filter messages with time >= sinceTime
- `sinceNow` (optional, default: true): If true (default), only returns messages sent after this call starts. If false, returns all messages since the cursor.

**Timeout Behavior for Chat Workflows:**

When using this for bidirectional chat, the tool may timeout after ~60 seconds if no message arrives. To handle this:

1. **Configure the AI to retry:** Tell the AI agent to automatically retry `wait-and-read-inbox` when it times out if it's waiting for your response
2. **Use a prompt:** Create a prompt that instructs the AI to "keep waiting for a response, retrying wait-and-read-inbox if it times out"
3. **Manual retry:** You can manually ask the AI to try again if it times out

The AI can keep retrying indefinitely until it receives your message, making this suitable for long-running conversations.

**Example:**
```json
{
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

### Data Storage

The server stores its data files (logs, message cache, lock files) in a dedicated directory to avoid cluttering your project:

- **Default location**: `~/.nfty-mcp-server/` (or `C:\Users\<user>\.nfty-mcp-server\` on Windows)
- **Custom location**: Set `NTFY_DATA_DIR` environment variable to use a different directory

**Files stored:**
- `nfty-messages.json` - Cached messages
- `nfty-debug.log` - Debug logs
- `nfty-process.log` - Process management logs
- `nfty.lock` - Lock file to prevent multiple instances

**Note:** The server will automatically create this directory if it doesn't exist. Files are never created in your project root or in `node_modules`.

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
| `NTFY_DATA_DIR` | Directory for data files (logs, cache, lock) | `~/.nfty-mcp-server/` |
| `NTFY_CACHE_FILE` | Custom path for message cache file | `{NTFY_DATA_DIR}/nfty-messages.json` |

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

- 💬 **Bidirectional Chat**: Chat with AI agents asynchronously via push notifications - send messages when convenient, receive responses as notifications
- 🤖 **AI Agent Communication**: Enable AI agents to send and receive notifications
- 📱 **Push Notifications**: Send push notifications from AI workflows
- 🔔 **Alert Systems**: Create alert systems that AI agents can interact with
- 💬 **Message Queues**: Use as a simple message queue for AI agent coordination
- 🔄 **Long-running Workflows**: Enable workflows where the AI waits for human input that may take hours or days

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

### Example: Chat Workflow

```javascript
// AI agent sends a question (topic is configured in mcp.json)
send-ntfy({
  message: "What is 2+2?",
  title: "Math Question"
})

// Then waits for response (uses topic from mcp.json)
// Note: If this times out (~60s), the AI should retry until it gets a response
wait-and-read-inbox({
  sinceNow: true
})
```

**For reliable chat workflows**, configure your AI with a prompt like:

> "When waiting for a user response via wait-and-read-inbox, if the call times out without receiving a message, automatically retry the wait-and-read-inbox call. Keep retrying until you receive a response from the user."

This ensures the AI will continue waiting for your reply even if individual calls timeout.

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

## Why Runkit Shows "Unavailable"

[Runkit](https://runkit.com/npm/nfty-mcp-server) may show this package as unavailable because:

1. **CLI Tool**: This is primarily a CLI tool designed to run as an MCP server, not a library with exportable functions
2. **No Default Export**: The package doesn't export functions that can be easily imported and used in Runkit's sandbox environment
3. **MCP Protocol**: It's designed to communicate via the MCP protocol with MCP clients (like Cursor, Claude Desktop), not to be executed directly in a browser-like environment

This is expected behavior - the package is intended to be used as an MCP server, not as a runnable script in Runkit. Use it via `npx` or install it globally as described in the Installation section.

## Links

- [ntfy.sh Documentation](https://docs.ntfy.sh)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [GitHub Repository](https://github.com/harshwasan/NFTY-MCP)
