import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 } from 'uuid';
import { createLogger, type Logger } from '../../shared/logger';
import { verifySlackSignature } from '../../shared/auth';
import { slackPayloadSchema, type SlackEvent } from '../../shared/validation';
import { putThought, getThoughtBySlackTs, updateThought } from '../../shared/dynamodb';
import { embedText, extractMetadata } from '../../shared/openrouter';
import { postThreadReply } from '../../shared/slack';
import { clearEmbeddingCache } from '../../shared/vector';
import { success, errorResponse } from '../../shared/responses';

/** Format the Slack confirmation reply with type-specific emojis. */
function formatConfirmation(type: string, topics: string[]): string {
  const topicsList = topics.length > 0 ? topics.join(', ') : 'none';

  if (type === 'needs_review') {
    return (
      `:thinking_face: Captured as *needs_review*. Topics: ${topicsList}.\n\n` +
      `Reply in this thread to add context — I'll re-classify automatically.`
    );
  }

  const typeEmoji: Record<string, string> = {
    task: ':white_check_mark:',
    idea: ':bulb:',
    observation: ':eyes:',
    question: ':question:',
    reference: ':link:',
    meeting: ':calendar:',
    decision: ':scales:',
    person: ':bust_in_silhouette:',
  };

  const emoji = typeEmoji[type] ?? ':brain:';
  return `${emoji} Captured as *${type}*. Topics: ${topicsList}.`;
}

/** Handle a Slack thread reply by updating the original thought. */
async function handleThreadReply(
  payload: SlackEvent,
  logger: Logger,
): Promise<APIGatewayProxyResult> {
  const originalThought = await getThoughtBySlackTs(
    payload.event.channel,
    payload.event.thread_ts!,
  );

  if (!originalThought) {
    logger.info('Thread reply to unknown thought, skipping', {
      channel: payload.event.channel,
      thread_ts: payload.event.thread_ts,
    });
    return success({ ok: true });
  }

  // Combine original content with the reply
  const combinedContent = `${originalThought.content}\n\n---\nAdditional context: ${payload.event.text}`;

  // Re-embed + re-extract in parallel
  const [embedding, extractedMetadata] = await Promise.all([
    embedText(combinedContent, logger),
    extractMetadata(combinedContent, logger),
  ]);

  // Update in DynamoDB
  await updateThought({
    id: originalThought.id,
    content: combinedContent,
    embedding,
    metadata: { ...extractedMetadata, source: originalThought.metadata.source },
  });

  clearEmbeddingCache();

  // Reply in thread with update confirmation
  try {
    await postThreadReply(
      payload.event.channel,
      payload.event.thread_ts!,
      formatConfirmation(extractedMetadata.type, extractedMetadata.topics).replace(
        'Captured as',
        'Updated! Re-classified as',
      ),
      logger,
    );
  } catch (replyErr) {
    const msg = replyErr instanceof Error ? replyErr.message : 'Unknown error';
    logger.error('Failed to post update reply', { error: msg });
  }

  logger.info('Thought updated via thread reply', {
    thoughtId: originalThought.id,
    oldType: originalThought.metadata.type,
    newType: extractedMetadata.type,
  });

  return success({ ok: true });
}

/**
 * Slack webhook → embed → store → reply.
 *
 * Flow:
 *  1. Verify Slack signature (SEC-08)
 *  2. Handle URL verification challenge
 *  3. Skip retries / bot messages / non-message events
 *  4. Detect thread replies → update original thought
 *  5. Parallel: embed text + extract metadata via OpenRouter
 *  6. Store thought in DynamoDB
 *  7. Reply in Slack thread with confirmation
 *
 * SEC-15: Global try/catch — fail closed on all errors.
 */
export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const logger = createLogger(event);

  try {
    if (!event.body) {
      return errorResponse(400, 'Missing request body');
    }

    // --- Verify Slack signature (SEC-08) — fail closed ---
    const timestamp =
      event.headers['X-Slack-Request-Timestamp'] ??
      event.headers['x-slack-request-timestamp'];
    const signature =
      event.headers['X-Slack-Signature'] ??
      event.headers['x-slack-signature'];

    if (!timestamp || !signature) {
      logger.warn('Missing Slack signature headers');
      return errorResponse(401, 'Unauthorized');
    }

    if (!(await verifySlackSignature(event.body, timestamp, signature, logger))) {
      logger.warn('Invalid Slack signature');
      return errorResponse(401, 'Unauthorized');
    }

    // --- Parse and validate payload (SEC-05) ---
    const rawBody = JSON.parse(event.body) as Record<string, unknown>;
    const payload = slackPayloadSchema.parse(rawBody);

    // Handle URL verification challenge
    if (payload.type === 'url_verification') {
      return success({ challenge: payload.challenge });
    }

    // Skip Slack retries (original request is still processing or completed)
    const retryNum =
      event.headers['X-Slack-Retry-Num'] ??
      event.headers['x-slack-retry-num'];
    if (retryNum) {
      logger.info('Slack retry detected, skipping', { retryNum });
      return success({ ok: true });
    }

    // Skip non-message events
    if (payload.event.type !== 'message') {
      return success({ ok: true });
    }

    // Skip bot messages and message subtypes (edits, deletes, etc.)
    const rawEvent = rawBody.event as Record<string, unknown> | undefined;
    if (rawEvent?.bot_id || rawEvent?.subtype) {
      logger.debug('Skipping non-user message');
      return success({ ok: true });
    }

    // Skip empty messages (e.g., image-only)
    if (!payload.event.text.trim()) {
      logger.debug('Skipping empty message');
      return success({ ok: true });
    }

    // --- Detect thread reply: thread_ts present AND different from ts ---
    const isThreadReply =
      payload.event.thread_ts && payload.event.thread_ts !== payload.event.ts;
    if (isThreadReply) {
      return await handleThreadReply(payload, logger);
    }

    // --- Process: embed + metadata in parallel ---
    const [embedding, extractedMetadata] = await Promise.all([
      embedText(payload.event.text, logger),
      extractMetadata(payload.event.text, logger),
    ]);

    // --- Store in DynamoDB ---
    const thoughtId = v4();
    await putThought({
      id: thoughtId,
      content: payload.event.text,
      embedding,
      metadata: { ...extractedMetadata, source: 'slack' },
      slackChannel: payload.event.channel,
      slackTs: payload.event.ts,
    });

    // Invalidate embedding cache after write
    clearEmbeddingCache();

    // --- Reply in Slack thread ---
    // Isolated try/catch: thought is already stored, so a reply failure
    // should not return 500 (which triggers Slack retries that skip the reply).
    try {
      await postThreadReply(
        payload.event.channel,
        payload.event.ts,
        formatConfirmation(extractedMetadata.type, extractedMetadata.topics),
        logger,
      );
    } catch (replyErr) {
      const msg = replyErr instanceof Error ? replyErr.message : 'Unknown error';
      logger.error('Failed to post Slack thread reply', { error: msg });
    }

    logger.info('Thought ingested', { thoughtId, type: extractedMetadata.type });
    return success({ ok: true });
  } catch (err) {
    // SEC-15: Global error handler — fail closed, generic error to caller
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Ingest handler error', { error: message });
    return errorResponse(500, 'Internal server error');
  }
};
