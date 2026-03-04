/**
 * One-time migration: rename thought_type 'note' → 'observation' for existing records.
 *
 * Usage:
 *   npx ts-node migration/migrate-note-to-observation.ts
 *
 * Requires AWS credentials with DynamoDB read/write access to second-brain-thoughts table.
 */

import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

const TABLE_NAME = 'second-brain-thoughts';
const client = new DynamoDBClient({});

async function migrate(): Promise<void> {
  console.log('Scanning for thoughts with thought_type=note...');

  let lastKey: Record<string, unknown> | undefined;
  let updated = 0;
  let scanned = 0;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'thought_type = :note',
        ExpressionAttributeValues: marshall({ ':note': 'note' }),
        ProjectionExpression: 'PK, SK, metadata',
        ...(lastKey && { ExclusiveStartKey: marshall(lastKey) }),
      }),
    );

    scanned += result.ScannedCount ?? 0;

    for (const item of result.Items ?? []) {
      const raw = unmarshall(item);
      const pk = raw.PK as string;
      const sk = raw.SK as string;

      console.log(`  Updating ${sk}: note → observation`);

      await client.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({ PK: pk, SK: sk }),
          UpdateExpression:
            'SET thought_type = :newType, metadata.#t = :newType',
          ExpressionAttributeNames: { '#t': 'type' },
          ExpressionAttributeValues: marshall({ ':newType': 'observation' }),
        }),
      );

      updated++;
    }

    lastKey = result.LastEvaluatedKey
      ? unmarshall(result.LastEvaluatedKey)
      : undefined;
  } while (lastKey);

  console.log(`\nDone. Scanned ${scanned} items, updated ${updated} from 'note' to 'observation'.`);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
