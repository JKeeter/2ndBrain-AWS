import { getStats } from '../../../shared/dynamodb';
import type { Logger } from '../../../shared/logger';

/**
 * MCP tool: thought_stats
 * Returns aggregate statistics: total count, counts by type, date range.
 */
export async function thoughtStats(logger: Logger): Promise<unknown> {
  logger.info('Getting thought stats');

  const stats = await getStats();

  return {
    total: stats.total,
    by_type: stats.byType,
    oldest_date: stats.oldestDate ?? null,
    newest_date: stats.newestDate ?? null,
  };
}
