import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Integration test: Full MCP JSON-RPC → tool execution → response flow.
 * Mocks only external services (SSM, DynamoDB, OpenRouter).
 * Exercises the real handler, tools, validation, and shared modules wired together.
 */

const {
  MCP_KEY,
  mockDynamoSend,
  mockFetch,
} = vi.hoisted(() => ({
  MCP_KEY: 'integ-mcp-key',
  mockDynamoSend: vi.fn(),
  mockFetch: vi.fn(),
}));

// --- Mock external services ---

vi.mock('@aws-sdk/client-ssm', () => {
  const send = vi.fn().mockImplementation((cmd: any) => {
    const paramMap: Record<string, string> = {
      '/second-brain/mcp-access-key': MCP_KEY,
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
  QueryCommand: vi.fn((p: any) => ({ ...p, _type: 'Query' })),
  ScanCommand: vi.fn((p: any) => ({ ...p, _type: 'Scan' })),
  BatchGetItemCommand: vi.fn((p: any) => ({ ...p, _type: 'BatchGet' })),
}));

vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: vi.fn((item: any) => item),
  unmarshall: vi.fn((item: any) => item),
}));

// Mock global fetch for OpenRouter
vi.stubGlobal('fetch', mockFetch);

import { handler } from '../../backend/functions/mcp-server/handler';
import { clearSecretCache } from '../../backend/shared/auth';
import { clearEmbeddingCache } from '../../backend/shared/vector';

// --- Helpers ---

function makeEvent(
  method: string,
  params?: Record<string, unknown>,
  headers?: Record<string, string>,
): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'integ-1',
      method,
      ...(params !== undefined && { params }),
    }),
    headers: { 'x-brain-key': MCP_KEY, ...headers },
    requestContext: { requestId: 'integ-req' } as any,
    httpMethod: 'POST',
    path: '/mcp',
    pathParameters: null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    multiValueHeaders: {},
    stageVariables: null,
    resource: '',
    isBase64Encoded: false,
  } as APIGatewayProxyEvent;
}

function parseBody(result: any): any {
  return JSON.parse(result.body);
}

function parseToolResult(result: any): any {
  const body = parseBody(result);
  return JSON.parse(body.result.content[0].text);
}

// --- Tests ---

