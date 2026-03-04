import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  lambdaFunctions: Record<string, lambda.IFunction>;
  api: apigateway.RestApi;
  ownerEmail: string;
}

export class MonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const { lambdaFunctions, api, ownerEmail } = props;

    // SEC-14: SNS topic for security and operational alerts
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: 'second-brain-alerts',
      displayName: 'Second Brain Alerts',
    });

    if (ownerEmail) {
      alertTopic.addSubscription(
        new sns_subscriptions.EmailSubscription(ownerEmail)
      );
    }

    // Lambda error alarms (per function)
    for (const [name, fn] of Object.entries(lambdaFunctions)) {
      const errorAlarm = new cloudwatch.Alarm(this, `${name}-errors`, {
        alarmName: `second-brain-${name}-errors`,
        alarmDescription: `Lambda ${name} errors > 0 in 5 minutes`,
        metric: fn.metricErrors({
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 0,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      errorAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));
    }

    // API Gateway 5xx alarm
    const api5xxAlarm = new cloudwatch.Alarm(this, 'Api5xxErrors', {
      alarmName: 'second-brain-api-5xx',
      alarmDescription: 'API Gateway 5xx errors > 0 in 5 minutes',
      metric: api.metricServerError({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api5xxAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // SEC-14: 4xx alarm for auth failure / abuse detection
    const api4xxAlarm = new cloudwatch.Alarm(this, 'Api4xxErrors', {
      alarmName: 'second-brain-api-4xx',
      alarmDescription: 'API Gateway 4xx errors > 10 in 5 minutes (possible auth abuse)',
      metric: api.metricClientError({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    api4xxAlarm.addAlarmAction(new cloudwatch_actions.SnsAction(alertTopic));

    // SEC-14: CloudWatch Dashboard for operational + security monitoring
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'second-brain',
    });

    const lambdaWidgets = Object.entries(lambdaFunctions).flatMap(([name, fn]) => [
      new cloudwatch.GraphWidget({
        title: `${name} — Invocations & Errors`,
        left: [
          fn.metricInvocations({ period: cdk.Duration.minutes(5) }),
          fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: `${name} — Duration`,
        left: [
          fn.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
          fn.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
        ],
        width: 12,
      }),
    ]);

    const apiWidgets = [
      new cloudwatch.GraphWidget({
        title: 'API Gateway — Requests',
        left: [api.metricCount({ period: cdk.Duration.minutes(5) })],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway — Errors',
        left: [
          api.metricClientError({ period: cdk.Duration.minutes(5) }),
          api.metricServerError({ period: cdk.Duration.minutes(5) }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'API Gateway — Latency',
        left: [
          api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'Average' }),
          api.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
        ],
        width: 12,
      }),
    ];

    dashboard.addWidgets(...lambdaWidgets, ...apiWidgets);
  }
}
