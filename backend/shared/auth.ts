import { createHmac, timingSafeEqual } from 'crypto';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { Logger } from './logger';

/**
 * SEC-08: Slack HMAC-SHA256 signature verification + MCP API key validation.
 * SEC-12: All secrets loaded from SSM Parameter Store with in-memory caching.
 */

// SSM client — singleton reused across Lambda invocations
const ssm = new SSMClient({});

// Secret cache for warm Lambda containers (5-min TTL)
const secretCache = new Map<string, { value: string; expiresAt: number }>();
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getSecret(name: string): Promise<string> {
  const cached = secretCache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  const result = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );

  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter not found: ${name}`);
  }

  secretCache.set(name, { value, expiresAt: Date.now() + SECRET_CACHE_TTL_MS });
  return value;
}

/** Verify Slack request signature with 5-minute replay protection. */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string,
  signature: string,
  logger: Logger,
): Promise<boolean> {
  const requestTimestamp = parseInt(timestamp, 10);
  if (isNaN(requestTimestamp)) {
    logger.warn('Invalid Slack timestamp format');
    return false;
  }

  // 5-minute replay window
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - requestTimestamp) > 300) {
    logger.warn('Slack request outside replay window', {
      age: now - requestTimestamp,
    });
    return false;
  }

  const signingSecret = await getSecret('/second-brain/slack-signing-secret');
  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = `v0=${createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;

  // Constant-time comparison to prevent timing attacks
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Verify MCP API key from x-brain-key header. */
export async function verifyMcpApiKey(
  apiKey: string | undefined,
  logger: Logger,
): Promise<boolean> {
  if (!apiKey) {
    logger.warn('Missing MCP API key');
    return false;
  }

  const expectedKey = await getSecret('/second-brain/mcp-access-key');

  try {
    return timingSafeEqual(Buffer.from(apiKey), Buffer.from(expectedKey));
  } catch {
    return false;
  }
}

/** Clear the secret cache (for testing). */
export function clearSecretCache(): void {
  secretCache.clear();
}
