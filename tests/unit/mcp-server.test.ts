import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// --- Hoisted mocks ---

const {
  MCP_KEY,
  mockEmbedText,
  mockExtractMetadata,
  mockScanAllThoughts,
  mockQueryByType,
  mockQueryByDate,
  mockGetStats,
  mockPutThought,
} = vi.hoisted(() => ({
  MCP_KEY: 'test-mcp-key',
  mockEmbedText: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2])),
  mockExtractMetadata: vi.fn().mockResolvedValue({
    type: 'idea',
    topics: ['test'],
    people: [],
    action_items: [],
    dates: [],
  }),
  mockScanAllThoughts: vi.fn().mockResolvedValue([]),
  mockQueryByType: vi.fn().mockResolvedValue({
    items: [{
      id: 'item-1', content: 'Listed item', embedding: new Float32Array([0.1]),
      metadata: { type: 'idea', topics: [], people: [], action_items: [], dates: [], source: 'slack' },
      created_at: '2025-06-01T00:00:00Z', updated_at: '2025-06-01T00:00:00Z',
    }],
    cursor: undefined,
  }),
  mockQueryByDate: vi.fn().mockResolvedValue({
    items: [{
      id: 'item-2', content: 'Date item', embedding: new Float32Array([0.1]),
      metadata: { type: 'note', topics: [], people: [], action_items: [], dates: [], source: 'slack' },
      created_at: '2025-07-01T00:00:00Z', updated_at: '2025-07-01T00:00:00Z',
    }],
    cursor: undefined,
  }),
  mockGetStats: vi.fn().mockResolvedValue({
    total: 42,
    byType: { note: 20, idea: 15, task: 7 },
    oldestDate: '2024-01-01T00:00:00Z',
    newestDate: '2025-12-01T00:00:00Z',
  }),
  mockPutThought: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ Parameter: { Value: MCP_KEY } }),
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

vi.mock('../../backend/shared/vector', () => ({
  embeddingToBuffer: vi.fn((e: any) => Buffer.from(e.buffer)),
  bufferToEmbedding: vi.fn((b: any) => new Float32Array(b.buffer)),
  searchByEmbedding: vi.fn().mockResolvedValue([
    {
      thought: {
        id: 'thought-1',
        content: 'Test thought',
        metadata: { type: 'note', topics: ['ai'], people: [], action_items: [], dates: [], source: 'slack' },
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      },
      similarity: 0.95,
    },
  ]),
  clearEmbeddingCache: vi.fn(),
}));

vi.mock('../../backend/shared/dynamodb', () => ({
  scanAllThoughts: (...args: any[]) => mockScanAllThoughts(...args),
  queryByType: (...args: any[]) => mockQueryByType(...args),
  queryByDate: (...args: any[]) => mockQueryByDate(...args),
  getStats: (...args: any[]) => mockGetStats(...args),
  putThought: (...args: any[]) => mockPutThought(...args),
}));

import { handler } from '../../backend/functions/mcp-server/handler';
import { clearSecretCache } from '../../backend/shared/auth';

// --- Helpers ---

function makeEvent(
  method: string,
  params?: Record<string, unknown>,
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-1',
      method,
      ...(params !== undefined && { params }),
    }),
    headers: {
      'x-brain-key': MCP_KEY,
      ...overrides.headers,
    },
    requestContext: { requestId: 'test-req-id' } as any,
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

function parseResponse(result: any): any {
  return JSON.parse(result.body);
}

// --- Tests ---

