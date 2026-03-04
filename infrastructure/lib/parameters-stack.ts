import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Defines SSM Parameter Store paths for all secrets.
 *
 * SecureString parameters cannot be created via CloudFormation/CDK.
 * Create them manually before deploying the Lambda stack:
 *
 *   aws ssm put-parameter --name "/second-brain/openrouter-api-key" --type SecureString --value "YOUR_KEY"
 *   aws ssm put-parameter --name "/second-brain/slack-bot-token" --type SecureString --value "xoxb-..."
 *   aws ssm put-parameter --name "/second-brain/slack-signing-secret" --type SecureString --value "YOUR_SECRET"
 *   aws ssm put-parameter --name "/second-brain/mcp-access-key" --type SecureString --value "YOUR_KEY"
 */
export class ParametersStack extends cdk.Stack {
  /** SSM parameter name paths */
  public readonly paramNames: Record<string, string>;
  /** SSM parameter ARNs for IAM policies */
  public readonly paramArns: string[];

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.paramNames = {
      openrouterApiKey: '/second-brain/openrouter-api-key',
      slackBotToken: '/second-brain/slack-bot-token',
      slackSigningSecret: '/second-brain/slack-signing-secret',
      mcpAccessKey: '/second-brain/mcp-access-key',
    };

    // Construct ARNs for IAM policy resources (SEC-06: specific resource ARNs)
    this.paramArns = Object.values(this.paramNames).map(
      (name) => `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`
    );

    for (const [key, name] of Object.entries(this.paramNames)) {
      new cdk.CfnOutput(this, `Param-${key}`, {
        value: name,
        description: `SSM parameter path for ${key}`,
      });
    }
  }
}
