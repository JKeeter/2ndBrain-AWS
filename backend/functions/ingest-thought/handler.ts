import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 } from 'uuid';
import { createLogger } from '../../shared/logger';
import { verifySlackSignature } from '../../shared/auth';
import { slackPayloadSchema } from '../../shared/validation';
import { putThought } from '../../shared/dynamodb';
import { embedText, extractMetadata } from '../../shared/openrouter';
import { postThreadReply } from '../../shared/slack';
import { clearEmbeddingCache } from '../../shared/vector';
import { success, errorResponse } from '../../shared/responses';

/**
 * Slack webhook → embed → store → reply.
 *
 * Flow:
 *  1. Verify Slack signature (SEC-08)
 *  2. Handle URL verification challenge
 *  3. Skip retries / bot messages / non-message events
 *  4. Parallel: embed text + extract metadata via OpenRouter
 *  5. Store thought in DynamoDB
 *  6. Reply in Slack thread with confirmation
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
    const topicsList =
      extractedMetadata.topics.length > 0
        ? extractedMetadata.topics.join(', ')
        : 'none';
    await postThreadReply(
      payload.event.channel,
      payload.event.ts,
      `Captured as ${extractedMetadata.type}. Topics: ${topicsList}.`,
      logger,
    );

    logger.info('Thought ingested', { thoughtId, type: extractedMetadata.type });
    return success({ ok: true });
  } catch (err) {
    // SEC-15: Global error handler — fail closed, generic error to caller
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error('Ingest handler error', { error: message });
    return errorResponse(500, 'Internal server error');
  }
};