describe('MCP server handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecretCache();
  });

  describe('authentication (SEC-08)', () => {
    it('rejects requests with missing API key', async () => {
      const event = {
        body: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'initialize' }),
        headers: {},
        requestContext: { requestId: 'test-req-id' } as any,
        httpMethod: 'POST', path: '/mcp', pathParameters: null,
        queryStringParameters: null, multiValueQueryStringParameters: null,
        multiValueHeaders: {}, stageVariables: null, resource: '', isBase64Encoded: false,
      } as APIGatewayProxyEvent;
      const result = await handler(event);
      const body = parseResponse(result);

      expect(result.statusCode).toBe(200); // JSON-RPC errors still return 200
      expect(body.error.message).toBe('Unauthorized');
    });

    it('rejects requests with invalid API key', async () => {
      const event = makeEvent('initialize', undefined, {
        headers: { 'x-brain-key': 'wrong-key' },
      });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.message).toBe('Unauthorized');
    });
  });

  describe('JSON-RPC protocol', () => {
    it('returns parse error for empty body', async () => {
      const event = makeEvent('initialize');
      event.body = null as any;
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32700);
      expect(body.error.message).toBe('Empty request body');
    });

    it('returns parse error for invalid JSON', async () => {
      const event = makeEvent('initialize');
      event.body = 'not-json{{{';
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32700);
      expect(body.error.message).toBe('Invalid JSON');
    });

    it('returns invalid request for malformed JSON-RPC', async () => {
      const event = makeEvent('initialize');
      event.body = JSON.stringify({ not: 'jsonrpc' });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32600);
    });

    it('returns method not found for unknown methods', async () => {
      const event = makeEvent('unknown/method');
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('Unknown method');
    });
  });

  describe('initialize', () => {
    it('returns protocol version and capabilities', async () => {
      const event = makeEvent('initialize');
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.result.protocolVersion).toBe('2024-11-05');
      expect(body.result.capabilities).toEqual({ tools: {} });
      expect(body.result.serverInfo.name).toBe('second-brain');
    });
  });

  describe('tools/list', () => {
    it('returns all four tool definitions', async () => {
      const event = makeEvent('tools/list');
      const result = await handler(event);
      const body = parseResponse(result);

      const tools = body.result.tools;
      expect(tools).toHaveLength(4);
      const names = tools.map((t: any) => t.name);
      expect(names).toContain('search_thoughts');
      expect(names).toContain('list_thoughts');
      expect(names).toContain('thought_stats');
      expect(names).toContain('capture_thought');
    });
  });

  describe('tools/call — search_thoughts', () => {
    it('returns search results with similarity scores', async () => {
      const event = makeEvent('tools/call', {
        name: 'search_thoughts',
        arguments: { query: 'test query' },
      });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.result.content).toHaveLength(1);
      const toolResult = JSON.parse(body.result.content[0].text);
      expect(toolResult[0].id).toBe('thought-1');
      expect(toolResult[0].similarity).toBeDefined();
    });

    it('returns invalid params for missing query', async () => {
      const event = makeEvent('tools/call', {
        name: 'search_thoughts',
        arguments: {},
      });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toBe('Invalid tool parameters');
    });
  });

  describe('tools/call — list_thoughts', () => {
    it('lists thoughts by type when type is provided', async () => {
      const event = makeEvent('tools/call', {
        name: 'list_thoughts',
        arguments: { type: 'idea' },
      });
      const result = await handler(event);
      const body = parseResponse(result);

      const toolResult = JSON.parse(body.result.content[0].text);
      expect(toolResult.items).toHaveLength(1);
      expect(mockQueryByType).toHaveBeenCalledWith('idea', expect.any(Object));
    });

    it('lists thoughts by date when no type is provided', async () => {
      const event = makeEvent('tools/call', {
        name: 'list_thoughts',
        arguments: {},
      });
      const result = await handler(event);
      const body = parseResponse(result);

      const toolResult = JSON.parse(body.result.content[0].text);
      expect(toolResult.items).toHaveLength(1);
      expect(mockQueryByDate).toHaveBeenCalled();
    });
  });

  describe('tools/call — thought_stats', () => {
    it('returns aggregate statistics', async () => {
      const event = makeEvent('tools/call', {
        name: 'thought_stats',
        arguments: {},
      });
      const result = await handler(event);
      const body = parseResponse(result);

      const toolResult = JSON.parse(body.result.content[0].text);
      expect(toolResult.total).toBe(42);
      expect(toolResult.by_type).toEqual({ note: 20, idea: 15, task: 7 });
      expect(toolResult.oldest_date).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('tools/call — capture_thought', () => {
    it('captures a thought and returns metadata', async () => {
      const event = makeEvent('tools/call', {
        name: 'capture_thought',
        arguments: { content: 'A new idea for the project' },
      });
      const result = await handler(event);
      const body = parseResponse(result);

      const toolResult = JSON.parse(body.result.content[0].text);
      expect(toolResult.id).toBeDefined();
      expect(toolResult.content).toBe('A new idea for the project');
      expect(toolResult.metadata.source).toBe('mcp');
      expect(mockPutThought).toHaveBeenCalled();
    });

    it('returns invalid params for missing content', async () => {
      const event = makeEvent('tools/call', {
        name: 'capture_thought',
        arguments: {},
      });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32602);
    });
  });

  describe('tools/call — unknown tool', () => {
    it('returns method not found for unknown tool name', async () => {
      const event = makeEvent('tools/call', {
        name: 'nonexistent_tool',
        arguments: {},
      });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('Unknown tool');
    });

    it('returns invalid params for missing tool name', async () => {
      const event = makeEvent('tools/call', { arguments: {} });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32602);
      expect(body.error.message).toBe('Missing tool name');
    });
  });

  describe('error handling (SEC-15)', () => {
    it('returns internal error when tool execution throws', async () => {
      mockGetStats.mockRejectedValueOnce(new Error('DynamoDB timeout'));

      const event = makeEvent('tools/call', {
        name: 'thought_stats',
        arguments: {},
      });
      const result = await handler(event);
      const body = parseResponse(result);

      expect(body.error.code).toBe(-32603);
      expect(body.error.message).toBe('Tool execution failed');
    });
  });
});