describe('MCP server integration flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretCache();
    clearEmbeddingCache();
    mockDynamoSend.mockReset();
  });

  describe('initialize → tools/list → tools/call lifecycle', () => {
    it('completes a full MCP handshake and tool call', async () => {
      // Step 1: Initialize
      const initResult = await handler(makeEvent('initialize'));
      const initBody = parseBody(initResult);
      expect(initBody.result.protocolVersion).toBe('2024-11-05');
      expect(initBody.result.serverInfo.name).toBe('second-brain');

      // Step 2: List tools
      const listResult = await handler(makeEvent('tools/list'));
      const listBody = parseBody(listResult);
      expect(listBody.result.tools).toHaveLength(4);

      // Step 3: Call thought_stats
      // unmarshall is mocked as identity, so return pre-unmarshalled data
      mockDynamoSend.mockImplementation((cmd: any) => {
        // Scan for type counts
        if (cmd._type === 'Scan') {
          return Promise.resolve({
            Items: [
              { thought_type: 'note' },
              { thought_type: 'note' },
              { thought_type: 'idea' },
            ],
          });
        }
        // Query for oldest/newest dates
        if (cmd._type === 'Query') {
          return Promise.resolve({
            Items: [{ created_at: '2025-01-01T00:00:00Z' }],
          });
        }
        return Promise.resolve({});
      });

      const statsResult = await handler(
        makeEvent('tools/call', { name: 'thought_stats', arguments: {} }),
      );
      const stats = parseToolResult(statsResult);
      expect(stats.total).toBe(3);
      expect(stats.by_type.note).toBe(2);
      expect(stats.by_type.idea).toBe(1);
    });
  });

  describe('search_thoughts end-to-end', () => {
    it('embeds the query, scans DynamoDB, and returns ranked results', async () => {
      // Mock OpenRouter embedding for query
      mockFetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [{ embedding: [0.5, 0.3, 0.8] }],
          }),
      });

      // Mock DynamoDB scan returning thoughts
      mockDynamoSend.mockResolvedValue({
        Items: [
          {
            PK: 'THOUGHT',
            SK: 'thought#abc-123',
            content: 'AWS Lambda is great for small workloads',
            embedding: Buffer.from(new Float32Array([0.5, 0.3, 0.8]).buffer),
            metadata: { type: 'note', topics: ['aws'], people: [], action_items: [], dates: [], source: 'slack' },
            created_at: '2025-03-01T00:00:00Z',
            updated_at: '2025-03-01T00:00:00Z',
            thought_type: 'note',
          },
        ],
      });

      const result = await handler(
        makeEvent('tools/call', {
          name: 'search_thoughts',
          arguments: { query: 'lambda serverless', limit: 5 },
        }),
      );

      expect(result.statusCode).toBe(200);
      const body = parseBody(result);
      expect(body.error).toBeUndefined();

      // Verify OpenRouter was called for query embedding
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/embeddings'),
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('capture_thought end-to-end', () => {
    it('embeds, extracts metadata, stores, and returns confirmation', async () => {
      // Mock OpenRouter: embedding + metadata
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/embeddings')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              data: [{ embedding: Array.from({ length: 1536 }, () => 0.01) }],
            }),
          });
        }
        if (url.includes('/chat/completions')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              choices: [{
                message: {
                  content: JSON.stringify({
                    type: 'task',
                    topics: ['testing'],
                    people: ['Bob'],
                    action_items: ['Deploy to prod'],
                    dates: [],
                  }),
                },
              }],
            }),
          });
        }
        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      });

      // Mock DynamoDB PutItem
      mockDynamoSend.mockResolvedValue({});

      const result = await handler(
        makeEvent('tools/call', {
          name: 'capture_thought',
          arguments: { content: 'Deploy the second brain to production this week' },
        }),
      );

      expect(result.statusCode).toBe(200);
      const toolResult = parseToolResult(result);
      expect(toolResult.content).toBe('Deploy the second brain to production this week');
      expect(toolResult.metadata.type).toBe('task');
      expect(toolResult.metadata.source).toBe('mcp');
      expect(toolResult.metadata.people).toContain('Bob');

      // Verify DynamoDB PutItem was called
      expect(mockDynamoSend).toHaveBeenCalled();

      // Verify both OpenRouter calls were made
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('list_thoughts end-to-end', () => {
    it('queries DynamoDB by type and returns formatted results', async () => {
      mockDynamoSend.mockResolvedValue({
        Items: [{
          PK: 'THOUGHT',
          SK: 'thought#xyz-789',
          content: 'Use cosine similarity for small scale',
          embedding: Buffer.from(new Float32Array([0.1]).buffer),
          metadata: { type: 'note', topics: ['vectors'], people: [], action_items: [], dates: [], source: 'slack' },
          created_at: '2025-06-01T00:00:00Z',
          updated_at: '2025-06-01T00:00:00Z',
          thought_type: 'note',
        }],
      });

      const result = await handler(
        makeEvent('tools/call', {
          name: 'list_thoughts',
          arguments: { type: 'note', limit: 10 },
        }),
      );

      expect(result.statusCode).toBe(200);
      const toolResult = parseToolResult(result);
      expect(toolResult.items).toBeDefined();
    });
  });

  describe('authentication integration', () => {
    it('rejects all tool calls with wrong API key', async () => {
      const result = await handler(
        makeEvent('tools/call', {
          name: 'thought_stats',
          arguments: {},
        }, { 'x-brain-key': 'wrong-key-value' }),
      );

      const body = parseBody(result);
      expect(body.error.message).toBe('Unauthorized');

      // No DynamoDB or OpenRouter calls should occur
      expect(mockDynamoSend).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('error propagation', () => {
    it('returns JSON-RPC error when OpenRouter fails during capture', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const result = await handler(
        makeEvent('tools/call', {
          name: 'capture_thought',
          arguments: { content: 'This will fail' },
        }),
      );

      const body = parseBody(result);
      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toBe('Tool execution failed');
    });
  });
});
