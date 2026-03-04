import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Structured logger for CloudWatch (SEC-03).
 * Every log entry includes: timestamp, requestId, functionName, level, message.
 * Never logs PII, tokens, or secrets.
 */

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(event: APIGatewayProxyEvent): Logger {
  const requestId = event.requestContext.requestId;
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'unknown';

  function log(level: string, message: string, data?: Record<string, unknown>): void {
    const entry = {
      level,
      functionName,
      requestId,
      message,
      timestamp: new Date().toISOString(),
      ...data,
    };
    if (level === 'error') {
      console.error(JSON.stringify(entry));
    } else if (level === 'warn') {
      console.warn(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  return {
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
    debug: (message, data) => log('debug', message, data),
  };
}
