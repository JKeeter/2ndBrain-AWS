import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHmac } from 'crypto';

/**
 * Integration test: Full Slack webhook → embed → store → reply flow.
 * Mocks only external services (SSM, DynamoDB, OpenRouter, Slack API).
 * Exercises the real handler + shared modules wired together.
 */

const {
  SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  mockDynamoSend,
  mockFetch,
} = vi.hoisted(() => ({
  SIGNING_SECRET: 'integration-test-secret',
  SLACK_BOT_TOKEN: 'xoxb-test-token',
  mockDynamoSend: vi.fn().mockResolvedValue({}),
  mockFetch: vi.fn(),
}));

// --- Mock external services ---

vi.mock('@aws-sdk/client-ssm', () => {
  const send = vi.fn().mockImplementation((cmd: any) => {
    const paramMap: Record<string, string> = {
      '/second-brain/slack-signing-secret': SIGNING_SECRET,
      '/second-brain/slack-bot-token': SLACK_BOT_TOKEN,
      '/second-brain/openrouter-api-key': 'or-test-key',
    };
    const value = paramMap[cmd.Name];
    if (value) return Promise.resolve({ Parameter: { Value: value } });
    return Promise.reject(new Error(`SSM parameter not found: ${cmd.Name}`));
  });
  return {
    SSMClient: vi.fn(() => ({ send })),
    GetParameterCommand: vi.fn((p: any) => p),
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: mockDynamoSend })),
  PutItemCommand: vi.fn((p: any) => ({ ...p, _type: 'PutItem' })),
  QueryCommand: vi.fn(),
  ScanCommand: vi.fn(),
  BatchGetItemCommand: vi.fn(),
}));

vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: vi.fn((item: any) => item),
  unmarshall: vi.fn((item: any) => item),
}));

vi.mock('uuid', () => ({ v4: () => 'integ-uuid-5678' }));

// Mock global fetch for OpenRouter and Slack API calls
vi.stubGlobal('fetch', mockFetch);

import { handler } from '../../backend/functions/ingest-thought/handler';
import { clearSecretCache } from '../../backend/shared/auth';
import { clearEmbeddingCache } from '../../backend/shared/vector';

// --- Helpers ---

function sign(body: string, ts: string): string {
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function nowTs(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeGatewayEvent(body: string, extraHeaders: Record<string, string> = {}): APIGatewayProxyEvent {
  const ts = nowTs();
  return {
    body,
    headers: {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(body, ts),
      ...extraHeaders,
    },
    requestContext: { requestId: 'integ-req-1' } as any,
    httpMethod: 'POST',
    path: '/ingest',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    multiValueHeaders: {},
    stageVariables: null,
    resource: '',
    isBase64Encoded: false,
  } as APIGatewayProxyEvent;
}

// --- Tests ---

describe('ingest-thought integration flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretCache();
    clearEmbeddingCache();

    // Default fetch mock behavior: OpenRouter embedding → metadata → Slack reply
    mockFetch.mockImplementation((url: string, opts: any) => {
      // OpenRouter embedding
      if (url.includes('openrouter.ai') && url.includes('/embeddings')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [{ embedding: Array.from({ length: 1536 }, (_, i) => i * 0.001) }],
          }),
        });
      }

      // OpenRouter chat completions (metadata extraction)
      if (url.includes('openrouter.ai') && url.includes('/chat/completions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{
              message: {
                content: JSON.stringify({
                  type: 'idea',
                  topics: ['integration-testing', 'aws'],
                  people: ['Alice'],
                  action_items: ['Write more tests'],
                  dates: ['2025-06-15'],
                }),
              },
            }],
          }),
        });
      }

      // Slack API
      if (url.includes('slack.com')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });
  });

  it('processes a full message from Slack → embed → store → reply', async () => {
    const slackBody = JSON.stringify({
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'We should use DynamoDB for vector search at small scale',
        channel: 'C-BRAIN',
        ts: '9999999999.000001',
        user: 'U-ALICE',
      },
      event_id: 'Ev-INTEG-1',
      event_time: Math.floor(Date.now() / 1000),
      team_id: 'T-INTEG',
    });

    const event = makeGatewayEvent(slackBody);
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ ok: true });

    // Verify OpenRouter was called for embedding
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/embeddings'),
      expect.objectContaining({ method: 'POST' }),
    );

    // Verify OpenRouter was called for metadata extraction
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/chat/completions'),
      expect.objectContaining({ method: 'POST' }),
    );

    // Verify DynamoDB PutItem was called
    expect(mockDynamoSend).toHaveBeenCalled();

    // Verify Slack reply was posted
    const slackCall = mockFetch.mock.calls.find(
      (call: any[]) => call[0].includes('slack.com'),
    );
    expect(slackCall).toBeDefined();
    const slackPayload = JSON.parse(slackCall![1].body);
    expect(slackPayload.channel).toBe('C-BRAIN');
    expect(slackPayload.thread_ts).toBe('9999999999.000001');
    expect(slackPayload.text).toContain('Captured as idea');
    expect(slackPayload.text).toContain('integration-testing');
  });

  it('handles the URL verification handshake end-to-end', async () => {
    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'my-challenge-token',
      token: 'verification-token',
    });

    const event = makeGatewayEvent(body);
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ challenge: 'my-challenge-token' });

    // No external calls should be made for URL verification
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('rejects unsigned requests and makes no external calls', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', text: 'hi', channel: 'C1', ts: '1.1', user: 'U1' },
      event_id: 'Ev1', event_time: 123, team_id: 'T1',
    });

    const event: APIGatewayProxyEvent = {
      body,
      headers: {},
      requestContext: { requestId: 'bad-req' } as any,
      httpMethod: 'POST',
      path: '/ingest',
      pathParameters: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      multiValueHeaders: {},
      stageVariables: null,
      resource: '',
      isBase64Encoded: false,
    } as APIGatewayProxyEvent;

    const result = await handler(event);
    expect(result.statusCode).toBe(401);

    // No OpenRouter, DynamoDB, or Slack calls
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });

  it('returns 500 when OpenRouter embedding fails, does not store or reply', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/embeddings')) {
        return Promise.resolve({ ok: false, status: 503 });
      }
      if (url.includes('/chat/completions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: '{"type":"note","topics":[],"people":[],"action_items":[],"dates":[]}' } }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event: { type: 'message', text: 'test', channel: 'C1', ts: '1.1', user: 'U1' },
      event_id: 'Ev1', event_time: Math.floor(Date.now() / 1000), team_id: 'T1',
    });

    const event = makeGatewayEvent(body);
    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body)).toEqual({ error: 'Internal server error' });

    // DynamoDB should not have been called since embed failed
    expect(mockDynamoSend).not.toHaveBeenCalled();
  });
});
