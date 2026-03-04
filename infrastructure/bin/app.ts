#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ParametersStack } from '../lib/parameters-stack';
import { DynamoDbStack } from '../lib/dynamodb-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { ApiGatewayStack } from '../lib/api-gateway-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { BudgetsStack } from '../lib/budgets-stack';

const app = new cdk.App();

const ownerEmail: string = app.node.tryGetContext('ownerEmail') ?? '';

if (!ownerEmail) {
  console.warn(
    'WARNING: ownerEmail context not set. Alerts and budget notifications will have no recipient.\n' +
    'Example: npx cdk deploy --all --context ownerEmail=you@example.com'
  );
}

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// 1. Parameters — SSM SecureString paths (created manually, referenced here)
const parametersStack = new ParametersStack(app, 'SecondBrain-Parameters', { env });

// 2. DynamoDB — Thoughts table with GSIs and PITR
const dynamoDbStack = new DynamoDbStack(app, 'SecondBrain-DynamoDB', { env });

// 3. Lambda — Both functions with least-privilege IAM
const lambdaStack = new LambdaStack(app, 'SecondBrain-Lambda', {
  env,
  table: dynamoDbStack.table,
  paramNames: parametersStack.paramNames,
  paramArns: parametersStack.paramArns,
});

// 4. API Gateway — REST API with access logging and throttling
const apiGatewayStack = new ApiGatewayStack(app, 'SecondBrain-APIGateway', {
  env,
  lambdaFunctions: lambdaStack.functions,
});

// 5. Monitoring — Alarms, SNS alerts, dashboard
const monitoringStack = new MonitoringStack(app, 'SecondBrain-Monitoring', {
  env,
  lambdaFunctions: lambdaStack.functions,
  api: apiGatewayStack.api,
  ownerEmail,
});

// 6. Budgets — $5/month cost alarm
const budgetsStack = new BudgetsStack(app, 'SecondBrain-Budgets', {
  env,
  ownerEmail,
});

// ─── Cost Allocation Tags ──────────────────────────────────────────────
const allStacks: cdk.Stack[] = [
  parametersStack,
  dynamoDbStack,
  lambdaStack,
  apiGatewayStack,
  monitoringStack,
  budgetsStack,
];

for (const stack of allStacks) {
  cdk.Tags.of(stack).add('Project', 'second-brain');
  cdk.Tags.of(stack).add('ManagedBy', 'cdk');
  cdk.Tags.of(stack).add('Owner', 'jkeeter');
}

const componentTags: Record<string, string> = {
  'SecondBrain-Parameters': 'parameters',
  'SecondBrain-DynamoDB': 'dynamodb',
  'SecondBrain-Lambda': 'lambda',
  'SecondBrain-APIGateway': 'api-gateway',
  'SecondBrain-Monitoring': 'monitoring',
  'SecondBrain-Budgets': 'budgets',
};

for (const stack of allStacks) {
  const component = componentTags[stack.stackName];
  if (component) {
    cdk.Tags.of(stack).add('Component', component);
  }
}

app.synth();
