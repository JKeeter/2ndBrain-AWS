import { randomUUID } from 'crypto';
import { embedText, extractMetadata } from '../../../shared/openrouter';
import { putThought } from '../../../shared/dynamodb';
import { clearEmbeddingCache } from '../../../shared/vector';
import { captureThoughtParamsSchema } from '../../../shared/validation';
import type { Logger } from '../../../shared/logger';
import type { ThoughtMetadata } from '../../../shared/types';

/**
 * MCP tool: capture_thought
 * Embeds text, extracts metadata via LLM, stores in DynamoDB with source="mcp".
 */
export async function captureThought(
  params: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  const validated = captureThoughtParamsSchema.parse(params);

  logger.info('Capturing thought via MCP', { contentLength: validated.content.length });

  // Parallel: embed text + extract metadata
  const [embedding, rawMetadata] = await Promise.all([
    embedText(validated.content, logger),
    extractMetadata(validated.content, logger),
  ]);

  const metadata: ThoughtMetadata = {
    ...rawMetadata,
    source: 'mcp',
  };

  const id = randomUUID();

  await putThought({
    id,
    content: validated.content,
    embedding,
    metadata,
  });

  // Invalidate embedding cache so subsequent searches include this thought
  clearEmbeddingCache();

  logger.info('Thought captured', { id, type: metadata.type });

  return {
    id,
    content: validated.content,
    metadata,
    created_at: new Date().toISOString(),
  };
}
