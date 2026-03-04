import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  BatchGetItemCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { ThoughtMetadata, ThoughtRecord } from './types';
import { embeddingToBuffer, bufferToEmbedding } from './vector';

/**
 * DynamoDB operations for the thoughts table.
 * SEC-05: No string concatenation in queries — all values via ExpressionAttributeValues.
 */

const TABLE_NAME = process.env.TABLE_NAME ?? 'second-brain-thoughts';
const client = new DynamoDBClient({});

// --- Internal helpers ---

function toThoughtRecord(raw: Record<string, unknown>): ThoughtRecord {
  return {
    id: (raw.SK as string).replace('thought#', ''),
    content: raw.content as string,
    embedding: bufferToEmbedding(raw.embedding as Uint8Array),
    metadata: raw.metadata as ThoughtMetadata,
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
    slack_channel: raw.slack_channel as string | undefined,
    slack_ts: raw.slack_ts as string | undefined,
  };
}

function encodeCursor(key: Record<string, AttributeValue>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(cursor: string): Record<string, AttributeValue> {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<
    string,
    AttributeValue
  >;
}

// --- Write operations ---

export async function putThought(params: {
  id: string;
  content: string;
  embedding: Float32Array;
  metadata: ThoughtMetadata;
  slackChannel?: string;
  slackTs?: string;
}): Promise<void> {
  const now = new Date().toISOString();

  await client.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(
        {
          PK: 'THOUGHT',
          SK: `thought#${params.id}`,
          content: params.content,
          embedding: embeddingToBuffer(params.embedding),
          metadata: params.metadata,
          created_at: now,
          updated_at: now,
          // Top-level attribute for GSI1-ByType
          thought_type: params.metadata.type,
          ...(params.slackChannel && { slack_channel: params.slackChannel }),
          ...(params.slackTs && { slack_ts: params.slackTs }),
        },
        { removeUndefinedValues: true },
      ),
    }),
  );
}

// --- Read operations ---

/** Scan all thoughts (for brute-force vector search). */
export async function scanAllThoughts(): Promise<ThoughtRecord[]> {
  const items: ThoughtRecord[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );

    for (const item of result.Items ?? []) {
      items.push(toThoughtRecord(unmarshall(item)));
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

/** Query thoughts by type using GSI1-ByType (ALL projection). */
export async function queryByType(
  type: string,
  options: {
    limit?: number;
    startDate?: string;
    endDate?: string;
    cursor?: string;
  } = {},
): Promise<{ items: ThoughtRecord[]; cursor?: string }> {
  const expressionValues: Record<string, unknown> = { ':type': type };
  let keyCondition = 'thought_type = :type';

  if (options.startDate && options.endDate) {
    keyCondition += ' AND created_at BETWEEN :start AND :end';
    expressionValues[':start'] = options.startDate;
    expressionValues[':end'] = options.endDate;
  } else if (options.startDate) {
    keyCondition += ' AND created_at >= :start';
    expressionValues[':start'] = options.startDate;
  } else if (options.endDate) {
    keyCondition += ' AND created_at <= :end';
    expressionValues[':end'] = options.endDate;
  }

  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI1-ByType',
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: marshall(expressionValues),
      Limit: options.limit ?? 20,
      ScanIndexForward: false,
      ...(options.cursor && { ExclusiveStartKey: decodeCursor(options.cursor) }),
    }),
  );

  const items = (result.Items ?? []).map((item) =>
    toThoughtRecord(unmarshall(item)),
  );

  const cursor = result.LastEvaluatedKey
    ? encodeCursor(result.LastEvaluatedKey)
    : undefined;

  return { items, cursor };
}

/** Query thoughts by date using GSI2-ByDate (KEYS_ONLY → BatchGet for full items). */
export async function queryByDate(
  options: {
    limit?: number;
    startDate?: string;
    endDate?: string;
    cursor?: string;
  } = {},
): Promise<{ items: ThoughtRecord[]; cursor?: string }> {
  const expressionValues: Record<string, unknown> = { ':pk': 'THOUGHT' };
  let keyCondition = 'PK = :pk';

  if (options.startDate && options.endDate) {
    keyCondition += ' AND created_at BETWEEN :start AND :end';
    expressionValues[':start'] = options.startDate;
    expressionValues[':end'] = options.endDate;
  } else if (options.startDate) {
    keyCondition += ' AND created_at >= :start';
    expressionValues[':start'] = options.startDate;
  } else if (options.endDate) {
    keyCondition += ' AND created_at <= :end';
    expressionValues[':end'] = options.endDate;
  }

  const queryResult = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'GSI2-ByDate',
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: marshall(expressionValues),
      Limit: options.limit ?? 20,
      ScanIndexForward: false,
      ...(options.cursor && { ExclusiveStartKey: decodeCursor(options.cursor) }),
    }),
  );

  if (!queryResult.Items?.length) {
    return { items: [], cursor: undefined };
  }

  // GSI2 is KEYS_ONLY — batch get full items from the main table
  const keys = queryResult.Items.map((item) => ({
    PK: item.PK!,
    SK: item.SK!,
  }));

  const batchResult = await client.send(
    new BatchGetItemCommand({
      RequestItems: {
        [TABLE_NAME]: { Keys: keys as Record<string, AttributeValue>[] },
      },
    }),
  );

  const items = (batchResult.Responses?.[TABLE_NAME] ?? []).map((item) =>
    toThoughtRecord(unmarshall(item)),
  );

  // BatchGetItem doesn't preserve order — re-sort newest first
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const cursor = queryResult.LastEvaluatedKey
    ? encodeCursor(queryResult.LastEvaluatedKey)
    : undefined;

  return { items, cursor };
}

/** Get aggregate stats: total count, counts by type, date range. */
export async function getStats(): Promise<{
  total: number;
  byType: Record<string, number>;
  oldestDate?: string;
  newestDate?: string;
}> {
  // Count by type via full scan (fine at <2000 items)
  const byType: Record<string, number> = {};
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: 'thought_type',
        ...(lastKey && { ExclusiveStartKey: lastKey }),
      }),
    );

    for (const item of result.Items ?? []) {
      const raw = unmarshall(item);
      const type = (raw.thought_type as string) ?? 'unknown';
      byType[type] = (byType[type] ?? 0) + 1;
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  const total = Object.values(byType).reduce((sum, n) => sum + n, 0);

  // Oldest and newest via GSI2-ByDate
  const [oldestResult, newestResult] = await Promise.all([
    client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2-ByDate',
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: marshall({ ':pk': 'THOUGHT' }),
        Limit: 1,
        ScanIndexForward: true,
      }),
    ),
    client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'GSI2-ByDate',
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: marshall({ ':pk': 'THOUGHT' }),
        Limit: 1,
        ScanIndexForward: false,
      }),
    ),
  ]);

  const oldestDate = oldestResult.Items?.[0]
    ? (unmarshall(oldestResult.Items[0]).created_at as string)
    : undefined;
  const newestDate = newestResult.Items?.[0]
    ? (unmarshall(newestResult.Items[0]).created_at as string)
    : undefined;

  return { total, byType, oldestDate, newestDate };
}
