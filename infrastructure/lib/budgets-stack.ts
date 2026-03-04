import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import { Construct } from 'constructs';

export interface BudgetsStackProps extends cdk.StackProps {
  ownerEmail: string;
}

export class BudgetsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BudgetsStackProps) {
    super(scope, id, props);

    const { ownerEmail } = props;

    // $5/month budget alarm
    new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: 'second-brain-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: 5,
          unit: 'USD',
        },
        costFilters: {
          TagKeyValue: ['user:Project$second-brain'],
        },
      },
      notificationsWithSubscribers: ownerEmail
        ? [
            {
              notification: {
                notificationType: 'ACTUAL',
                comparisonOperator: 'GREATER_THAN',
                threshold: 80,
                thresholdType: 'PERCENTAGE',
              },
              subscribers: [{
                subscriptionType: 'EMAIL',
                address: ownerEmail,
              }],
            },
            {
              notification: {
                notificationType: 'ACTUAL',
                comparisonOperator: 'GREATER_THAN',
                threshold: 100,
                thresholdType: 'PERCENTAGE',
              },
              subscribers: [{
                subscriptionType: 'EMAIL',
                address: ownerEmail,
              }],
            },
          ]
        : [],
    });
  }
}
