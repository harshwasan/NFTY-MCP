# Publishing Guide

## Before Publishing

1. **Repository URLs are already configured** for `harshwasan` in:
   - `package.json` (repository.url, bugs.url, homepage)
   - `README.md` (GitHub links)

3. **Add author information** (optional):
   - Update `author` field in `package.json`
   - Add `author` field with your name/email

## Publishing to npm

### First Time Publishing

1. **Create npm account** (if you don't have one):
   ```bash
   npm adduser
   ```

2. **Login to npm**:
   ```bash
   npm login
   ```

3. **Publish the package**:
   ```bash
   npm publish --access public
   ```

   Note: The package name `@nfty/mcp-server` uses a scoped namespace. You may need to:
   - Create an npm organization named `nfty`, OR
   - Change the package name to `nfty-mcp-server` (unscoped) in `package.json`

### Updating the Package

1. **Update version** in `package.json`:
   ```json
   "version": "1.0.1"
   ```

2. **Publish**:
   ```bash
   npm publish
   ```

## Publishing to GitHub

1. **Initialize git** (if not already):
   ```bash
   git init
   ```

2. **Create GitHub repository**:
   - Go to GitHub and create a new repository
   - Name it `NFTY-Mcp` (or your preferred name)

3. **Add remote and push**:
   ```bash
   git remote add origin https://github.com/harshwasan/NFTY-Mcp.git
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git push -u origin main
   ```

## VS Code Extension Store

To publish to VS Code Extension Store, you'll need to:

1. **Install vsce** (VS Code Extension Manager):
   ```bash
   npm install -g @vscode/vsce
   ```

2. **Create extension manifest** (`package.json` needs extension-specific fields):
   - Add `publisher` field
   - Add `displayName`, `description`, `categories`, etc.
   - See [VS Code Extension Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)

3. **Package and publish**:
   ```bash
   vsce package
   vsce publish
   ```

However, since this is an MCP server (not a VS Code extension), it's better to:
- Publish to npm (done above)
- Users install via `npx @nfty/mcp-server` in their MCP configuration
- VS Code/Cursor will automatically use it via npx

## Alternative: Unscoped Package Name

If you prefer an unscoped package name (easier for first-time publishing), change in `package.json`:

```json
{
  "name": "nfty-mcp-server",
  ...
}
```

Then publish with:
```bash
npm publish
```

