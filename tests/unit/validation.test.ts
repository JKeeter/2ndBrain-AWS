import { describe, it, expect } from 'vitest';
import {
  slackPayloadSchema,
  slackChallengeSchema,
  slackEventSchema,
  mcpRequestSchema,
  searchThoughtsParamsSchema,
  listThoughtsParamsSchema,
  captureThoughtParamsSchema,
} from '../../backend/shared/validation';

// --- Slack payloads ---

describe('slackChallengeSchema', () => {
  it('accepts a valid url_verification payload', () => {
    const result = slackChallengeSchema.parse({
      type: 'url_verification',
      challenge: 'abc123challenge',
      token: 'sometoken',
    });
    expect(result.challenge).toBe('abc123challenge');
  });

  it('rejects if type is not url_verification', () => {
    expect(() =>
      slackChallengeSchema.parse({
        type: 'event_callback',
        challenge: 'abc',
        token: 'tok',
      }),
    ).toThrow();
  });

  it('rejects challenge exceeding max length', () => {
    expect(() =>
      slackChallengeSchema.parse({
        type: 'url_verification',
        challenge: 'a'.repeat(257),
        token: 'tok',
      }),
    ).toThrow();
  });
});

describe('slackEventSchema', () => {
  const validEvent = {
    type: 'event_callback',
    event: {
      type: 'message',
      text: 'Hello world',
      channel: 'C123ABC',
      ts: '1234567890.123456',
      user: 'U123ABC',
    },
    event_id: 'Ev123',
    event_time: 1234567890,
    team_id: 'T123',
  };

  it('accepts a valid event_callback payload', () => {
    const result = slackEventSchema.parse(validEvent);
    expect(result.event.text).toBe('Hello world');
    expect(result.event.channel).toBe('C123ABC');
  });

  it('accepts event with optional thread_ts', () => {
    const result = slackEventSchema.parse({
      ...validEvent,
      event: { ...validEvent.event, thread_ts: '1234567890.000000' },
    });
    expect(result.event.thread_ts).toBe('1234567890.000000');
  });

  it('rejects text exceeding 10,000 characters', () => {
    expect(() =>
      slackEventSchema.parse({
        ...validEvent,
        event: { ...validEvent.event, text: 'x'.repeat(10_001) },
      }),
    ).toThrow();
  });

  it('accepts text at exactly 10,000 characters', () => {
    const result = slackEventSchema.parse({
      ...validEvent,
      event: { ...validEvent.event, text: 'x'.repeat(10_000) },
    });
    expect(result.event.text.length).toBe(10_000);
  });

  it('rejects missing required event fields', () => {
    expect(() =>
      slackEventSchema.parse({
        ...validEvent,
        event: { type: 'message' },
      }),
    ).toThrow();
  });

  it('rejects non-string event_time', () => {
    expect(() =>
      slackEventSchema.parse({
        ...validEvent,
        event_time: 'not-a-number',
      }),
    ).toThrow();
  });
});

describe('slackPayloadSchema (discriminated union)', () => {
  it('routes to challenge schema for url_verification', () => {
    const result = slackPayloadSchema.parse({
      type: 'url_verification',
      challenge: 'test-challenge',
      token: 'tok',
    });
    expect(result.type).toBe('url_verification');
    expect((result as any).challenge).toBe('test-challenge');
  });

  it('routes to event schema for event_callback', () => {
    const result = slackPayloadSchema.parse({
      type: 'event_callback',
      event: {
        type: 'message',
        text: 'test',
        channel: 'C1',
        ts: '123.456',
        user: 'U1',
      },
      event_id: 'Ev1',
      event_time: 123,
      team_id: 'T1',
    });
    expect(result.type).toBe('event_callback');
  });

  it('rejects unknown type discriminator', () => {
    expect(() =>
      slackPayloadSchema.parse({
        type: 'unknown_type',
        data: {},
      }),
    ).toThrow();
  });
});

// --- MCP JSON-RPC ---

