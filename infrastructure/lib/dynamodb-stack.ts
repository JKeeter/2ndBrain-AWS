import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DynamoDbStack extends cdk.Stack {
  public readonly table: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // SEC-01: Encryption at rest enabled by default (AWS-managed key)
    this.table = new dynamodb.Table(this, 'ThoughtsTable', {
      tableName: 'second-brain-thoughts',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, // SEC-13: data integrity + audit trail
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Never delete data on stack destroy
    });

    // GSI1: Query by metadata type + date
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1-ByType',
      partitionKey: { name: 'thought_type', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: Query all thoughts by date (for listing/pagination)
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2-ByDate',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'created_at', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'DynamoDB thoughts table name',
    });

    new cdk.CfnOutput(this, 'TableArn', {
      value: this.table.tableArn,
      description: 'DynamoDB thoughts table ARN',
    });
  }
}
