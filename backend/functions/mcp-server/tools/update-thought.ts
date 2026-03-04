import { embedText, extractMetadata } from '../../../shared/openrouter';
import { getThoughtById, updateThought } from '../../../shared/dynamodb';
import { clearEmbeddingCache } from '../../../shared/vector';
import { updateThoughtParamsSchema } from '../../../shared/validation';
import type { Logger } from '../../../shared/logger';
import type { ThoughtMetadata } from '../../../shared/types';

/**
 * MCP tool: update_thought
 * Re-embeds text, re-extracts metadata via LLM, updates existing thought in DynamoDB.
 */
export async function updateThoughtTool(
  params: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  const validated = updateThoughtParamsSchema.parse(params);

  logger.info('Updating thought via MCP', { id: validated.id, contentLength: validated.content.length });

  // Verify thought exists
  const existing = await getThoughtById(validated.id);
  if (!existing) {
    throw new Error(`Thought not found: ${validated.id}`);
  }

  // Parallel: re-embed text + re-extract metadata
  const [embedding, rawMetadata] = await Promise.all([
    embedText(validated.content, logger),
    extractMetadata(validated.content, logger),
  ]);

  const metadata: ThoughtMetadata = {
    ...rawMetadata,
    source: existing.metadata.source,
  };

  await updateThought({
    id: validated.id,
    content: validated.content,
    embedding,
    metadata,
  });

  // Invalidate embedding cache so subsequent searches reflect the update
  clearEmbeddingCache();

  logger.info('Thought updated', { id: validated.id, type: metadata.type });

  return {
    id: validated.id,
    content: validated.content,
    metadata,
    updated_at: new Date().toISOString(),
  };
}
