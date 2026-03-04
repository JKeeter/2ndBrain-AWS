import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHmac } from 'crypto';

// --- Hoisted mocks (vi.hoisted runs before vi.mock factories) ---

const {
  SIGNING_SECRET,
  mockEmbedText,
  mockExtractMetadata,
  mockPostThreadReply,
} = vi.hoisted(() => ({
  SIGNING_SECRET: 'test-signing-secret',
  mockEmbedText: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])),
  mockExtractMetadata: vi.fn().mockResolvedValue({
    type: 'note',
    topics: ['testing'],
    people: [],
    action_items: [],
    dates: [],
  }),
  mockPostThreadReply: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ Parameter: { Value: SIGNING_SECRET } }),
  })),
  GetParameterCommand: vi.fn((p: any) => p),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  PutItemCommand: vi.fn((p: any) => p),
  QueryCommand: vi.fn(),
  ScanCommand: vi.fn(),
  BatchGetItemCommand: vi.fn(),
}));

vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: vi.fn((item: any) => item),
  unmarshall: vi.fn((item: any) => item),
}));

vi.mock('../../backend/shared/openrouter', () => ({
  embedText: (...args: any[]) => mockEmbedText(...args),
  extractMetadata: (...args: any[]) => mockExtractMetadata(...args),
}));

vi.mock('../../backend/shared/slack', () => ({
  postThreadReply: (...args: any[]) => mockPostThreadReply(...args),
}));

