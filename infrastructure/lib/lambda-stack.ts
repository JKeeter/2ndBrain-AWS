import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LambdaStackProps extends cdk.StackProps {
  table: dynamodb.ITable;
  paramNames: Record<string, string>;
  paramArns: string[];
}

const BACKEND_DIR = path.join(__dirname, '../../backend');

export class LambdaStack extends cdk.Stack {
  public readonly functions: Record<string, lambda.IFunction>;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const { table, paramNames, paramArns } = props;
    this.functions = {};

    // Shared env vars (resource names/paths only — not secrets; SEC-12)
    const sharedEnv: Record<string, string> = {
      TABLE_NAME: table.tableName,
      SSM_OPENROUTER_API_KEY: paramNames.openrouterApiKey,
      SSM_SLACK_BOT_TOKEN: paramNames.slackBotToken,
      SSM_SLACK_SIGNING_SECRET: paramNames.slackSigningSecret,
      SSM_MCP_ACCESS_KEY: paramNames.mcpAccessKey,
      NODE_OPTIONS: '--enable-source-maps',
    };

    // ── ingest-thought Lambda ──────────────────────────────────────────
    // SEC-14: Explicit log group with 90-day retention (Lambda cannot delete it)
    const ingestLogGroup = new logs.LogGroup(this, 'IngestThoughtLogs', {
      logGroupName: '/aws/lambda/second-brain-ingest-thought',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const ingestFn = new nodejs.NodejsFunction(this, 'IngestThoughtFn', {
      functionName: 'second-brain-ingest-thought',
      description: 'Slack webhook: embed thought, store in DynamoDB, reply in thread',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(BACKEND_DIR, 'functions/ingest-thought/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...sharedEnv,
        FUNCTION_NAME: 'second-brain-ingest-thought',
      },
      logGroup: ingestLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
    });

    // SEC-06: Least-privilege IAM for ingest-thought
    // DynamoDB write: PutItem (new thoughts) + UpdateItem (thread reply updates)
    // DynamoDB read: Query on GSI3-BySlackTs (lookup original thought for thread replies)
    ingestFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      resources: [table.tableArn],
    }));
    ingestFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${table.tableArn}/index/GSI3-BySlackTs`],
    }));

    // SSM read: GetParameter for 3 specific secrets
    ingestFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${paramNames.openrouterApiKey}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${paramNames.slackBotToken}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${paramNames.slackSigningSecret}`,
      ],
    }));

    this.functions['ingest-thought'] = ingestFn;

    // ── mcp-server Lambda ──────────────────────────────────────────────
    const mcpLogGroup = new logs.LogGroup(this, 'McpServerLogs', {
      logGroupName: '/aws/lambda/second-brain-mcp-server',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const mcpFn = new nodejs.NodejsFunction(this, 'McpServerFn', {
      functionName: 'second-brain-mcp-server',
      description: 'MCP JSON-RPC server: search, list, stats, capture thoughts',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(BACKEND_DIR, 'functions/mcp-server/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        ...sharedEnv,
        FUNCTION_NAME: 'second-brain-mcp-server',
      },
      logGroup: mcpLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
    });

    // SEC-06: Least-privilege IAM for mcp-server
    // DynamoDB read: Query + GetItem + Scan (vector search requires full table scan)
    mcpFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Scan'],
      resources: [
        table.tableArn,
        `${table.tableArn}/index/*`,
      ],
    }));

    // DynamoDB write: PutItem (capture_thought tool creates new thoughts)
    mcpFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [table.tableArn],
    }));

    // SSM read: GetParameter for 2 specific secrets
    mcpFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${paramNames.openrouterApiKey}`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter${paramNames.mcpAccessKey}`,
      ],
    }));

    this.functions['mcp-server'] = mcpFn;

    // SEC-14: Lambda roles intentionally do NOT have logs:DeleteLogGroup or
    // logs:DeleteLogStream — Lambdas cannot delete their own audit logs.
    // CDK auto-grants CreateLogGroup/CreateLogStream/PutLogEvents via the
    // default execution role, which is the minimum needed.

    new cdk.CfnOutput(this, 'IngestFunctionArn', {
      value: ingestFn.functionArn,
      description: 'Ingest thought Lambda ARN',
    });

    new cdk.CfnOutput(this, 'McpFunctionArn', {
      value: mcpFn.functionArn,
      description: 'MCP server Lambda ARN',
    });
  }
}
