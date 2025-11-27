#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dns from 'node:dns';
import { Agent } from 'undici';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { z } from 'zod';

const textDecoder = new TextDecoder();
const DEFAULT_FETCH_TIMEOUT_MS = 10000;
const DEFAULT_HYDRATE_MIN_MS = 0;
const DEFAULT_HYDRATE_BACKOFF_MS = 2000; // quick retry on rate limit
const HYDRATE_IDLE_EXIT_MS = 1500;
const SUBSCRIBE_IDLE_EXIT_MS = 60000;
const LOCK_PATH = fileURLToPath(new URL('./nfty.lock', import.meta.url));
const MESSAGE_CACHE_PATH = path.resolve(
  process.env.NTFY_CACHE_FILE || fileURLToPath(new URL('./nfty-messages.json', import.meta.url))
);
const PROCESS_LOG_PATH = fileURLToPath(new URL('./nfty-process.log', import.meta.url));

// Configuration is loaded from environment variables set by mcp.json
// The mcp.json file (typically at ~/.cursor/mcp.json or C:\Users\<user>\.cursor\mcp.json)
// sets these environment variables in the "env" section of the server configuration.
// Priority: CLI args > environment variables (from mcp.json) > defaults

// Diagnostic: Log all NTFY-related environment variables for debugging
const debugLogFile = fileURLToPath(new URL('./nfty-debug.log', import.meta.url));
function debugLogSync(message, data = {}) {
  const line = `${new Date().toISOString()} ${message} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(debugLogFile, line);
  } catch {
    // Best-effort debug logging; ignore failures
  }
}

// Log all NTFY environment variables for diagnostics
const nftyEnvVars = {};
for (const key in process.env) {
  if (key.startsWith('NTFY_') || key.startsWith('MCP_NTFY_')) {
    nftyEnvVars[key] = process.env[key];
  }
}
debugLogSync('env:diagnostics', { 
  allNtfyEnvVars: nftyEnvVars,
  nodeVersion: process.version,
  platform: process.platform,
  argv: process.argv
});

const cliArgs = parseCliArgs(process.argv.slice(2));
const config = {
  baseUrl: normalizeBaseUrl(
    cliArgs.baseUrl ||
      process.env.NTFY_BASE_URL ||
      process.env.NTFY_SERVER ||
      'https://ntfy.sh'
  ),
  topic:
    cliArgs.topic ||
    process.env.NTFY_TOPIC ||
    process.env.MCP_NTFY_TOPIC ||
    '',
  authToken:
    cliArgs.authToken ||
    process.env.NTFY_AUTH_TOKEN ||
    process.env.MCP_NTFY_AUTH_TOKEN ||
    '',
  username: cliArgs.username || process.env.NTFY_USERNAME || '',
  password: cliArgs.password || process.env.NTFY_PASSWORD || '',
  // Start fresh each run; only process messages from startup forward
  // Use a valid zero-duration cursor so ntfy streams only new events.
  since: cliArgs.since || process.env.NTFY_SINCE || '0s',
  logIncoming: cliArgs.logIncoming || false,
  fetchTimeoutMs: Number(cliArgs.fetchTimeoutMs || process.env.NTFY_FETCH_TIMEOUT_MS || DEFAULT_FETCH_TIMEOUT_MS),
  hydrateMinMs: Number(cliArgs.hydrateMinMs || process.env.NTFY_HYDRATE_MIN_MS || DEFAULT_HYDRATE_MIN_MS),
  hydrateBackoffMs: Number(
    cliArgs.hydrateBackoffMs || process.env.NTFY_HYDRATE_BACKOFF_MS || DEFAULT_HYDRATE_BACKOFF_MS
  )
};

// Log final config for diagnostics
debugLogSync('config:final', {
  topic: config.topic || '(empty)',
  baseUrl: config.baseUrl,
  hasAuthToken: !!config.authToken,
  hasUsername: !!config.username,
  since: config.since,
  hydrateMinMs: config.hydrateMinMs,
  hydrateBackoffMs: config.hydrateBackoffMs,
  cliArgsProvided: Object.keys(cliArgs).length > 0
});

const inboxUri = 'ntfy://inbox';
const recentMessages = [];
let lastCursor = config.since;
let wasCleanedOnStartup = false;
let pollAbortController = null;
let shuttingDown = false;
let lastHydrateAt = 0;
let hydrateBackoffUntil = 0;
const fetchDispatcher = createIpv4Dispatcher();
let hydratedOnce = false;
// debugLogFile is now defined earlier for early diagnostics
let releaseLock = null;
const messageWaiters = new Set();
let subscriptionTask = null;
let subscriptionId = null; // Track subscription ID to avoid duplicates
let messageVersion = 0;
let processLogEntryId = null;
let processLogClosed = false;

// Clean logs and messages on startup (can be disabled via NTFY_CLEAN_ON_STARTUP=false)
function cleanOnStartup() {
  const shouldClean = process.env.NTFY_CLEAN_ON_STARTUP !== 'false';
  if (!shouldClean) {
    debugLogSync('clean:skipped', { reason: 'NTFY_CLEAN_ON_STARTUP=false' });
    return;
  }
  
  try {
    // Clear debug log
    if (fs.existsSync(debugLogFile)) {
      fs.writeFileSync(debugLogFile, '');
      debugLogSync('clean:debug-log', { action: 'cleared' });
    }
    
    // Clear process log
    if (fs.existsSync(PROCESS_LOG_PATH)) {
      fs.writeFileSync(PROCESS_LOG_PATH, '[]');
      debugLogSync('clean:process-log', { action: 'cleared' });
    }
    
    // Clear messages cache
    if (fs.existsSync(MESSAGE_CACHE_PATH)) {
      fs.writeFileSync(MESSAGE_CACHE_PATH, '[]');
      debugLogSync('clean:messages-cache', { action: 'cleared' });
    }
    
    debugLogSync('clean:complete', { 
      debugLog: true, 
      processLog: true, 
      messagesCache: true 
    });
    wasCleanedOnStartup = true;
  } catch (error) {
    debugLogSync('clean:error', { error: String(error) });
  }
}

// Kill all running nfty MCP server processes (can be disabled via NTFY_KILL_EXISTING=false)
// This runs before cleanOnStartup so we can read the process log before it's cleared
function killExistingServers() {
  const shouldKill = process.env.NTFY_KILL_EXISTING !== 'false';
  if (!shouldKill) {
    debugLogSync('kill:skipped', { reason: 'NTFY_KILL_EXISTING=false' });
    return;
  }
  
  try {
    // Load process log before it gets cleared
    let entries = [];
    if (fs.existsSync(PROCESS_LOG_PATH)) {
      try {
        const raw = fs.readFileSync(PROCESS_LOG_PATH, 'utf8');
        if (raw.trim()) {
          entries = JSON.parse(raw);
          if (!Array.isArray(entries)) {
            entries = [];
          }
        }
      } catch (error) {
        // Ignore parse errors
      }
    }
    
    const killedPids = [];
    
    for (const entry of entries) {
      if (!entry || entry.endedAt) {
        continue;
      }
      const pid = Number(entry.pid);
      if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
        continue;
      }
      
      // Check if process is alive by sending signal 0
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        if (error.code === 'ESRCH') {
          alive = false;
        } else if (error.code === 'EPERM') {
          alive = true;
        }
      }
      
      if (alive) {
        try {
          process.kill(pid, 'SIGTERM');
          // Give it a moment, then force kill if still alive
          setTimeout(() => {
            try {
              process.kill(pid, 0);
              // Still alive, force kill
              try {
                process.kill(pid, 'SIGKILL');
              } catch {}
            } catch {
              // Process already dead
            }
          }, 1000);
          killedPids.push(pid);
          debugLogSync('kill:process', { pid, status: 'terminated' });
        } catch (error) {
          debugLogSync('kill:error', { pid, error: String(error) });
        }
      }
    }
    
    if (killedPids.length > 0) {
      debugLogSync('kill:complete', { killedCount: killedPids.length, pids: killedPids });
    } else {
      debugLogSync('kill:complete', { killedCount: 0, message: 'no running servers found' });
    }
  } catch (error) {
    debugLogSync('kill:error', { error: String(error) });
  }
}

killExistingServers();
cleanOnStartup();
loadCachedMessages();
messageVersion = recentMessages.length;

const mcpServer = new McpServer(
  {
    name: 'nfty-mcp',
    version: '1.0.0'
  },
  {
    instructions:
      'An MCP server for sending and receiving messages through ntfy.sh. ' +
      'The server maintains a persistent subscription to the configured topic and receives messages in real-time. ' +
      '\n\n' +
      'Available tools:\n' +
      '- send-ntfy: Publish a message to the configured ntfy topic. Supports optional title, priority (1-5), tags, and attachUrl.\n' +
      '- set-ntfy-topic: Change the ntfy topic for this session (no restart needed).\n' +
      '- wait-and-read-inbox: Wait for new messages and return any that arrive. Uses the existing subscription if available.\n' +
      '\n' +
      'Available resources:\n' +
      '- ntfy://inbox: Read recent messages for the configured topic. Returns JSON with topic, baseUrl, and messages array.\n' +
      '\n' +
      'Configuration:\n' +
      '- Set NTFY_TOPIC in mcp.json env section to configure the topic (required).\n' +
      '- Set NTFY_BASE_URL in mcp.json env section or use --base-url to specify a custom ntfy server (default: https://ntfy.sh).\n' +
      '- Optional: NTFY_AUTH_TOKEN or NTFY_USERNAME/NTFY_PASSWORD in mcp.json env section for protected topics.\n' +
      '\n' +
      'Usage tips:\n' +
      '- Topic must be configured in mcp.json env section before using the tools.\n' +
      '- Use set-ntfy-topic to change the topic during the session (no restart needed).\n' +
      '- The subscription automatically starts when the server starts and stays open to receive messages in real-time.\n' +
      '- Messages are cached in memory (most recent 50) and persisted to disk.\n' +
      '- The subscription connection stays open indefinitely and receives all new messages as they arrive.\n' +
      '\n' +
      'Recommended workflow for interactive tasks:\n' +
      '1. Send a message using send-ntfy with your question or request.\n' +
      '2. Use wait-and-read-inbox to wait for a response (set appropriate delaySeconds and maxTries).\n' +
      '3. Check if a response was received before proceeding with the task.\n' +
      '4. If no response is received within the wait period, you may need to inform the user or retry.\n' +
      '\n' +
      'Example pattern:\n' +
      '- send-ntfy({ message: "Question here", title: "Question" })\n' +
      '- wait-and-read-inbox({ delaySeconds: 5, maxTries: 10, sinceNow: true })\n' +
      '- If newCount > 0, process the response. If newCount === 0, handle the timeout case appropriately.'
  }
);

mcpServer.registerTool(
  'send-ntfy',
  {
    title: 'Send ntfy message',
    description:
      'Publish a message to the configured ntfy topic (set in mcp.json). Supports optional title, priority (1-5), tags, and attachUrl. After sending, use wait-and-read-inbox to wait for responses.',
    inputSchema: z.object({
      message: z.string().min(1),
      title: z.string().optional(),
      priority: z.number().int().min(1).max(5).optional(),
      tags: z.array(z.string()).optional(),
      attachUrl: z.string().url().optional()
    }),
    outputSchema: z.object({
      topic: z.string(),
      id: z.string().optional(),
      status: z.string(),
      priority: z.number().optional(),
      time: z.number().optional()
    })
  },
  async (args) => {
    if (!config.topic) {
      throw new Error('Topic not configured. Set NTFY_TOPIC in mcp.json env section.');
    }
    
    const result = await publishMessage({
      topic: config.topic,
      message: args.message,
      title: args.title,
      priority: args.priority,
      tags: args.tags,
      attach: args.attachUrl
    });

    const output = {
      topic: config.topic,
      id: result.id,
      time: result.time,
      status: `Sent to ${config.topic}`,
      priority: args.priority
    };

    return {
      content: [
        {
          type: 'text',
          text: `Sent message to ${config.topic}${args.title ? ` (title: ${args.title})` : ''}`
        }
      ],
      structuredContent: output
    };
  }
);

mcpServer.registerTool(
  'set-ntfy-topic',
  {
    title: 'Set ntfy topic',
    description: 'Change the ntfy topic for this MCP server session (no restart needed).',
    inputSchema: z.object({
      topic: z.string().min(1),
      baseUrl: z.string().url().optional()
    }),
    outputSchema: z.object({
      topic: z.string(),
      baseUrl: z.string()
    })
  },
  async ({ topic, baseUrl }) => {
    await switchTopic(topic, baseUrl);
    return {
      content: [
        {
          type: 'text',
          text: `Switched ntfy topic to ${config.topic} at ${config.baseUrl}`
        }
      ],
      structuredContent: { topic: config.topic, baseUrl: config.baseUrl }
    };
  }
);

mcpServer.registerResource('inbox', inboxUri, {
  title: 'ntfy inbox',
  description: `Latest messages for the configured topic at ${config.baseUrl}. Topic must be set via set-ntfy-topic first.`
}, async () => {
  if (!config.topic) {
    return {
      contents: [
        {
          uri: inboxUri,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              topic: null,
              baseUrl: config.baseUrl,
              messages: [],
              error: 'Topic not configured. Set one via set-ntfy-topic tool first.'
            },
            null,
            2
          )
        }
      ]
    };
  }

  // Start subscription if not already running to receive new messages
  ensureSubscription();

  return {
    contents: [
      {
        uri: inboxUri,
        mimeType: 'application/json',
        text: JSON.stringify(
          {
            topic: config.topic,
            baseUrl: config.baseUrl,
            messages: [...recentMessages]
          },
          null,
          2
        )
      }
    ]
  };
});

mcpServer.registerTool(
  'wait-and-read-inbox',
  {
    title: 'Wait, then read ntfy inbox',
    description: 'Wait for new messages on the configured topic (set in mcp.json) and return any that arrived. Uses the existing subscription. Returns newCount - check if newCount > 0 before proceeding with tasks that require a response.',
    inputSchema: z.object({
      delaySeconds: z.number().int().min(1).max(600).default(20),
      maxTries: z.number().int().min(1).max(10).default(1),
      since: z.string().optional(),
      sinceTime: z.number().optional().describe('Unix timestamp - filter messages with time >= sinceTime (filtered in code, not in subscription)'),
      sinceNow: z.boolean().optional().default(true).describe('If true (default), filter to only messages sent after this call starts (filtered in code, not in subscription)')
    }),
    outputSchema: z.object({
      attempts: z.number(),
      newCount: z.number(),
      lastCursor: z.string().nullable(),
      messages: z.array(
        z.object({
          id: z.string().nullable(),
          time: z.number().nullable(),
          title: z.string().nullable().default(null),
          message: z.string().nullable(),
          priority: z.number().nullable().default(null),
          tags: z.array(z.string()).nullable().default(null),
          topic: z.string().nullable()
        })
      )
    })
  },
  async ({ delaySeconds = 20, maxTries = 1, since, sinceTime, sinceNow = true }) => {
    if (!config.topic) {
      throw new Error('Topic not configured. Set NTFY_TOPIC in mcp.json env section.');
    }

    if (since) {
      lastCursor = since;
    }

    // Keep total wait under protocol request timeout (~60s). Cap tries if needed.
    const maxWaitMs = 55000;
    const delayMs = delaySeconds * 1000;
    const effectiveTries = Math.max(1, Math.min(maxTries, Math.floor(maxWaitMs / delayMs) || 1));

    // Use existing subscription if available, otherwise create one
    // Check if subscription is actually running (task exists and hasn't completed)
    const subscriptionRunning = subscriptionTask && subscriptionId;
    if (!subscriptionRunning) {
      ensureSubscription();
      debugLog('wait:created-subscription', { topic: config.topic, subscriptionId });
    } else {
      debugLog('wait:using-existing-subscription', { topic: config.topic, subscriptionId });
    }

    const baselineVersion = messageVersion;
    const baselineCursor = lastCursor;
    let attempts = 0;

    for (let i = 0; i < effectiveTries; i++) {
      attempts++;
      await waitForNewMessages(baselineVersion, delayMs);
      if (messageVersion > baselineVersion) {
        break;
      }
    }

    // Get all messages since baseline cursor, then filter in code
    let newMessages = messagesSinceCursor(baselineCursor);
    
    // Filter by sinceTime or sinceNow if provided (filter in code, not in subscription)
    if (sinceTime !== undefined && sinceTime !== null) {
      newMessages = newMessages.filter(msg => msg.time && msg.time >= sinceTime);
    } else if (sinceNow) {
      // Filter to only messages sent after this call started
      const effectiveSinceTime = Math.floor(Date.now() / 1000);
      newMessages = newMessages.filter(msg => msg.time && msg.time >= effectiveSinceTime);
      debugLog('wait:filtered-sinceNow', { effectiveSinceTime, count: newMessages.length });
    }
    return {
      content: [
        {
          type: 'text',
          text:
            newMessages.length > 0
              ? `Found ${newMessages.length} new message(s) after ${attempts} attempt(s).`
              : `No new messages after ${attempts} attempt(s). Total wait ~${attempts * delaySeconds}s.`
        }
      ],
      structuredContent: {
        attempts,
        newCount: newMessages.length,
        lastCursor: lastCursor || null,
        messages: newMessages
      }
    };
  }
);

async function publishMessage({ topic, message, title, priority, tags, attach }) {
  if (!topic) {
    throw new Error('No topic configured. Set a topic or pass the topic parameter.');
  }

  const headers = {
    'Content-Type': 'text/plain',
    ...authHeaders()
  };

  if (title) headers.Title = title;
  if (priority) headers.Priority = String(priority);
  if (tags?.length) headers.Tags = tags.join(',');
  if (attach) headers.Attach = attach;

  const url = `${config.baseUrl}/${encodeURIComponent(topic)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: message,
    dispatcher: fetchDispatcher
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ntfy publish failed (${response.status}): ${errorText}`);
  }

  try {
    return await response.json();
  } catch {
    return { status: 'sent' };
  }
}

// This function opens a long-polling HTTP connection to ntfy that STREAMS messages automatically.
// When holdOpen=true, it's a subscription: the connection stays open and messages stream in as they arrive.
// It's not a "fetch" in the traditional sense - it's a persistent streaming connection.
// When the connection closes (timeout/network), it needs to be restarted (handled by ensureSubscription).
async function hydrateFromServer(options = {}) {
  if (!config.topic) {
    return;
  }

  const { signal: externalSignal, holdOpen = false } = options;
  const now = Date.now();
  if (now < hydrateBackoffUntil) {
    throw new Error(`Rate limited, retry after ${Math.ceil((hydrateBackoffUntil - now) / 1000)}s`);
  }
  if (!holdOpen && now - lastHydrateAt < config.hydrateMinMs) {
    return; // recently hydrated; avoid spamming server
  }

  const params = new URLSearchParams();
  // For subscriptions (holdOpen=true), don't use poll=1 or since - just connect and stay open
  // poll=1 causes the connection to close after reading messages
  // since is only for fetching cached messages, not for keeping connection open
  // For one-time fetches, use lastCursor or config.since to get cached messages
  let sinceParam = null;
  if (!holdOpen) {
    // For one-time fetch, use lastCursor or config.since, but replace '0s' with '1h'
    const baseSince = lastCursor && lastCursor !== config.since ? lastCursor : config.since;
    sinceParam = baseSince === '0s' ? '1h' : (baseSince || '1h');
    params.set('since', sinceParam);
  }
  // For subscriptions (holdOpen=true), don't add any params - just GET /topic/json
  const url = `${config.baseUrl}/${encodeURIComponent(config.topic)}/json${params.toString() ? '?' + params.toString() : ''}`;
  debugLog('hydrate:params', { holdOpen, sinceParam: sinceParam || 'none (subscription)', lastCursor, url });

  const controller = new AbortController();
  let externalAbortCleanup = null;
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const forwardAbort = () => controller.abort();
      externalSignal.addEventListener('abort', forwardAbort, { once: true });
      externalAbortCleanup = () => externalSignal.removeEventListener('abort', forwardAbort);
    }
  }
  const configuredTimeout =
    Number.isFinite(config.fetchTimeoutMs) && config.fetchTimeoutMs > 0
      ? config.fetchTimeoutMs
      : DEFAULT_FETCH_TIMEOUT_MS;
  // For subscriptions (holdOpen=true), no idle timeout - keep connection open indefinitely for real-time delivery
  // For one-time fetches, use a reasonable timeout to prevent hanging
  let idleTimer = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!holdOpen) {
      // Only use idle timeout for one-time fetches, not subscriptions
      const abortAfterIdle = Math.max(configuredTimeout, HYDRATE_IDLE_EXIT_MS);
      if (abortAfterIdle > 0) {
        idleTimer = setTimeout(() => controller.abort(), abortAfterIdle);
      }
    }
  };

  try {
    // For subscriptions, configure fetch to not timeout
    const fetchOptions = {
      headers: authHeaders(),
      signal: controller.signal,
      dispatcher: fetchDispatcher
    };
    
    // For long-polling subscriptions, disable timeouts
    if (holdOpen) {
      // No timeout for subscriptions - keep connection alive indefinitely
      fetchOptions.keepalive = true;
    }
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      if (response.status === 429) {
        hydrateBackoffUntil = Date.now() + config.hydrateBackoffMs;
      }
      debugLog('hydrate:error', { status: response.status, statusText: response.statusText });
      throw new Error(`Failed to fetch recent ntfy messages: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return;
    }

    resetIdleTimer();
    let buffer = '';
    let messageCount = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Stream ended - check if this was expected
        if (holdOpen) {
          debugLog('hydrate:connection-closed', { 
            reason: 'stream ended (done=true)', 
            topic: config.topic,
            messagesReceived: messageCount,
            lastCursor: lastCursor
          });
        }
        break;
      }
      if (value && value.length > 0) {
        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        const linesBefore = messageCount;
        parseLines(lines);
        // Count how many messages were actually parsed
        const newMessages = lines.filter(line => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          try {
            JSON.parse(trimmed);
            return true;
          } catch {
            return false;
          }
        }).length;
        messageCount += newMessages;
        if (holdOpen && newMessages > 0) {
          debugLog('hydrate:message-received', { count: newMessages, topic: config.topic });
        }
      }
      resetIdleTimer();
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      // idle timeout; treat as a soft success so the poller can continue
      return;
    }
    // Network/TLS errors surface as TypeError: fetch failed
    log('warning', { message: 'ntfy hydrate failed', error: String(error) });
    return;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (externalAbortCleanup) {
      externalAbortCleanup();
    }
    lastHydrateAt = Date.now();
    hydratedOnce = true;
  }
}

