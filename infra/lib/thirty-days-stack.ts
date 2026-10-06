/**
 * SPEC "Architecture": CloudFront → S3 (SPA) / HTTP API → Lambda "api" / S3 media,
 * EventBridge → Lambda "reminder", one DynamoDB table. No generative AI (ADR 0003).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from "aws-cdk-lib";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as ssm from "aws-cdk-lib/aws-ssm";
import type { Construct } from "constructs";
import { CACHE_CONTROL, MONTHLY_BUDGET_USD, NO_CACHE_FILES, PARAM, PROJECT_TAG, TABLE_KEYS, VAPID_SUBJECT } from "./config";
import { CostGuard } from "./cost-guard";
import {
  API_CSP,
  FORWARD_HOST_CODE,
  HSTS_MAX_AGE_SECONDS,
  MEDIA_PATH_CODE,
  PERMISSIONS_POLICY,
  SHARE_PAGE_CSP,
  SITE_CSP,
  SPA_REWRITE_CODE,
} from "./edge";

const infraDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_ASSET_PATHS = {
  webDistPath: path.join(infraDir, "../apps/web/dist"),
  apiDistPath: path.join(infraDir, "../apps/api/dist/api"),
  reminderDistPath: path.join(infraDir, "../apps/api/dist/reminder"),
} as const;

export type ThirtyDaysStackProps = StackProps & {
  /** Built SPA (vite). */
  webDistPath?: string;
  /** Directory holding the bundled api Lambda (index.mjs). */
  apiDistPath?: string;
  /** Directory holding the bundled reminder Lambda (index.mjs). */
  reminderDistPath?: string;
  /** Enables the AWS Budgets / alarm mails. */
  alertEmail?: string;
};

