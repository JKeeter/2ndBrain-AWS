import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createLogger, type Logger } from '../../shared/logger';
import { verifyMcpApiKey } from '../../shared/auth';
import { jsonResponse } from '../../shared/responses';
import { mcpRequestSchema } from '../../shared/validation';
import { searchThoughts } from './tools/search-thoughts';
import { listThoughts } from './tools/list-thoughts';
import { thoughtStats } from './tools/thought-stats';
import { captureThought } from './tools/capture-thought';
import { ZodError } from 'zod';

/**
 * MCP server Lambda handler.
 * SEC-08: API key validation on every request (fail-closed).
 * SEC-05: All inputs validated via Zod schemas.
 * SEC-09: Generic error messages — no internals exposed.
 * SEC-15: Global error handler wrapping all processing.
 */

// MCP protocol version
const MCP_PROTOCOL_VERSION = '2024-11-05';

// Tool definitions for tools/list
const TOOL_DEFINITIONS = [
  {
    name: 'search_thoughts',
    description:
      'Search stored thoughts using semantic similarity. Returns the most relevant thoughts matching the query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'The search query text to find similar thoughts',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (1-50, default 10)',
        },
        type: {
          type: 'string',
          description:
            'Optional filter by thought type: idea, task, observation, question, reference, meeting, decision, person, needs_review',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_thoughts',
    description:
      'List stored thoughts with optional filtering by type and date range. Returns paginated results.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description:
            'Filter by thought type: idea, task, observation, question, reference, meeting, decision, person, needs_review',
        },
        start_date: {
          type: 'string',
          description: 'Filter thoughts created on or after this ISO 8601 date',
        },
        end_date: {
          type: 'string',
          description: 'Filter thoughts created on or before this ISO 8601 date',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results per page (1-100, default 20)',
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor from a previous response',
        },
      },
      required: [],
    },
  },
  {
    name: 'thought_stats',
    description:
      'Get aggregate statistics about stored thoughts: total count, counts by type, and date range.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'capture_thought',
    description:
      'Capture a new thought. The text will be embedded for semantic search and metadata (type, topics, people, action items, dates) will be automatically extracted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: 'The thought text to capture (max 10,000 characters)',
        },
      },
      required: ['content'],
    },
  },
];

// JSON-RPC helpers
function jsonRpcSuccess(id: string | number, result: unknown): APIGatewayProxyResult {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
): APIGatewayProxyResult {
  return jsonResponse(200, { jsonrpc: '2.0', id, error: { code, message } });
}

// Standard JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const logger = createLogger(event);

  try {
    // MCP Streamable HTTP: handle GET (SSE) and DELETE (session close)
    if (event.httpMethod === 'GET') {
      // GET opens an SSE notification stream — not supported by this stateless server
      return jsonResponse(405, { error: 'SSE not supported' });
    }
    if (event.httpMethod === 'DELETE') {
      // DELETE closes a session — stateless, so always OK
      return jsonResponse(200, {});
    }

    // SEC-08: Verify API key — fail-closed
    const apiKey = event.headers['x-brain-key'] ?? event.headers['X-Brain-Key'];
    const isValid = await verifyMcpApiKey(apiKey, logger);
    if (!isValid) {
      logger.warn('MCP authentication failed');
      return jsonRpcError(null, INVALID_REQUEST, 'Unauthorized');
    }

    // Parse request body
    if (!event.body) {
      return jsonRpcError(null, PARSE_ERROR, 'Empty request body');
    }

    let rawBody: unknown;
    try {
      rawBody = JSON.parse(event.body);
    } catch {
      return jsonRpcError(null, PARSE_ERROR, 'Invalid JSON');
    }

    // SEC-05: Validate JSON-RPC envelope
    const parseResult = mcpRequestSchema.safeParse(rawBody);
    if (!parseResult.success) {
      return jsonRpcError(null, INVALID_REQUEST, 'Invalid JSON-RPC request');
    }

    const { id, method, params } = parseResult.data;

    logger.info('MCP request received', { method });

    // Route by method
    switch (method) {
      case 'initialize':
        return jsonRpcSuccess(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: {
            name: 'second-brain',
            version: '1.0.0',
          },
        });

      case 'tools/list':
        return jsonRpcSuccess(id, { tools: TOOL_DEFINITIONS });

      case 'tools/call':
        return await handleToolCall(id, params ?? {}, logger);

      default:
        return jsonRpcError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
    }
  } catch (err) {
    // SEC-15: Global error handler — log details, return generic message
    logger.error('Unhandled error in MCP handler', {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    return jsonRpcError(null, INTERNAL_ERROR, 'Internal server error');
  }
};

async function handleToolCall(
  id: string | number,
  params: Record<string, unknown>,
  logger: Logger,
): Promise<APIGatewayProxyResult> {
  const toolName = params.name as string | undefined;
  const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

  if (!toolName) {
    return jsonRpcError(id, INVALID_PARAMS, 'Missing tool name');
  }

  logger.info('Tool call', { tool: toolName });

  try {
    let result: unknown;

    switch (toolName) {
      case 'search_thoughts':
        result = await searchThoughts(toolArgs, logger);
        break;
      case 'list_thoughts':
        result = await listThoughts(toolArgs, logger);
        break;
      case 'thought_stats':
        result = await thoughtStats(logger);
        break;
      case 'capture_thought':
        result = await captureThought(toolArgs, logger);
        break;
      default:
        return jsonRpcError(id, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
    }

    return jsonRpcSuccess(id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    });
  } catch (err) {
    if (err instanceof ZodError) {
      logger.warn('Tool parameter validation failed', {
        tool: toolName,
        issues: err.issues.map((i) => i.message),
      });
      return jsonRpcError(id, INVALID_PARAMS, 'Invalid tool parameters');
    }

    logger.error('Tool execution error', {
      tool: toolName,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
    return jsonRpcError(id, INTERNAL_ERROR, 'Tool execution failed');
  }
}