function ensureSubscription() {
  if (!config.topic || shuttingDown) {
    return;
  }
  if (subscriptionTask) {
    debugLog('subscribe:already-running', { topic: config.topic, subscriptionId });
    return subscriptionTask;
  }

  // Stop any existing subscription first
  stopSubscription();

  const controller = new AbortController();
  pollAbortController = controller;
  subscriptionId = crypto.randomUUID();
  const currentSubscriptionId = subscriptionId;

  subscriptionTask = (async () => {
    try {
      // The long-poll connection streams messages automatically
      // Connection is configured to not timeout - it stays open indefinitely
      // If it closes, we don't retry - just stop
      debugLog('subscribe:starting', { topic: config.topic, subscriptionId: currentSubscriptionId, lastCursor });
      
      // If we don't have a valid message ID cursor, fetch the latest message ID first
      if (!lastCursor || lastCursor === config.since || lastCursor === '0s' || lastCursor.match(/^\d+[smhd]$/) || (lastCursor.match(/^\d+$/) && recentMessages.length === 0)) {
        // No valid cursor - fetch latest message to get an ID
        debugLog('subscribe:fetching-latest-id', { topic: config.topic });
        try {
          const quickUrl = `${config.baseUrl}/${encodeURIComponent(config.topic)}/json?since=1h&limit=1`;
          const quickResponse = await fetch(quickUrl, {
            headers: authHeaders(),
            dispatcher: fetchDispatcher,
            signal: AbortSignal.timeout(5000)
          });
          
          if (quickResponse.ok) {
            const quickReader = quickResponse.body?.getReader();
            if (quickReader) {
              let quickBuffer = '';
              while (true) {
                const { value, done } = await quickReader.read();
                if (done) break;
                quickBuffer += textDecoder.decode(value, { stream: true });
              }
              const lines = quickBuffer.split('\n').filter(l => l.trim());
              if (lines.length > 0) {
                try {
                  const latestMsg = JSON.parse(lines[lines.length - 1]);
                  if (latestMsg.id) {
                    lastCursor = latestMsg.id;
                    debugLog('subscribe:got-latest-id', { id: latestMsg.id, topic: config.topic });
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }
          }
        } catch (error) {
          debugLog('subscribe:fetch-id-failed', { error: String(error), topic: config.topic });
          // Continue anyway - hydrateFromServer will handle it
        }
      }
      
      await hydrateFromServer({ signal: controller.signal, holdOpen: true });
      hydrateBackoffUntil = 0;
      debugLog('subscribe:ended', { topic: config.topic, reason: 'connection closed normally' });
    } catch (error) {
      if (error.name === 'AbortError' || shuttingDown) {
        // Intentionally aborted or shutting down - don't log
        debugLog('subscribe:aborted', { topic: config.topic, reason: shuttingDown ? 'shutting down' : 'aborted' });
        return;
      }
      debugLog('subscribe:error', { error: String(error), stack: error.stack });
      // Connection closed - don't retry, just stop
    } finally {
      // Clean up when subscription stops
      // Only clean up if this is still the current subscription (not replaced by a new one)
      if (subscriptionId === currentSubscriptionId) {
        debugLog('subscribe:cleanup', { topic: config.topic, subscriptionId: currentSubscriptionId });
        subscriptionTask = null;
        pollAbortController = null;
        subscriptionId = null;
      } else {
        debugLog('subscribe:cleanup-skipped', { topic: config.topic, subscriptionId: currentSubscriptionId, currentId: subscriptionId });
      }
    }
  })();

  return subscriptionTask;
}

function stopSubscription() {
  if (pollAbortController) {
    debugLog('subscribe:stopping', { topic: config.topic, subscriptionId });
    pollAbortController.abort();
    pollAbortController = null;
  }
  if (subscriptionTask) {
    // Wait a bit for the task to clean up, but don't block forever
    subscriptionTask.catch(() => {}).finally(() => {
      subscriptionTask = null;
      subscriptionId = null;
    });
  }
}

function parseLines(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      handleIncoming(parsed);
    } catch (error) {
      log('debug', { message: 'Failed to parse ntfy line', line, error: String(error) });
    }
  }
}

function handleIncoming(message) {
  if (!message || typeof message !== 'object') return;
  if (message.event && message.event !== 'message') return;

  if (message.id) {
    lastCursor = message.id;
  } else if (message.time) {
    lastCursor = String(message.time);
  }

  recentMessages.unshift({
    id: message.id,
    time: message.time,
    title: message.title,
    message: message.message,
    priority: message.priority,
    tags: message.tags,
    topic: message.topic
  });
  debugLog('incoming', { id: message.id, time: message.time, message: message.message });

  if (recentMessages.length > 50) {
    recentMessages.length = 50;
  }
  messageVersion++;
  persistMessages();
  notifyWaiters();

  if (config.logIncoming) {
    log('info', { message: 'ntfy incoming', payload: message });
  }

  if (mcpServer.isConnected()) {
    mcpServer.server.sendResourceUpdated({ uri: inboxUri }).catch(() => {});
  }
}

function waitForNewMessages(baselineVersion, timeoutMs) {
  if (messageVersion > baselineVersion) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    const waiter = () => {
      if (messageVersion > baselineVersion) {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      messageWaiters.delete(waiter);
    };

    messageWaiters.add(waiter);
  });
}

