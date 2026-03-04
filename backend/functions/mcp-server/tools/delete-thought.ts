import { getThoughtById, deleteThought } from '../../../shared/dynamodb';
import { clearEmbeddingCache } from '../../../shared/vector';
import { deleteThoughtParamsSchema } from '../../../shared/validation';
import type { Logger } from '../../../shared/logger';

/**
 * MCP tool: delete_thought
 * Permanently deletes a thought by ID.
 */
export async function deleteThoughtTool(
  params: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  const validated = deleteThoughtParamsSchema.parse(params);

  logger.info('Deleting thought via MCP', { id: validated.id });

  // Verify thought exists
  const existing = await getThoughtById(validated.id);
  if (!existing) {
    throw new Error(`Thought not found: ${validated.id}`);
  }

  await deleteThought(validated.id);

  // Invalidate embedding cache so subsequent searches reflect the deletion
  clearEmbeddingCache();

  logger.info('Thought deleted', { id: validated.id });

  return {
    id: validated.id,
    deleted: true,
  };
}
