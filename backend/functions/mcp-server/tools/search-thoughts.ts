import { embedText } from '../../../shared/openrouter';
import { scanAllThoughts } from '../../../shared/dynamodb';
import { searchByEmbedding } from '../../../shared/vector';
import { searchThoughtsParamsSchema } from '../../../shared/validation';
import type { Logger } from '../../../shared/logger';

/**
 * MCP tool: search_thoughts
 * Embeds query text and performs brute-force cosine similarity search.
 */
export async function searchThoughts(
  params: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  const validated = searchThoughtsParamsSchema.parse(params);

  logger.info('Searching thoughts', { queryLength: validated.query.length, limit: validated.limit });

  const queryEmbedding = await embedText(validated.query, logger);

  const results = await searchByEmbedding(
    queryEmbedding,
    validated.limit,
    scanAllThoughts,
  );

  return results.map((r) => ({
    id: r.thought.id,
    content: r.thought.content,
    metadata: r.thought.metadata,
    created_at: r.thought.created_at,
    similarity: Math.round(r.similarity * 10000) / 10000,
  }));
}