function notifyWaiters() {
  for (const waiter of [...messageWaiters]) {
    waiter();
  }
}

function messagesSinceCursor(cursor, sinceTime) {
  let messages;
  if (!cursor) {
    messages = [...recentMessages];
  } else {
    const stopIndex = recentMessages.findIndex((message) => cursorForMessage(message) === cursor);
    if (stopIndex === -1) {
      messages = [...recentMessages];
    } else {
      messages = recentMessages.slice(0, stopIndex);
    }
  }
  
  // Filter by timestamp if provided (only messages with time >= sinceTime)
  if (sinceTime !== undefined && sinceTime !== null) {
    messages = messages.filter(msg => msg.time && msg.time >= sinceTime);
  }
  
  // Normalize messages to ensure all schema-required fields are present (null if missing)
  return messages.map(msg => ({
    id: msg.id ?? null,
    time: msg.time ?? null,
    title: msg.title ?? null,
    message: msg.message ?? null,
    priority: msg.priority ?? null,
    tags: msg.tags ?? null,
    topic: msg.topic ?? null
  }));
}

function cursorForMessage(message) {
  if (!message) {
    return null;
  }
  if (message.id) {
    return message.id;
  }
  if (message.time !== undefined && message.time !== null) {
    return String(message.time);
  }
  return null;
}

