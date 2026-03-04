import type { APIGatewayProxyResult } from 'aws-lambda';

/** SEC-09: Generic error messages — never expose internals to callers. */

export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function success(body: unknown): APIGatewayProxyResult {
  return jsonResponse(200, body);
}

export function errorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return jsonResponse(statusCode, { error: message });
}
