import { embedText } from '../../../shared/openrouter';
import { scanAllThoughts } from '../../../shared/dynamodb';
import { searchByEmbedding } from '../../../shared/vector';
import { searchThoughtsParamsSchema } from '../../../shared/validation';
import type { Logger } from '../../../shared/logger';

/** Minimum similarity threshold — results below this are filtered out. */
const SIMILARITY_THRESHOLD = 0.3;

/**
 * MCP tool: search_thoughts
 * Embeds query text and performs brute-force cosine similarity search.
 * Supports optional type filtering and minimum similarity threshold.
 */
export async function searchThoughts(
  params: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  const validated = searchThoughtsParamsSchema.parse(params);

  logger.info('Searching thoughts', {
    queryLength: validated.query.length,
    limit: validated.limit,
    type: validated.type,
  });

  const queryEmbedding = await embedText(validated.query, logger);

  // Fetch more results than requested to allow for filtering
  const fetchLimit = validated.type ? validated.limit * 3 : validated.limit;

  const results = await searchByEmbedding(
    queryEmbedding,
    fetchLimit,
    scanAllThoughts,
  );

  let filtered = results.filter((r) => r.similarity >= SIMILARITY_THRESHOLD);

  if (validated.type) {
    filtered = filtered.filter((r) => r.thought.metadata.type === validated.type);
  }

  return filtered.slice(0, validated.limit).map((r) => ({
    id: r.thought.id,
    content: r.thought.content,
    metadata: r.thought.metadata,
    created_at: r.thought.created_at,
    similarity: Math.round(r.similarity * 10000) / 10000,
  }));
}
