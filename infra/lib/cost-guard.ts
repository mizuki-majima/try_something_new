import { Duration } from "aws-cdk-lib";
import type * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import { ALARM_METRIC_NAMESPACE, SESSION_CEILING_LOG, TABLE_OPERATIONS } from "./config";

export type CostGuardProps = {
  alertEmail: string;
  monthlyBudgetUsd: number;
  /**
   * Cost allocation tag ("user:<key>$<value>") the budget is limited to: the AWS account is shared,
   * and an unfiltered budget would spend its once-a-month notices on other projects' costs.
   */
  costAllocationTag: string;
  apiFunction: lambda.IFunction;
  /** The api Lambda's log group: a metric filter turns its "global session ceiling" warning into an alarm (R11). */
  apiLogGroup: logs.ILogGroup;
  /** The HTTP API stage ($default): its 5xx count includes route errors the Lambda turns into 500s. */
  apiStage: apigw.IHttpStage;
  reminderFunction: lambda.IFunction;
  /** The table whose on-demand throughput is capped (TABLE_MAX_THROUGHPUT). */
  table: dynamodb.ITable;
  /** The DynamoDB operations the Lambdas use (CloudWatch "Operation" dimension, 1 to 10). */
  tableOperations: readonly string[];
};

/**
 * Alarm thresholds (docs/deploy.md). CloudWatch bills alarms per METRIC: an alarm on one metric is
 * one alarm metric, a metric-math alarm counts every metric in its expression (DynamoThrottles sums
 * one per DynamoDB operation). $0.10 per alarm metric per month beyond the account's 10 free ones,
 * which the shared account has probably used already. The log metric filter's custom metric only has
 * data (and only bills, $0.30 per metric-month prorated by the hour) while the warning appears.
 */
export const ALARMS = {
  /** API Gateway 5xx responses, or api Lambda errors (init, SSM, timeout), in 5 minutes. */
  apiPerFiveMinutes: 5,
  /** Failed reminder runs in an hour (it runs 4 times an hour; one failure may be a blip). */
  reminderPerHour: 2,
  /**
   * Throttled DynamoDB requests in 5 minutes. 100 users stay far below the throughput cap, so any
   * throttle means the cost circuit breaker tripped (abuse, or a burst a legitimate user will feel).
   */
  dynamoThrottlesPerFiveMinutes: 1,
  /**
   * "global session ceiling reached" warnings in 5 minutes: new visitors are being turned away
   * (QUOTAS.sessionsGlobalPerHour, R11). Any one means a flood from many networks, or a real spike.
   */
  sessionCeilingPerFiveMinutes: 1,
} as const;

/** Alarm metrics the stack bills for: Api5xx, ApiErrors, ReminderErrors, SessionCeiling + DynamoThrottles' operations. */
export const ALARM_METRIC_COUNT = 4 + TABLE_OPERATIONS.length;

/** Monthly cost budget plus alarms on the API, the reminder and the table, all mailed to alertEmail. */
export class CostGuard extends Construct {
  constructor(scope: Construct, id: string, props: CostGuardProps) {
    super(scope, id);

    const subscriber = { subscriptionType: "EMAIL", address: props.alertEmail };
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: "thirty-days-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.monthlyBudgetUsd, unit: "USD" },
        costFilters: { TagKeyValue: [props.costAllocationTag] },
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
    const action = new cwActions.SnsAction(topic);

    const alarm = (alarmId: string, alarmDescription: string, metric: cloudwatch.IMetric, threshold: number) =>
      new cloudwatch.Alarm(this, alarmId, {
        alarmDescription,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);

    const fiveMinutes = { period: Duration.minutes(5), statistic: "Sum" };
    // Route exceptions become ordinary 500 responses (apps/api errors.ts onError), so the Lambda's
    // Errors metric never sees them; API Gateway's 5xx count does.
    alarm(
      "Api5xx",
      "thirty-days: API の 5xx 応答が5分間に5回以上（API Gateway ThirtyDaysApi / $default）",
      props.apiStage.metricServerError(fiveMinutes),
      ALARMS.apiPerFiveMinutes,
    );
    // The logical id stays "ApiErrors" (it existed before the 5xx alarm).
    alarm(
      "ApiErrors",
      "thirty-days: api Lambda の失敗（起動・SSM・タイムアウト）が5分間に5回以上",
      props.apiFunction.metricErrors(fiveMinutes),
      ALARMS.apiPerFiveMinutes,
    );
    // The job logs per-user failures and carries on; this catches runs that fail as a whole.
    alarm(
      "ReminderErrors",
      "thirty-days: リマインド（15分ごと）の実行が1時間に2回以上失敗",
      props.reminderFunction.metricErrors({ period: Duration.hours(1), statistic: "Sum" }),
      ALARMS.reminderPerHour,
    );
    // The table's on-demand throughput is capped (cost circuit breaker); above the cap DynamoDB
    // throttles. ThrottledRequests counts per operation (a GSI's cap shows on the table's writes and
    // queries), so the alarm sums the operations the Lambdas use.
    alarm(
      "DynamoThrottles",
      "thirty-days: DynamoDB のスロットル（費用の上限に当たった）が5分間に1回以上",
      throttledRequests(props.table, props.tableOperations),
      ALARMS.dynamoThrottlesPerFiveMinutes,
    );
    // The API logs a warning each time the global new-session ceiling refuses someone (R11). The
    // filter publishes 1 per matching line and nothing otherwise (no default value), so the custom
    // metric is empty, and free, in hours without it.
    const ceiling = new logs.MetricFilter(this, "SessionCeilingFilter", {
      logGroup: props.apiLogGroup,
      filterPattern: logs.FilterPattern.allTerms(SESSION_CEILING_LOG),
      metricNamespace: ALARM_METRIC_NAMESPACE,
      metricName: "SessionCeilingReached",
      metricValue: "1",
    });
    alarm(
      "SessionCeiling",
      "thirty-days: アカウント作成の全体の上限（1時間あたり）に当たり、新しく来た人を断っている（5分間に1回以上）",
      ceiling.metric(fiveMinutes),
      ALARMS.sessionCeilingPerFiveMinutes,
    );
  }
}

/**
 * Sum of ThrottledRequests over `operations`, every 5 minutes. The metric only has data points when
 * something was throttled, and `a + b` is empty wherever either side is: each term is FILL(…, 0) so
 * one throttled operation is enough (CDK's metricThrottledRequestsForOperations adds them unfilled).
 */
export function throttledRequests(table: dynamodb.ITable, operations: readonly string[]): cloudwatch.MathExpression {
  // An alarm's math expression may use at most 10 metrics.
  if (operations.length === 0 || operations.length > 10) {
    throw new Error(`tableOperations は1〜10個にしてください（${operations.length}個）`);
  }
  const period = Duration.minutes(5);
  const usingMetrics = Object.fromEntries(
    operations.map((operation) => [
      operation.toLowerCase(),
      new cloudwatch.Metric({
        namespace: "AWS/DynamoDB",
        metricName: "ThrottledRequests",
        dimensionsMap: { TableName: table.tableName, Operation: operation },
        statistic: "Sum",
        period,
      }),
    ]),
  );
  return new cloudwatch.MathExpression({
    expression: Object.keys(usingMetrics)
      .map((id) => `FILL(${id}, 0)`)
      .join(" + "),
    usingMetrics,
    period,
    label: "ThrottledRequests (all operations)",
  });
}