function persistMessages() {
  try {
    fs.writeFileSync(MESSAGE_CACHE_PATH, JSON.stringify(recentMessages, null, 2));
  } catch (error) {
    debugLog('cache:write-error', { error: String(error) });
  }
}

function loadCachedMessages() {
  try {
    if (!fs.existsSync(MESSAGE_CACHE_PATH)) {
      return;
    }
    const raw = fs.readFileSync(MESSAGE_CACHE_PATH, 'utf8');
    if (!raw.trim()) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      recentMessages.push(...parsed.slice(0, 50));
      // Update lastCursor to the most recent cached message to avoid re-fetching old messages
      if (recentMessages.length > 0) {
        const mostRecent = recentMessages[0]; // Messages are in reverse chronological order (newest first)
        const cursor = cursorForMessage(mostRecent);
        if (cursor) {
          lastCursor = cursor;
          debugLog('cache:loaded', { count: recentMessages.length, lastCursor });
        }
      }
    }
  } catch (error) {
    debugLog('cache:load-error', { error: String(error) });
  }
}

function getMessageVersion() {
  return messageVersion;
}

function authHeaders() {
  const headers = {};
  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  } else if (config.username && config.password) {
    const token = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  return headers;
}

function normalizeBaseUrl(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function parseCliArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    const next = argv[i + 1];
    switch (current) {
      case '--topic':
        args.topic = next;
        i++;
        break;
      case '--base-url':
      case '--server':
        args.baseUrl = next;
        i++;
        break;
      case '--auth-token':
        args.authToken = next;
        i++;
        break;
      case '--username':
        args.username = next;
        i++;
        break;
      case '--password':
        args.password = next;
        i++;
        break;
      case '--since':
        args.since = next;
        i++;
        break;
      case '--log-incoming':
        args.logIncoming = true;
        break;
      default:
        break;
    }
  }
  return args;
}

