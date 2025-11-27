import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfty-test-'));
  process.env.NTFY_CACHE_FILE = path.join(tempDir, 'cache.json');
  process.env.NTFY_TOPIC = 'test-topic';
  process.env.NTFY_BASE_URL = 'https://ntfy.example';
  process.env.NTFY_AUTH_TOKEN = 'secret';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  delete process.env.NTFY_CACHE_FILE;
  delete process.env.NTFY_TOPIC;
  delete process.env.NTFY_BASE_URL;
  delete process.env.NTFY_AUTH_TOKEN;
  vi.restoreAllMocks();
  if (typeof vi.unstubAllGlobals === 'function') {
    vi.unstubAllGlobals();
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
  vi.resetModules();
});

describe('ntfy MCP server core', () => {
  it('publishes messages with the configured headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 'abc', time: 123 })
    });
    vi.stubGlobal('fetch', fetchMock);

    const { publishMessage } = await import('../src/server.js');
    const result = await publishMessage({
      topic: 'custom',
      message: 'hello world',
      title: 'greeting',
      priority: 4,
      tags: ['one', 'two'],
      attach: 'https://example.com/file.txt'
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ntfy.example/custom',
      expect.objectContaining({
        method: 'POST',
        body: 'hello world',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          Title: 'greeting',
          Priority: '4',
          Tags: 'one,two',
          Attach: 'https://example.com/file.txt'
        })
      })
    );
    expect(result).toEqual({ id: 'abc', time: 123 });
  });

  it('stores inbound messages and wakes waiters', async () => {
    const module = await import('../src/server.js');
    const { handleIncoming, waitForNewMessages, recentMessages, getMessageVersion } = module;
    recentMessages.length = 0;

    const baselineVersion = getMessageVersion();
    const waitPromise = waitForNewMessages(baselineVersion, 200);

    handleIncoming({
      id: 'msg-1',
      event: 'message',
      time: Date.now(),
      title: 'note',
      message: 'hello from ntfy',
      priority: 3,
      tags: ['demo'],
      topic: 'test-topic'
    });

    await waitPromise;

    expect(recentMessages[0]).toMatchObject({
      id: 'msg-1',
      message: 'hello from ntfy',
      topic: 'test-topic'
    });

    const cacheContents = JSON.parse(fs.readFileSync(process.env.NTFY_CACHE_FILE, 'utf8'));
    expect(cacheContents[0].id).toBe('msg-1');
  });
});

