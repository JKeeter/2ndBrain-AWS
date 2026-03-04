import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface ApiGatewayStackProps extends cdk.StackProps {
  lambdaFunctions: Record<string, lambda.IFunction>;
}

export class ApiGatewayStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const { lambdaFunctions } = props;

    // SEC-02: Access log group for API Gateway
    const accessLogGroup = new logs.LogGroup(this, 'ApiAccessLogs', {
      logGroupName: '/aws/apigateway/second-brain-access-logs',
      retention: logs.RetentionDays.THREE_MONTHS, // SEC-14: 90-day retention
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // REST API with throttling (SEC-07, SEC-11)
    this.api = new apigateway.RestApi(this, 'SecondBrainApi', {
      restApiName: 'Second Brain API',
      description: 'REST API for Second Brain knowledge management',
      deployOptions: {
        stageName: 'prod',
        loggingLevel: apigateway.MethodLoggingLevel.INFO,
        dataTraceEnabled: false, // SEC-03: don't log request/response bodies (may contain PII)
        metricsEnabled: true,
        // SEC-11: Rate limiting on public-facing API
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
        // SEC-02: Structured access logging
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogGroup),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
    });

    // No auth at gateway level — Slack signature and MCP API key
    // are verified in Lambda handlers (SEC-08, SEC-11: defense in depth)
    const noAuth: apigateway.MethodOptions = {
      authorizationType: apigateway.AuthorizationType.NONE,
    };

    // POST /ingest — Slack webhook for thought capture
    const ingest = this.api.root.addResource('ingest');
    ingest.addMethod(
      'POST',
      new apigateway.LambdaIntegration(lambdaFunctions['ingest-thought'], { proxy: true }),
      noAuth,
    );

    // POST /mcp — MCP JSON-RPC endpoint
    const mcp = this.api.root.addResource('mcp');
    mcp.addMethod(
      'POST',
      new apigateway.LambdaIntegration(lambdaFunctions['mcp-server'], { proxy: true }),
      noAuth,
    );

    // GET /health — lightweight health check (mock integration, no Lambda)
    const health = this.api.root.addResource('health');
    health.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: {
          'application/json': '{"status":"healthy"}',
        },
      }],
      requestTemplates: {
        'application/json': '{"statusCode": 200}',
      },
    }), {
      ...noAuth,
      methodResponses: [{
        statusCode: '200',
        responseModels: {
          'application/json': apigateway.Model.EMPTY_MODEL,
        },
      }],
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway base URL',
    });

    new cdk.CfnOutput(this, 'IngestUrl', {
      value: `${this.api.url}ingest`,
      description: 'Ingest webhook URL (configure in Slack Event Subscriptions)',
    });

    new cdk.CfnOutput(this, 'McpUrl', {
      value: `${this.api.url}mcp`,
      description: 'MCP server URL (configure in AI client)',
    });
  }
}
