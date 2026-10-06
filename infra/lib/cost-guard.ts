import { Duration } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";

export type CostGuardProps = {
  alertEmail: string;
  monthlyBudgetUsd: number;
  apiFunction: lambda.IFunction;
};

/** Monthly cost budget plus an error alarm on the API, both mailed to alertEmail. */
export class CostGuard extends Construct {
  constructor(scope: Construct, id: string, props: CostGuardProps) {
    super(scope, id);

    const subscriber = { subscriptionType: "EMAIL", address: props.alertEmail };
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [subscriber],
        },
        {
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [subscriber],
        },
      ],
    });

    const topic = new sns.Topic(this, "AlarmTopic", { displayName: "thirty-days alerts", enforceSSL: true });
    topic.addSubscription(new subs.EmailSubscription(props.alertEmail));

    const errors = new cloudwatch.Alarm(this, "ApiErrors", {
      alarmDescription: "api Lambda のエラーが5分間に5回以上",
      metric: props.apiFunction.metricErrors({ period: Duration.minutes(5), statistic: "Sum" }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    errors.addAlarmAction(new cwActions.SnsAction(topic));
  }
}