vi.mock('../../backend/shared/vector', () => ({
  embeddingToBuffer: vi.fn((e: any) => Buffer.from(e.buffer)),
  bufferToEmbedding: vi.fn((b: any) => new Float32Array(b.buffer)),
  clearEmbeddingCache: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

import { handler } from '../../backend/functions/ingest-thought/handler';
import { clearSecretCache } from '../../backend/shared/auth';

// --- Helpers ---

function makeSignature(body: string, timestamp: string): string {
  const baseString = `v0:${timestamp}:${body}`;
  return `v0=${createHmac('sha256', SIGNING_SECRET).update(baseString).digest('hex')}`;
}

function nowTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  const body = overrides.body ?? JSON.stringify({
    type: 'event_callback',
    event: {
      type: 'message',
      text: 'Hello world',
      channel: 'C123',
      ts: '1234567890.123456',
      user: 'U123',
    },
    event_id: 'Ev123',
    event_time: 1234567890,
    team_id: 'T123',
  });
  const ts = nowTimestamp();

  return {
    body,
    headers: {
      'x-slack-request-timestamp': ts,
      'x-slack-signature': makeSignature(body, ts),
      ...overrides.headers,
    },
    requestContext: { requestId: 'test-req-id' } as any,
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

describe('ingest-thought handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretCache();
  });

  describe('URL verification challenge', () => {
    it('returns the challenge value for url_verification', async () => {
      const body = JSON.stringify({
        type: 'url_verification',
        challenge: 'test-challenge-abc',
        token: 'tok',
      });
      const ts = nowTimestamp();
      const event = makeEvent({
        body,
        headers: {
          'x-slack-request-timestamp': ts,
          'x-slack-signature': makeSignature(body, ts),
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ challenge: 'test-challenge-abc' });
    });
  });

  describe('signature verification', () => {
    it('rejects requests with missing signature headers', async () => {
      const event = {
        body: JSON.stringify({ type: 'event_callback', event: { type: 'message', text: 'hi', channel: 'C1', ts: '1.1', user: 'U1' }, event_id: 'Ev1', event_time: 123, team_id: 'T1' }),
        headers: {},
        requestContext: { requestId: 'test-req-id' } as any,
        httpMethod: 'POST', path: '/ingest', pathParameters: null,
        queryStringParameters: null, multiValueQueryStringParameters: null,
        multiValueHeaders: {}, stageVariables: null, resource: '', isBase64Encoded: false,
      } as APIGatewayProxyEvent;
      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });

    it('rejects requests with invalid signature', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        event: { type: 'message', text: 'hi', channel: 'C1', ts: '1.1', user: 'U1' },
        event_id: 'Ev1', event_time: 123, team_id: 'T1',
      });
      const ts = nowTimestamp();
      const event = makeEvent({
        body,
        headers: {
          'x-slack-request-timestamp': ts,
          'x-slack-signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(401);
    });
  });

  describe('valid message flow', () => {
    it('processes a message and returns 200', async () => {
      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true });
    });

    it('calls embedText and extractMetadata in parallel', async () => {
      await handler(makeEvent());

      expect(mockEmbedText).toHaveBeenCalledWith('Hello world', expect.anything());
      expect(mockExtractMetadata).toHaveBeenCalledWith('Hello world', expect.anything());
    });

    it('posts a reply in the Slack thread', async () => {
      await handler(makeEvent());

      expect(mockPostThreadReply).toHaveBeenCalledWith(
        'C123',
        '1234567890.123456',
        expect.stringContaining('Captured as *note*'),
        expect.anything(),
      );
    });
  });

  describe('bot messages and subtypes', () => {
    it('skips messages with bot_id', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'Bot message',
          channel: 'C1',
          ts: '1.1',
          user: 'U1',
          bot_id: 'B123',
        },
        event_id: 'Ev1',
        event_time: 123,
        team_id: 'T1',
      });
      const ts = nowTimestamp();
      const event = makeEvent({
        body,
        headers: {
          'x-slack-request-timestamp': ts,
          'x-slack-signature': makeSignature(body, ts),
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(mockEmbedText).not.toHaveBeenCalled();
    });

    it('skips messages with subtype (e.g., message_changed)', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        event: {
          type: 'message',
          text: 'Edited text',
          channel: 'C1',
          ts: '1.1',
          user: 'U1',
          subtype: 'message_changed',
        },
        event_id: 'Ev1',
        event_time: 123,
        team_id: 'T1',
      });
      const ts = nowTimestamp();
      const event = makeEvent({
        body,
        headers: {
          'x-slack-request-timestamp': ts,
          'x-slack-signature': makeSignature(body, ts),
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(mockEmbedText).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('returns 400 for missing request body', async () => {
      const event = {
        body: null,
        headers: { 'x-slack-request-timestamp': nowTimestamp(), 'x-slack-signature': 'v0=abc' },
        requestContext: { requestId: 'test-req-id' } as any,
        httpMethod: 'POST', path: '/ingest', pathParameters: null,
        queryStringParameters: null, multiValueQueryStringParameters: null,
        multiValueHeaders: {}, stageVariables: null, resource: '', isBase64Encoded: false,
      } as APIGatewayProxyEvent;
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
    });

    it('skips Slack retries (X-Slack-Retry-Num header)', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        event: { type: 'message', text: 'hi', channel: 'C1', ts: '1.1', user: 'U1' },
        event_id: 'Ev1', event_time: 123, team_id: 'T1',
      });
      const ts = nowTimestamp();
      const event = makeEvent({
        body,
        headers: {
          'x-slack-request-timestamp': ts,
          'x-slack-signature': makeSignature(body, ts),
          'x-slack-retry-num': '1',
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(mockEmbedText).not.toHaveBeenCalled();
    });

    it('skips empty messages (whitespace-only text)', async () => {
      const body = JSON.stringify({
        type: 'event_callback',
        event: { type: 'message', text: '   ', channel: 'C1', ts: '1.1', user: 'U1' },
        event_id: 'Ev1', event_time: 123, team_id: 'T1',
      });
      const ts = nowTimestamp();
      const event = makeEvent({
        body,
        headers: {
          'x-slack-request-timestamp': ts,
          'x-slack-signature': makeSignature(body, ts),
        },
      });

      const result = await handler(event);
      expect(result.statusCode).toBe(200);
      expect(mockEmbedText).not.toHaveBeenCalled();
    });
  });

  describe('error handling (SEC-15)', () => {
    it('returns 500 with generic message when OpenRouter fails', async () => {
      mockEmbedText.mockRejectedValueOnce(new Error('OpenRouter API error: 500'));

      const event = makeEvent();
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body)).toEqual({ error: 'Internal server error' });
    });

    it('returns 200 when Slack reply fails (thought already stored)', async () => {
      mockPostThreadReply.mockRejectedValueOnce(new Error('Slack API error'));

      const event = makeEvent();
      const result = await handler(event);

      // Reply failure is isolated — thought is already stored, so return 200
      expect(result.statusCode).toBe(200);
    });
  });
});