describe('mcpRequestSchema', () => {
  it('accepts a valid JSON-RPC request with string id', () => {
    const result = mcpRequestSchema.parse({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'initialize',
    });
    expect(result.method).toBe('initialize');
  });

  it('accepts a valid JSON-RPC request with number id', () => {
    const result = mcpRequestSchema.parse({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'search_thoughts' },
    });
    expect(result.id).toBe(42);
  });

  it('rejects wrong jsonrpc version', () => {
    expect(() =>
      mcpRequestSchema.parse({
        jsonrpc: '1.0',
        id: '1',
        method: 'test',
      }),
    ).toThrow();
  });

  it('rejects missing method', () => {
    expect(() =>
      mcpRequestSchema.parse({ jsonrpc: '2.0', id: '1' }),
    ).toThrow();
  });

  it('rejects method exceeding max length', () => {
    expect(() =>
      mcpRequestSchema.parse({
        jsonrpc: '2.0',
        id: '1',
        method: 'x'.repeat(129),
      }),
    ).toThrow();
  });
});

// --- MCP tool parameters ---

describe('searchThoughtsParamsSchema', () => {
  it('accepts valid params with defaults', () => {
    const result = searchThoughtsParamsSchema.parse({ query: 'hello' });
    expect(result.query).toBe('hello');
    expect(result.limit).toBe(10); // default
  });

  it('accepts explicit limit', () => {
    const result = searchThoughtsParamsSchema.parse({ query: 'test', limit: 25 });
    expect(result.limit).toBe(25);
  });

  it('rejects empty query', () => {
    expect(() => searchThoughtsParamsSchema.parse({ query: '' })).toThrow();
  });

  it('rejects query exceeding 1000 characters', () => {
    expect(() =>
      searchThoughtsParamsSchema.parse({ query: 'x'.repeat(1001) }),
    ).toThrow();
  });

  it('rejects limit > 50', () => {
    expect(() =>
      searchThoughtsParamsSchema.parse({ query: 'test', limit: 51 }),
    ).toThrow();
  });

  it('rejects limit < 1', () => {
    expect(() =>
      searchThoughtsParamsSchema.parse({ query: 'test', limit: 0 }),
    ).toThrow();
  });
});

describe('listThoughtsParamsSchema', () => {
  it('accepts empty params with defaults', () => {
    const result = listThoughtsParamsSchema.parse({});
    expect(result.limit).toBe(20);
  });

  it('accepts all optional params', () => {
    const result = listThoughtsParamsSchema.parse({
      type: 'idea',
      start_date: '2025-01-01T00:00:00Z',
      end_date: '2025-12-31T23:59:59Z',
      limit: 50,
      cursor: 'abc123',
    });
    expect(result.type).toBe('idea');
  });

  it('rejects invalid datetime format', () => {
    expect(() =>
      listThoughtsParamsSchema.parse({ start_date: 'not-a-date' }),
    ).toThrow();
  });

  it('rejects limit > 100', () => {
    expect(() =>
      listThoughtsParamsSchema.parse({ limit: 101 }),
    ).toThrow();
  });
});

describe('captureThoughtParamsSchema', () => {
  it('accepts valid content', () => {
    const result = captureThoughtParamsSchema.parse({ content: 'My thought' });
    expect(result.content).toBe('My thought');
  });

  it('rejects empty content', () => {
    expect(() => captureThoughtParamsSchema.parse({ content: '' })).toThrow();
  });

  it('rejects content exceeding 10,000 characters', () => {
    expect(() =>
      captureThoughtParamsSchema.parse({ content: 'x'.repeat(10_001) }),
    ).toThrow();
  });

  it('accepts content with special characters', () => {
    const content = '<script>alert("xss")</script> & "quotes" \' emoji: \u{1F600}';
    const result = captureThoughtParamsSchema.parse({ content });
    expect(result.content).toBe(content);
  });

  it('rejects missing content field', () => {
    expect(() => captureThoughtParamsSchema.parse({})).toThrow();
  });
});
