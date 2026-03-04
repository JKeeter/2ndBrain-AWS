import { queryByType, queryByDate } from '../../../shared/dynamodb';
import { listThoughtsParamsSchema } from '../../../shared/validation';
import type { Logger } from '../../../shared/logger';

/**
 * MCP tool: list_thoughts
 * Lists thoughts with optional type filter and date range, paginated.
 */
export async function listThoughts(
  params: Record<string, unknown>,
  logger: Logger,
): Promise<unknown> {
  const validated = listThoughtsParamsSchema.parse(params);

  logger.info('Listing thoughts', {
    type: validated.type,
    startDate: validated.start_date,
    endDate: validated.end_date,
    limit: validated.limit,
  });

  const queryOptions = {
    limit: validated.limit,
    startDate: validated.start_date,
    endDate: validated.end_date,
    cursor: validated.cursor,
  };

  // Use type-specific GSI when type is provided, otherwise query by date
  const result = validated.type
    ? await queryByType(validated.type, queryOptions)
    : await queryByDate(queryOptions);

  return {
    items: result.items.map((t) => ({
      id: t.id,
      content: t.content,
      metadata: t.metadata,
      created_at: t.created_at,
    })),
    cursor: result.cursor ?? null,
  };
}