function log(level, data) {
  if (!mcpServer.isConnected()) return;
  mcpServer.server.sendLoggingMessage({ level, data }).catch(() => {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function switchTopic(newTopic, newBaseUrl) {
  if (!newTopic) throw new Error('Topic is required');
  config.topic = newTopic;
  if (newBaseUrl) {
    config.baseUrl = normalizeBaseUrl(newBaseUrl);
  }
  recentMessages.length = 0;
  messageVersion = 0;
  persistMessages();
  lastCursor = config.since;
  hydrateBackoffUntil = 0;
  lastHydrateAt = 0;
  stopSubscription();
  ensureSubscription();
}

function createIpv4Dispatcher() {
  return new Agent({
    connect: {
      // Prefer IPv4 to avoid environments where IPv6 is blocked/slow
      family: 4,
      lookup(host, opts, cb) {
        dns.lookup(host, { ...opts, family: 4, all: false }, cb);
      }
    },
    // Configure timeouts to prevent connection from timing out
    // For subscriptions, we want very long timeouts or no timeout
    bodyTimeout: 0, // No timeout on body (for streaming)
    headersTimeout: 0, // No timeout on headers
    keepAliveTimeout: 600000, // 10 minutes keep-alive
    keepAliveMaxTimeout: 600000, // 10 minutes max keep-alive
    keepAliveTimeoutThreshold: 1000 // 1 second threshold
  });
}

function debugLog(message, data = {}) {
  const line = `${new Date().toISOString()} ${message} ${JSON.stringify(data)}\n`;
  try {
    fs.appendFileSync(debugLogFile, line);
  } catch {
    // Best-effort debug logging; ignore failures
  }
}

function loadProcessLogEntries() {
  try {
    if (!fs.existsSync(PROCESS_LOG_PATH)) {
      return [];
    }
    const raw = fs.readFileSync(PROCESS_LOG_PATH, 'utf8');
    if (!raw.trim()) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    debugLog('processLog:load-error', { error: String(error) });
    return [];
  }
}

function saveProcessLogEntries(entries) {
  try {
    fs.writeFileSync(PROCESS_LOG_PATH, JSON.stringify(entries, null, 2));
  } catch (error) {
    debugLog('processLog:write-error', { error: String(error) });
  }
}

function cleanOrphanProcesses() {
  const entries = loadProcessLogEntries();
  let mutated = false;
  for (const entry of entries) {
    if (!entry || entry.endedAt) {
      continue;
    }
    const pid = Number(entry.pid);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) {
      entry.status = entry.status || 'stale';
      entry.endedAt = new Date().toISOString();
      mutated = true;
      continue;
    }
    const alive = isProcessAlive(pid);
    if (alive) {
      try {
        process.kill(pid);
        entry.status = 'terminated';
      } catch (error) {
        console.error(`Failed to terminate orphaned ntfy MCP process ${pid}: ${error}`);
        process.exit(1);
      }
    } else {
      entry.status = 'stale';
    }
    entry.endedAt = new Date().toISOString();
    mutated = true;
  }
  if (mutated) {
    saveProcessLogEntries(entries);
  }
}

function recordProcessStart() {
  const entries = loadProcessLogEntries();
  const entry = {
    id: crypto.randomUUID(),
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running'
  };
  entries.push(entry);
  saveProcessLogEntries(entries);
  processLogEntryId = entry.id;
  processLogClosed = false;
}

function finalizeProcessLog(status) {
  if (!processLogEntryId || processLogClosed) {
    return;
  }
  const entries = loadProcessLogEntries();
  const entry = entries.find((item) => item && item.id === processLogEntryId);
  if (!entry) {
    processLogClosed = true;
    return;
  }
  entry.status = status;
  entry.endedAt = new Date().toISOString();
  saveProcessLogEntries(entries);
  processLogClosed = true;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function acquireLock() {
  try {
    while (true) {
      try {
        const fd = fs.openSync(LOCK_PATH, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeFileSync(fd, String(process.pid));
        fs.closeSync(fd);
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        const existingPid = Number(fs.readFileSync(LOCK_PATH, 'utf8'));
        if (Number.isFinite(existingPid) && existingPid > 0) {
          try {
            process.kill(existingPid, 0);
            console.error(`Another ntfy MCP server is already running (pid ${existingPid}). Exiting.`);
            process.exit(1);
          } catch {
            try {
              fs.unlinkSync(LOCK_PATH);
            } catch {}
            continue;
          }
        } else {
          try {
            fs.unlinkSync(LOCK_PATH);
          } catch {}
        }
      }
    }
    return () => {
      try {
        if (fs.existsSync(LOCK_PATH)) {
          const existing = Number(fs.readFileSync(LOCK_PATH, 'utf8'));
          if (existing === process.pid) {
            fs.unlinkSync(LOCK_PATH);
          }
        }
      } catch {
        // ignore cleanup failures
      }
    };
  } catch (error) {
    console.error(`Failed to acquire lock: ${error}`);
    process.exit(1);
  }
}

debugLog('startup', {
  pid: process.pid,
  cwd: process.cwd(),
  topic: config.topic || '(EMPTY - check mcp.json env section)',
  baseUrl: config.baseUrl,
  configSource: config.topic ? (cliArgs.topic ? 'CLI' : 'mcp.json (env)') : 'NOT CONFIGURED',
  envNTFY_TOPIC: process.env.NTFY_TOPIC || '(not set)',
  envNTFY_BASE_URL: process.env.NTFY_BASE_URL || '(not set)',
  envMCP_NTFY_TOPIC: process.env.MCP_NTFY_TOPIC || '(not set)',
  allProcessEnvKeys: Object.keys(process.env).filter(k => k.includes('NTFY') || k.includes('MCP')).join(', ') || '(none)'
});
async function main() {
  try {
    cleanOrphanProcesses();
    releaseLock = acquireLock();
    recordProcessStart();
    const transport = new StdioServerTransport();
    debugLog('connect:start');
    
    // Add error handlers to catch MCP protocol errors
    mcpServer.onerror = (error) => {
      debugLog('mcp:error', { error: String(error), stack: error.stack });
      console.error('MCP Server error:', error);
    };
    
    await mcpServer.connect(transport);
    debugLog('connect:ready', { 
      serverName: mcpServer.name,
      serverVersion: mcpServer.version,
      isConnected: mcpServer.isConnected()
    });
    
    // Start subscription once on startup if topic is configured in mcp.json
    // First ensure any existing subscription is stopped
    stopSubscription();
    if (config.topic) {
      ensureSubscription();
      debugLog('subscription:started', { topic: config.topic, subscriptionId });
    } else {
      debugLog('config:warning', { message: 'No topic configured. Set NTFY_TOPIC in mcp.json env section.' });
    }
  } catch (error) {
    debugLog('main:error', { error: String(error), stack: error.stack });
    console.error('Failed to start MCP server:', error);
    if (releaseLock) {
      releaseLock();
    }
    finalizeProcessLog('crashed');
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  debugLog('shutdown');
  stopSubscription();
  if (subscriptionTask) {
    try {
      await subscriptionTask;
    } catch {}
  }
  await mcpServer.close();
  if (releaseLock) {
    releaseLock();
  }
  finalizeProcessLog('stopped');
  process.exit(0);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((error) => {
    console.error(error);
    if (releaseLock) {
      releaseLock();
    }
    finalizeProcessLog('crashed');
    process.exit(1);
  });
}
process.on('exit', () => finalizeProcessLog(processLogClosed ? 'stopped' : 'exited'));
process.on('uncaughtException', (error) => {
  console.error(error);
  finalizeProcessLog('crashed');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason);
  finalizeProcessLog('crashed');
  process.exit(1);
});

function resetTestState() {
  recentMessages.length = 0;
  messageVersion = 0;
  lastCursor = config.since;
  messageWaiters.clear();
  try {
    fs.unlinkSync(MESSAGE_CACHE_PATH);
  } catch {}
}

function applyTestConfig(overrides = {}) {
  Object.assign(config, overrides);
}

function getCachePath() {
  return MESSAGE_CACHE_PATH;
}

export {
  publishMessage,
  handleIncoming,
  waitForNewMessages,
  recentMessages,
  getMessageVersion,
  resetTestState,
  applyTestConfig,
  getCachePath,
  ensureSubscription
};
