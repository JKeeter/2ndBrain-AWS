import { getSecret } from './auth';
import type { Logger } from './logger';

/**
 * Slack API client for posting thread replies.
 * SEC-12: Bot token loaded from SSM at runtime.
 * SEC-15: All API calls have explicit error handling.
 */

/** Post a reply in a Slack thread. */
export async function postThreadReply(
  channel: string,
  threadTs: string,
  text: string,
  logger: Logger,
): Promise<void> {
  const botToken = await getSecret('/second-brain/slack-bot-token');

  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });

  if (!response.ok) {
    logger.error('Slack API HTTP error', { status: response.status });
    throw new Error(`Slack API HTTP error: ${response.status}`);
  }

  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) {
    logger.error('Slack API error', { slackError: result.error });
    throw new Error(`Slack API error: ${result.error}`);
  }
}
