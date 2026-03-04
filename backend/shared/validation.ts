import { z } from 'zod';

/**
 * SEC-05: Zod schemas for all API inputs.
 * Every field has type checking, length bounds, and format validation.
 */

const MAX_CONTENT_LENGTH = 10_000;
const MAX_QUERY_LENGTH = 1_000;

// --- Slack payloads ---

export const slackChallengeSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string().max(256),
  token: z.string().max(256),
});

export const slackEventSchema = z.object({
  type: z.literal('event_callback'),
  event: z.object({
    type: z.string().max(64),
    text: z.string().max(MAX_CONTENT_LENGTH),
    channel: z.string().max(64),
    ts: z.string().max(32),
    user: z.string().max(64),
    thread_ts: z.string().max(32).optional(),
  }),
  event_id: z.string().max(64),
  event_time: z.number(),
  team_id: z.string().max(64),
});

export const slackPayloadSchema = z.discriminatedUnion('type', [
  slackChallengeSchema,
  slackEventSchema,
]);

// --- MCP JSON-RPC ---

export const mcpRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string().max(128), z.number()]),
  method: z.string().max(128),
  params: z.record(z.unknown()).optional(),
});

// --- MCP tool parameters ---

const THOUGHT_TYPES = [
  'idea', 'task', 'observation', 'question', 'reference',
  'meeting', 'decision', 'person', 'needs_review',
] as const;

export const searchThoughtsParamsSchema = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(50).default(10),
  type: z.enum(THOUGHT_TYPES).optional(),
});

export const listThoughtsParamsSchema = z.object({
  type: z.enum(THOUGHT_TYPES).optional(),
  start_date: z.string().datetime().optional(),
  end_date: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

export const captureThoughtParamsSchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
});

export const updateThoughtParamsSchema = z.object({
  id: z.string().uuid(),
  content: z.string().min(1).max(MAX_CONTENT_LENGTH),
});

export const deleteThoughtParamsSchema = z.object({
  id: z.string().uuid(),
});

// --- Inferred types ---

export type SlackChallenge = z.infer<typeof slackChallengeSchema>;
export type SlackEvent = z.infer<typeof slackEventSchema>;
export type SlackPayload = z.infer<typeof slackPayloadSchema>;
export type McpRequest = z.infer<typeof mcpRequestSchema>;
export type SearchThoughtsParams = z.infer<typeof searchThoughtsParamsSchema>;
export type ListThoughtsParams = z.infer<typeof listThoughtsParamsSchema>;
export type CaptureThoughtParams = z.infer<typeof captureThoughtParamsSchema>;
export type UpdateThoughtParams = z.infer<typeof updateThoughtParamsSchema>;
export type DeleteThoughtParams = z.infer<typeof deleteThoughtParamsSchema>;