export class ThirtyDaysStack extends Stack {
  constructor(scope: Construct, id: string, props: ThirtyDaysStackProps = {}) {
    super(scope, id, props);
    Tags.of(this).add("Project", PROJECT_TAG);

    const webDistPath = props.webDistPath ?? DEFAULT_ASSET_PATHS.webDistPath;
    const apiDistPath = props.apiDistPath ?? DEFAULT_ASSET_PATHS.apiDistPath;
    const reminderDistPath = props.reminderDistPath ?? DEFAULT_ASSET_PATHS.reminderDistPath;

    // ---- Data ------------------------------------------------------------------------------
    const table = new dynamodb.Table(this, "Table", {
      partitionKey: { name: TABLE_KEYS.partitionKey, type: dynamodb.AttributeType.STRING },
      sortKey: { name: TABLE_KEYS.sortKey, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TABLE_KEYS.ttlAttribute,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const ix of TABLE_KEYS.indexes) {
      table.addGlobalSecondaryIndex({
        indexName: ix.name,
        partitionKey: { name: ix.partitionKey, type: dynamodb.AttributeType.STRING },
        sortKey: { name: ix.sortKey, type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
    }

    const privateBucket = (bucketId: string) =>
      new s3.Bucket(this, bucketId, {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        encryption: s3.BucketEncryption.S3_MANAGED,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    const webBucket = privateBucket("WebBucket");
    const mediaBucket = privateBucket("MediaBucket");

    // ---- Parameters (values live in SSM; the template only carries the names) ----------------
    const vapidPublicKey = ssm.StringParameter.valueForStringParameter(this, PARAM.vapidPublicKey);
    const originVerify = ssm.StringParameter.valueForStringParameter(this, PARAM.originVerify);
    const secureParamArn = (name: string) =>
      this.formatArn({ service: "ssm", resource: "parameter", resourceName: name.replace(/^\//, "") });
    const readSecureParams = (names: string[]) => [
      new iam.PolicyStatement({ actions: ["ssm:GetParameter"], resources: names.map(secureParamArn) }),
      new iam.PolicyStatement({
        actions: ["kms:Decrypt"],
        resources: [this.formatArn({ service: "kms", resource: "key", resourceName: "*" })],
        conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
      }),
    ];

    // ---- Lambdas ---------------------------------------------------------------------------
    const logGroup = (logId: string) =>
      new logs.LogGroup(this, logId, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });

    const apiFn = new lambda.Function(this, "ApiFunction", {
      description: "thirty-days API (Hono)",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(apiDistPath),
      handler: "index.handler",
      memorySize: 512,
      timeout: Duration.seconds(30),
      logGroup: logGroup("ApiLogs"),
      environment: {
        TABLE_NAME: table.tableName,
        MEDIA_BUCKET: mediaBucket.bucketName,
        VAPID_PUBLIC_KEY: vapidPublicKey,
        VAPID_PRIVATE_KEY_PARAM: PARAM.vapidPrivateKey,
        VAPID_SUBJECT,
        ADMIN_TOKEN_PARAM: PARAM.adminToken,
        ORIGIN_VERIFY: originVerify,
      },
    });
    table.grantReadWriteData(apiFn);
    apiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [mediaBucket.arnForObjects("*")],
      }),
    );
    for (const st of readSecureParams([PARAM.vapidPrivateKey, PARAM.adminToken])) apiFn.addToRolePolicy(st);

    const reminderFn = new lambda.Function(this, "ReminderFunction", {
      description: "thirty-days reminder (Web Push)",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: lambda.Code.fromAsset(reminderDistPath),
      handler: "index.handler",
      memorySize: 256,
      timeout: Duration.seconds(60),
      // A retried run would push the same reminder twice; the next slot is 15 minutes away anyway.
      retryAttempts: 0,
      logGroup: logGroup("ReminderLogs"),
      environment: {
        TABLE_NAME: table.tableName,
        VAPID_PUBLIC_KEY: vapidPublicKey,
        VAPID_PRIVATE_KEY_PARAM: PARAM.vapidPrivateKey,
        VAPID_SUBJECT,
      },
    });
    table.grantReadWriteData(reminderFn);
    for (const st of readSecureParams([PARAM.vapidPrivateKey])) reminderFn.addToRolePolicy(st);

    new events.Rule(this, "ReminderSchedule", {
      description: "thirty-days: send reminders every 15 minutes",
      schedule: events.Schedule.expression("cron(0/15 * * * ? *)"),
      targets: [new targets.LambdaFunction(reminderFn)],
    });

    // ---- HTTP API --------------------------------------------------------------------------
    const httpApi = new apigw.HttpApi(this, "HttpApi", {
      description: "thirty-days API (CloudFront only, checked with x-origin-verify)",
      createDefaultStage: false,
    });
    httpApi.addStage("DefaultStage", {
      stageName: "$default",
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
    });
    const integration = new HttpLambdaIntegration("ApiIntegration", apiFn);
    for (const routePath of ["/api/{proxy+}", "/s/{proxy+}"]) {
      httpApi.addRoutes({ path: routePath, methods: [apigw.HttpMethod.ANY], integration });
    }

    // ---- CloudFront ------------------------------------------------------------------------
    const securityHeaders = (csp: string): cloudfront.ResponseSecurityHeadersBehavior => ({
      contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
      strictTransportSecurity: {
        accessControlMaxAge: Duration.seconds(HSTS_MAX_AGE_SECONDS),
        includeSubdomains: true,
        override: true,
      },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
    });
    const headersPolicy = (policyId: string, comment: string, csp: string) =>
      new cloudfront.ResponseHeadersPolicy(this, policyId, {
        comment,
        securityHeadersBehavior: securityHeaders(csp),
        customHeadersBehavior: {
          customHeaders: [{ header: "Permissions-Policy", value: PERMISSIONS_POLICY, override: true }],
        },
      });
    const siteHeaders = headersPolicy("SiteHeaders", "thirty-days: SPA", SITE_CSP);
    const shareHeaders = headersPolicy("ShareHeaders", "thirty-days: /s/* share pages", SHARE_PAGE_CSP);
    const apiHeaders = headersPolicy("ApiHeaders", "thirty-days: /api/*", API_CSP);

    const viewerRequest = (fnId: string, functionName: string, code: string): cloudfront.FunctionAssociation[] => [
      {
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        function: new cloudfront.Function(this, fnId, {
          // Function names are account-wide per region; prefix with the stack name to avoid clashes.
          functionName: `${this.stackName}-${functionName}`,
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(code),
        }),
      },
    ];

    const apiOrigin = new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      customHeaders: { "x-origin-verify": originVerify },
    });
    const forwardHost = viewerRequest("ForwardHostFunction", "forward-host", FORWARD_HOST_CODE);
    const apiBehavior = (responseHeadersPolicy: cloudfront.IResponseHeadersPolicy): cloudfront.BehaviorOptions => ({
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy,
      functionAssociations: forwardHost,
      compress: true,
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "thirty-days",
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: siteHeaders,
        functionAssociations: viewerRequest("SpaRewriteFunction", "spa-rewrite", SPA_REWRITE_CODE),
        compress: true,
      },
      additionalBehaviors: {
        "/api/*": apiBehavior(apiHeaders),
        "/s/*": apiBehavior(shareHeaders),
        "/media/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(mediaBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: siteHeaders,
          functionAssociations: viewerRequest("MediaPathFunction", "media-path", MEDIA_PATH_CODE),
          compress: true,
        },
      },
    });

    // ---- Web deployment --------------------------------------------------------------------
    // Three syncs of the same asset with disjoint filters, so each prune only touches its own files.
    // Hashed bundles are never pruned: a tab still running the previous build may lazy-load them.
    const deployLogs = logGroup("WebDeployLogs");
    const webSource = [s3deploy.Source.asset(webDistPath)];
    const deploy = (deployId: string, opts: Partial<s3deploy.BucketDeploymentProps>) =>
      new s3deploy.BucketDeployment(this, deployId, {
        sources: webSource,
        destinationBucket: webBucket,
        memoryLimit: 512,
        logGroup: deployLogs,
        ...opts,
      });
    const hashed = deploy("DeployHashedAssets", {
      exclude: ["*"],
      include: ["assets/*"],
      prune: false,
      cacheControl: [s3deploy.CacheControl.fromString(CACHE_CONTROL.immutable)],
    });
    const staticFiles = deploy("DeployStaticFiles", {
      exclude: ["assets/*", ...NO_CACHE_FILES],
      cacheControl: [s3deploy.CacheControl.fromString(CACHE_CONTROL.static)],
    });
    const entryFiles = deploy("DeployEntryFiles", {
      exclude: ["*"],
      include: [...NO_CACHE_FILES],
      cacheControl: [s3deploy.CacheControl.fromString(CACHE_CONTROL.noCache)],
      distribution,
      distributionPaths: ["/*"],
    });
    // index.html last: it must never point at bundles that are not uploaded yet.
    staticFiles.node.addDependency(hashed);
    entryFiles.node.addDependency(staticFiles);

    if (props.alertEmail) {
      new CostGuard(this, "CostGuard", {
        alertEmail: props.alertEmail,
        monthlyBudgetUsd: MONTHLY_BUDGET_USD,
        apiFunction: apiFn,
      });
    }

    new CfnOutput(this, "SiteUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "MediaBucketName", { value: mediaBucket.bucketName });
    new CfnOutput(this, "ApiFunctionName", { value: apiFn.functionName });
  }
}
