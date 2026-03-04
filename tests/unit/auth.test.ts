import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

// Mock SSM before importing modules that use it
vi.mock('@aws-sdk/client-ssm', () => {
  const sendFn = vi.fn();
  return {
    SSMClient: vi.fn(() => ({ send: sendFn })),
    GetParameterCommand: vi.fn((params: { Name: string }) => params),
    __mockSend: sendFn,
  };
});

import {
  verifySlackSignature,
  verifyMcpApiKey,
  clearSecretCache,
} from '../../backend/shared/auth';
import type { Logger } from '../../backend/shared/logger';

const { __mockSend: mockSsmSend } = await import('@aws-sdk/client-ssm') as any;

// Minimal logger stub
const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

const SIGNING_SECRET = 'test-signing-secret-value';
const MCP_ACCESS_KEY = 'test-mcp-key-12345';

function makeSlackSignature(body: string, timestamp: string, secret = SIGNING_SECRET): string {
  const baseString = `v0:${timestamp}:${body}`;
  return `v0=${createHmac('sha256', secret).update(baseString).digest('hex')}`;
}

function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('verifySlackSignature', () => {
  beforeEach(() => {
    clearSecretCache();
    vi.clearAllMocks();
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: SIGNING_SECRET },
    });
  });

  it('accepts a valid signature within the replay window', async () => {
    const body = '{"type":"event_callback"}';
    const ts = nowTimestamp();
    const sig = makeSlackSignature(body, ts);

    const result = await verifySlackSignature(body, ts, sig, logger);
    expect(result).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const body = '{"type":"event_callback"}';
    const ts = nowTimestamp();
    const sig = 'v0=0000000000000000000000000000000000000000000000000000000000000000';

    const result = await verifySlackSignature(body, ts, sig, logger);
    expect(result).toBe(false);
  });

  it('rejects a request with an expired timestamp (>5 min old)', async () => {
    const body = '{"type":"event_callback"}';
    const ts = String(Math.floor(Date.now() / 1000) - 400); // 6+ minutes ago
    const sig = makeSlackSignature(body, ts);

    const result = await verifySlackSignature(body, ts, sig, logger);
    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'Slack request outside replay window',
      expect.objectContaining({ age: expect.any(Number) }),
    );
  });

  it('rejects a non-numeric timestamp', async () => {
    const result = await verifySlackSignature('body', 'not-a-number', 'v0=abc', logger);
    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Invalid Slack timestamp format');
  });

  it('rejects when signature has mismatched length (timingSafeEqual throws)', async () => {
    const body = '{"type":"event_callback"}';
    const ts = nowTimestamp();
    // Wrong length signature — timingSafeEqual will throw, caught and returns false
    const sig = 'v0=short';

    const result = await verifySlackSignature(body, ts, sig, logger);
    expect(result).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const body = '{"type":"event_callback"}';
    const ts = nowTimestamp();
    const sig = makeSlackSignature(body, ts, 'wrong-secret');

    const result = await verifySlackSignature(body, ts, sig, logger);
    expect(result).toBe(false);
  });
});

describe('verifyMcpApiKey', () => {
  beforeEach(() => {
    clearSecretCache();
    vi.clearAllMocks();
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: MCP_ACCESS_KEY },
    });
  });

  it('accepts a valid API key', async () => {
    const result = await verifyMcpApiKey(MCP_ACCESS_KEY, logger);
    expect(result).toBe(true);
  });

  it('rejects an invalid API key', async () => {
    const result = await verifyMcpApiKey('wrong-key', logger);
    expect(result).toBe(false);
  });

  it('rejects undefined (missing header)', async () => {
    const result = await verifyMcpApiKey(undefined, logger);
    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Missing MCP API key');
  });

  it('rejects empty string', async () => {
    const result = await verifyMcpApiKey('', logger);
    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith('Missing MCP API key');
  });

  it('rejects key with mismatched length', async () => {
    const result = await verifyMcpApiKey('short', logger);
    expect(result).toBe(false);
  });
});

describe('secret caching', () => {
  beforeEach(() => {
    clearSecretCache();
    vi.clearAllMocks();
    mockSsmSend.mockResolvedValue({
      Parameter: { Value: SIGNING_SECRET },
    });
  });

  it('caches SSM lookups across calls', async () => {
    const body = '{"test":"1"}';
    const ts = nowTimestamp();
    const sig = makeSlackSignature(body, ts);

    await verifySlackSignature(body, ts, sig, logger);
    await verifySlackSignature(body, ts, sig, logger);

    // SSM should only be called once — second call uses cache
    expect(mockSsmSend).toHaveBeenCalledTimes(1);
  });

  it('clearSecretCache forces a fresh SSM lookup', async () => {
    const body = '{"test":"1"}';
    const ts = nowTimestamp();
    const sig = makeSlackSignature(body, ts);

    await verifySlackSignature(body, ts, sig, logger);
    clearSecretCache();
    await verifySlackSignature(body, ts, sig, logger);

    expect(mockSsmSend).toHaveBeenCalledTimes(2);
  });
});
