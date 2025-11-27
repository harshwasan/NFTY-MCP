# MCP Server Setup Guide

## Check Your mcp.json Configuration

Your MCP configuration file should be at:
- **Windows**: `C:\Users\<YourUsername>\.cursor\mcp.json`
- **Mac/Linux**: `~/.cursor/mcp.json`

## Correct Configuration Format

```json
{
  "mcpServers": {
    "nfty": {
      "command": "npx",
      "args": ["-y", "nfty-mcp-server"],
      "env": {
        "NTFY_TOPIC": "2824KUb14oXUJkuR",
        "NTFY_BASE_URL": "https://ntfy.sh"
      }
    }
  }
}
```

## Troubleshooting Steps

1. **Verify the file exists and is valid JSON**
   ```bash
   # Check if file exists
   cat C:\Users\Admin\.cursor\mcp.json
   ```

2. **Test the server manually**
   ```bash
   npx -y nfty-mcp-server --help
   ```
   This should now show help text (fixed in v1.0.7)

3. **Check Cursor's MCP logs**
   - Open Cursor
   - Check the Output panel (View → Output)
   - Select "MCP" from the dropdown
   - Look for any error messages

4. **Restart Cursor completely**
   - Close all Cursor windows
   - Restart Cursor
   - The MCP server should connect automatically

5. **Verify the server is running**
   - Check if files are being created in `C:\Users\Admin\.nfty-mcp-server\`
   - If files appear there, the server is running but might not be connected to Cursor

## Common Issues

- **Server not in MCP list**: Usually means mcp.json is missing or has syntax errors
- **Server shows but tools don't work**: Check that NTFY_TOPIC is set correctly
- **Files still in project root**: Make sure you're using v1.0.6+ (check with `npm list nfty-mcp-server`)

## Update to Latest Version

```bash
npm install -g nfty-mcp-server@latest
# or if using npx, it will auto-update
```

