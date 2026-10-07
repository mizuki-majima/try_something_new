import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { TABLE } from "../../apps/api/src/db/table";
import {
  CACHE_CONTROL,
  COST_ALLOCATION_TAG,
  HTTP_API_NAME,
  NO_CACHE_FILES,
  PARAM,
  STACK_DESCRIPTION,
  TABLE_KEYS,
} from "../lib/config";
import { FORWARD_HOST_CODE, MEDIA_PATH_CODE, SHARE_PAGE_CSP, SITE_CSP, SPA_REWRITE_CODE } from "../lib/edge";
import { ThirtyDaysStack, type ThirtyDaysStackProps } from "../lib/thirty-days-stack";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(here, "fixtures", name);
/** Same feature flags as `cdk synth`. */
const cdkContext = (JSON.parse(readFileSync(path.join(here, "../cdk.json"), "utf8")) as { context: Record<string, unknown> })
  .context;

function synth(props: Partial<ThirtyDaysStackProps> = {}): Template {
  const app = new App({ context: cdkContext });
  const stack = new ThirtyDaysStack(app, "ThirtyDays", {
    env: { account: "123456789012", region: "ap-northeast-1" },
    webDistPath: fixture("web"),
    apiDistPath: fixture("api"),
    reminderDistPath: fixture("reminder"),
    ...props,
  });
  return Template.fromStack(stack);
}

const template = synth();

type Resource = { Type: string; Properties?: Record<string, unknown> };
const resourcesOf = (t: Template, type: string) => Object.values(t.findResources(type)) as Resource[];

/** Our two Lambdas (not the BucketDeployment singleton). */
function appFunctions(t: Template): Resource[] {
  return resourcesOf(t, "AWS::Lambda::Function").filter((r) => {
    const env = r.Properties?.Environment as { Variables?: Record<string, unknown> } | undefined;
    return env?.Variables?.TABLE_NAME !== undefined;
  });
}

function envOf(fn: Resource): Record<string, unknown> {
  return (fn.Properties?.Environment as { Variables: Record<string, unknown> }).Variables;
}

/** The SSM parameter name behind a `{ Ref: SsmParameterValue… }` (a CloudFormation parameter's Default). */
function ssmNameOf(t: Template, value: unknown): string | undefined {
  const ref = (value as { Ref?: string } | undefined)?.Ref;
  const params = t.toJSON().Parameters as Record<string, { Type: string; Default: string }>;
  const p = ref ? params[ref] : undefined;
  return p?.Type === "AWS::SSM::Parameter::Value<String>" ? p.Default : undefined;
}

const logicalIdOf = (t: Template, type: string, match: (r: Resource) => boolean): string | undefined =>
  Object.entries(t.findResources(type)).find(([, r]) => match(r as Resource))?.[0];

type EdgeResult = {
  uri?: string;
  headers?: Record<string, { value: string }>;
  statusCode?: number;
};

/** Evaluates a CloudFront Function body (plain ES5) in Node. */
function edgeHandler(code: string): (event: unknown) => EdgeResult {
  return new Function(`${code}\nreturn handler;`)() as ReturnType<typeof edgeHandler>;
}

describe("DynamoDB table", () => {
  it("matches the API's table definition (keys, GSIs, TTL)", () => {
    expect(TABLE_KEYS).toEqual(TABLE);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      DeletionProtectionEnabled: true,
      GlobalSecondaryIndexes: [1, 2, 3].map((n) => ({
        IndexName: `gsi${n}`,
        KeySchema: [
          { AttributeName: `gsi${n}pk`, KeyType: "HASH" },
          { AttributeName: `gsi${n}sk`, KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      })),
    });
    const [table] = Object.values(template.findResources("AWS::DynamoDB::Table")) as Array<
      Resource & { DeletionPolicy?: string; Properties: { AttributeDefinitions: Array<{ AttributeType: string }> } }
    >;
    expect(table?.DeletionPolicy).toBe("Retain");
    expect(table?.Properties.AttributeDefinitions).toHaveLength(8);
    expect(table?.Properties.AttributeDefinitions.every((a) => a.AttributeType === "S")).toBe(true);
  });

  it("is tagged Project=thirty-days", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      Tags: Match.arrayWith([{ Key: "Project", Value: "thirty-days" }]),
    });
  });
});

describe("S3 buckets", () => {
  it("are private, SSL-only and encrypted", () => {
    const buckets = resourcesOf(template, "AWS::S3::Bucket");
    expect(buckets).toHaveLength(2);
    for (const b of buckets) {
      expect(b.Properties?.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(b.Properties?.WebsiteConfiguration).toBeUndefined();
      expect(JSON.stringify(b.Properties?.BucketEncryption)).toContain("AES256");
    }
    const policies = JSON.stringify(template.findResources("AWS::S3::BucketPolicy"));
    expect(policies).toContain('"aws:SecureTransport":"false"');
  });

  it("deploys the web build with per-file Cache-Control and disjoint prune scopes", () => {
    const deployments = resourcesOf(template, "Custom::CDKBucketDeployment").map((r) => r.Properties ?? {});
    expect(deployments).toHaveLength(3);
    const byCache = (value: string) =>
      deployments.find((d) => (d.SystemMetadata as Record<string, string> | undefined)?.["cache-control"] === value);

    const hashed = byCache(CACHE_CONTROL.immutable);
    expect(hashed).toMatchObject({ Exclude: ["*"], Include: ["assets/*"], Prune: false });

    const entry = byCache(CACHE_CONTROL.noCache);
    expect(entry).toMatchObject({ Exclude: ["*"], Include: [...NO_CACHE_FILES], DistributionPaths: ["/*"] });
    expect(entry?.Prune).not.toBe(false);

    const rest = byCache(CACHE_CONTROL.static);
    expect(rest?.Exclude).toEqual(["assets/*", ...NO_CACHE_FILES]);
    expect(rest?.Include).toBeUndefined();
  });
});

describe("Lambdas", () => {
  it("api and reminder run Node.js 22 on arm64 with the expected sizes", () => {
    const fns = appFunctions(template);
    expect(fns).toHaveLength(2);
    for (const fn of fns) {
      expect(fn.Properties).toMatchObject({ Runtime: "nodejs22.x", Architectures: ["arm64"] });
      expect(fn.Properties?.ReservedConcurrentExecutions).toBeUndefined();
    }
    expect(fns.map((f) => [f.Properties?.MemorySize, f.Properties?.Timeout]).sort()).toEqual([
      [256, 60],
      [512, 30],
    ]);
  });

  it("api gets its configuration by reference (no secret values in the template)", () => {
    const api = appFunctions(template).find((f) => f.Properties?.MemorySize === 512);
    const env = envOf(api!);
    expect(Object.keys(env).sort()).toEqual(
      [
        "ADMIN_TOKEN_PARAM",
        "IP_HASH_KEY_PARAM",
        "MEDIA_BUCKET",
        "ORIGIN_VERIFY",
        "TABLE_NAME",
        "VAPID_PRIVATE_KEY_PARAM",
        "VAPID_PUBLIC_KEY",
        "VAPID_SUBJECT",
      ].sort(),
    );
    expect(env.VAPID_PRIVATE_KEY_PARAM).toBe(PARAM.vapidPrivateKey);
    expect(env.ADMIN_TOKEN_PARAM).toBe(PARAM.adminToken);
    // D6: the HMAC key for client IPs is a SecureString read at cold start, never in the template.
    expect(env.IP_HASH_KEY_PARAM).toBe(PARAM.ipHashKey);
    // D8: the API's accept list (comma-separated while rotating), not the value CloudFront sends.
    expect(ssmNameOf(template, env.ORIGIN_VERIFY)).toBe(PARAM.originVerify);
    expect(ssmNameOf(template, env.VAPID_PUBLIC_KEY)).toBe(PARAM.vapidPublicKey);

    const reminder = appFunctions(template).find((f) => f.Properties?.MemorySize === 256);
    expect(Object.keys(envOf(reminder!)).sort()).toEqual(
      ["TABLE_NAME", "VAPID_PRIVATE_KEY_PARAM", "VAPID_PUBLIC_KEY", "VAPID_SUBJECT"].sort(),
    );
  });

  it("reads the SecureStrings through SSM only, and has no Bedrock access (ADR 0003)", () => {
    const policies = JSON.stringify(template.findResources("AWS::IAM::Policy"));
    expect(policies).toContain("parameter/thirty-days/vapid-private-key");
    expect(policies).toContain("parameter/thirty-days/admin-token");
    expect(policies).toContain('"kms:ViaService":"ssm.ap-northeast-1.amazonaws.com"');
    expect(policies).not.toMatch(/bedrock/i);
    expect(policies).not.toContain('"ssm:*"');
  });

  it("only the api may read the IP hash key (ssm:GetParameter + KMS decrypt via SSM)", () => {
    const policyOf = (fnMemory: number) => {
      const fn = logicalIdOf(template, "AWS::Lambda::Function", (r) => r.Properties?.MemorySize === fnMemory);
      const role = (template.findResources("AWS::Lambda::Function")[fn!] as Resource).Properties?.Role as {
        "Fn::GetAtt": [string, string];
      };
      const policy = Object.values(template.findResources("AWS::IAM::Policy")).find((p) =>
        JSON.stringify((p as Resource).Properties?.Roles).includes(role["Fn::GetAtt"][0]),
      ) as Resource;
      return policy.Properties?.PolicyDocument as { Statement: Array<{ Action: string | string[]; Resource: unknown; Condition?: unknown }> };
    };
    const api = policyOf(512);
    const getParam = api.Statement.find((s) => s.Action === "ssm:GetParameter");
    const resources = JSON.stringify(getParam?.Resource);
    for (const name of [PARAM.vapidPrivateKey, PARAM.adminToken, PARAM.ipHashKey]) {
      expect(resources).toContain(`parameter${name}`);
    }
    expect(api.Statement.find((s) => s.Action === "kms:Decrypt")?.Condition).toEqual({
      StringEquals: { "kms:ViaService": "ssm.ap-northeast-1.amazonaws.com" },
    });
    expect(JSON.stringify(policyOf(256))).not.toContain("ip-hash-key");

    // D2 moves card images with CopyObject; a missing source must be a 404 (needs ListBucket), not a 403.
    const s3 = (action: string) => api.Statement.find((s) => ([] as string[]).concat(s.Action).includes(action));
    expect(s3("s3:ListBucket")?.Resource).toEqual({ "Fn::GetAtt": [expect.stringMatching(/^MediaBucket/), "Arn"] });
    expect(JSON.stringify(s3("s3:GetObject")?.Resource)).toContain("MediaBucket");
    for (const action of ["s3:PutObject", "s3:DeleteObject"]) expect(s3(action)).toBe(s3("s3:GetObject"));
    expect(JSON.stringify(policyOf(256))).not.toContain("s3:");
  });

  it("logs are kept for 14 days", () => {
    const groups = resourcesOf(template, "AWS::Logs::LogGroup");
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) expect(g.Properties?.RetentionInDays).toBe(14);
  });

  it("reminder runs every 15 minutes", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "cron(0/15 * * * ? *)",
      State: "ENABLED",
    });
  });

  it("drops reminder events older than one slot, without retries (D9)", () => {
    template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 1);
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 0,
      MaximumEventAgeInSeconds: 900,
      Qualifier: "$LATEST",
    });
    template.hasResourceProperties("AWS::Events::Rule", {
      Targets: [Match.objectLike({ RetryPolicy: { MaximumEventAgeInSeconds: 900 } })],
    });
  });
});

describe("names (the AWS account is shared with other projects)", () => {
  it("describes the stack as 30日だけ", () => {
    expect(STACK_DESCRIPTION).toBe("30日だけ (try_something_new)");
    expect(template.toJSON().Description).toBe(STACK_DESCRIPTION);
    // An explicit description still wins.
    expect(synth({ description: "other" }).toJSON().Description).toBe("other");
  });

  it("names the HTTP API ThirtyDaysApi, keeping its logical id (no replacement on deploy)", () => {
    expect(HTTP_API_NAME).toBe("ThirtyDaysApi");
    const apis = template.findResources("AWS::ApiGatewayV2::Api");
    expect(Object.values(apis).map((r) => (r as Resource).Properties?.Name)).toEqual(["ThirtyDaysApi"]);
    expect(Object.keys(apis)).toHaveLength(1);
    expect(Object.keys(apis)[0]).toMatch(/^HttpApi[0-9A-F]{8}$/);
  });
});

describe("HTTP API", () => {
  it("routes /api/* and /s/* to the api Lambda with stage throttling", () => {
    const routeKeys = resourcesOf(template, "AWS::ApiGatewayV2::Route").map((r) => r.Properties?.RouteKey);
    expect(routeKeys.sort()).toEqual(["ANY /api/{proxy+}", "ANY /s/{proxy+}"]);
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "$default",
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 },
    });
  });
});

describe("CloudFront", () => {
  type Behavior = {
    PathPattern: string;
    CachePolicyId: string;
    OriginRequestPolicyId?: string;
    AllowedMethods?: string[];
    FunctionAssociations?: Array<{ EventType: string; FunctionARN: unknown }>;
    ResponseHeadersPolicyId?: unknown;
    TargetOriginId: string;
  };
  type DistConfig = {
    DefaultCacheBehavior: Omit<Behavior, "PathPattern">;
    CacheBehaviors: Behavior[];
    Origins: Array<{ Id: string; DomainName: unknown; OriginCustomHeaders?: Array<{ HeaderName: string; HeaderValue: unknown }> }>;
    PriceClass: string;
    HttpVersion: string;
    DefaultRootObject: string;
  };
  const dist = (resourcesOf(template, "AWS::CloudFront::Distribution")[0]?.Properties?.DistributionConfig ?? {}) as DistConfig;
  const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
  const CACHING_OPTIMIZED = "658327ea-f89d-4fab-a63d-7e88639e58f6";
  const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

  it("has the SPA default and the three extra behaviors", () => {
    expect(dist.PriceClass).toBe("PriceClass_200");
    expect(dist.HttpVersion).toBe("http2and3");
    expect(dist.DefaultRootObject).toBe("index.html");
    expect(dist.DefaultCacheBehavior.CachePolicyId).toBe(CACHING_OPTIMIZED);
    expect(dist.CacheBehaviors.map((b) => b.PathPattern).sort()).toEqual(["/api/*", "/media/*", "/s/*"]);

    for (const p of ["/api/*", "/s/*"]) {
      const b = dist.CacheBehaviors.find((x) => x.PathPattern === p)!;
      expect(b.CachePolicyId).toBe(CACHING_DISABLED);
      expect(b.OriginRequestPolicyId).toBe(ALL_VIEWER_EXCEPT_HOST);
      expect(b.AllowedMethods).toHaveLength(7);
      expect(b.FunctionAssociations).toHaveLength(1);
    }
    expect(dist.CacheBehaviors.find((x) => x.PathPattern === "/media/*")?.CachePolicyId).toBe(CACHING_OPTIMIZED);
  });

  it("sends the origin-verify header to the API origin, from its own SSM parameter (D8)", () => {
    const apiOrigin = dist.Origins.find((o) => o.OriginCustomHeaders?.some((h) => h.HeaderName === "x-origin-verify"));
    expect(apiOrigin).toBeDefined();
    expect(JSON.stringify(apiOrigin?.DomainName)).toContain(".execute-api.ap-northeast-1.amazonaws.com");
    const header = apiOrigin?.OriginCustomHeaders?.find((h) => h.HeaderName === "x-origin-verify");
    // CloudFront sends one value; the API accepts a list. Separate parameters make a rotation possible.
    expect(ssmNameOf(template, header?.HeaderValue)).toBe(PARAM.originVerifySend);
    const params = template.toJSON().Parameters as Record<string, { Type: string; Default: string }>;
    expect(Object.values(params).map((p) => p.Default)).toEqual(
      expect.arrayContaining([PARAM.originVerify, PARAM.originVerifySend, PARAM.vapidPublicKey]),
    );
    // Nothing secret is resolved into the template: SecureStrings are only named.
    for (const name of [PARAM.vapidPrivateKey, PARAM.adminToken, PARAM.ipHashKey]) {
      expect(Object.values(params).map((p) => p.Default)).not.toContain(name);
    }
  });

  it("updates the api Lambda before the distribution (a rotation never sends a value the API refuses)", () => {
    const apiFnId = logicalIdOf(template, "AWS::Lambda::Function", (r) => r.Properties?.MemorySize === 512);
    const [distribution] = Object.values(template.findResources("AWS::CloudFront::Distribution")) as Array<{
      DependsOn?: string[];
    }>;
    expect(apiFnId).toBeDefined();
    expect(distribution?.DependsOn).toEqual(expect.arrayContaining([apiFnId]));
  });

  it("has the three viewer-request functions", () => {
    const fns = resourcesOf(template, "AWS::CloudFront::Function").map((f) => f.Properties ?? {});
    expect(fns.map((f) => f.Name).sort()).toEqual([
      "ThirtyDays-forward-host",
      "ThirtyDays-media-path",
      "ThirtyDays-spa-rewrite",
    ]);
    for (const f of fns) expect(f.FunctionConfig).toMatchObject({ Runtime: "cloudfront-js-2.0" });
  });

  it("sets the CSP and security headers", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: {
          ContentSecurityPolicy: { ContentSecurityPolicy: SITE_CSP, Override: true },
          StrictTransportSecurity: { AccessControlMaxAgeSec: 63_072_000, IncludeSubdomains: true, Override: true },
          ContentTypeOptions: { Override: true },
          FrameOptions: { FrameOption: "DENY", Override: true },
          ReferrerPolicy: { ReferrerPolicy: "strict-origin-when-cross-origin", Override: true },
        },
        CustomHeadersConfig: {
          Items: [Match.objectLike({ Header: "Permissions-Policy" })],
        },
      }),
    });
    expect(SITE_CSP).toContain("script-src 'self'");
    expect(SHARE_PAGE_CSP).not.toContain("script-src");
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: { ContentSecurityPolicy: SHARE_PAGE_CSP, Override: true },
        }),
      }),
    });
  });
});

describe("CloudFront Function code", () => {
  it("spa-rewrite sends extension-less paths to /index.html", () => {
    const run = (uri: string) => edgeHandler(SPA_REWRITE_CODE)({ request: { uri, headers: {} } }).uri;
    expect(run("/")).toBe("/index.html");
    expect(run("/recipes/abc")).toBe("/index.html");
    expect(run("/c/123/reflect")).toBe("/index.html");
    expect(run("/assets/index-AbC123.js")).toBe("/assets/index-AbC123.js");
    expect(run("/sw.js")).toBe("/sw.js");
    expect(run("/manifest.webmanifest")).toBe("/manifest.webmanifest");
  });

  it("forward-host overwrites client-sent x-forwarded-host and x-viewer-ip", () => {
    const req = edgeHandler(FORWARD_HOST_CODE)({
      viewer: { ip: "203.0.113.7" },
      request: {
        uri: "/api/session",
        headers: {
          host: { value: "d111.cloudfront.net" },
          "x-forwarded-host": { value: "evil.example" },
          "x-viewer-ip": { value: "1.2.3.4" },
        },
      },
    });
    expect(req.headers?.["x-forwarded-host"]).toEqual({ value: "d111.cloudfront.net" });
    expect(req.headers?.["x-viewer-ip"]).toEqual({ value: "203.0.113.7" });
  });

  it("media-path serves share/<id>.png only, so hidden/share/ (moderated cards, D2) is never public", () => {
    const run = (uri: string) => edgeHandler(MEDIA_PATH_CODE)({ request: { uri, headers: {} } });
    expect(run("/media/share/abc123def456ghi7.png").uri).toBe("/share/abc123def456ghi7.png");
    for (const uri of [
      "/media/hidden/share/abc123def456ghi7.png",
      "/media/share/../hidden/share/abc123def456ghi7.png",
      "/media/share/%2E%2E/hidden/x.png",
      "/media/share/abc.jpg",
      "/media/share/",
      "/media/other.png",
      "/media/share/a/b.png",
    ]) {
      expect(run(uri), uri).toEqual({ statusCode: 404, statusDescription: "Not Found" });
    }
  });
});

describe("cost guard", () => {
  it("creates nothing without alertEmail", () => {
    template.resourceCountIs("AWS::Budgets::Budget", 0);
    template.resourceCountIs("AWS::SNS::Topic", 0);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  });

  const guarded = synth({ alertEmail: "owner@example.com" });
  const alarms = () =>
    Object.values(guarded.findResources("AWS::CloudWatch::Alarm")).map((r) => (r as Resource).Properties ?? {});

  it("creates a $10 budget for this service only (Project cost allocation tag) and a mail topic", () => {
    expect(COST_ALLOCATION_TAG).toBe("user:Project$thirty-days");
    guarded.resourceCountIs("AWS::Budgets::Budget", 1);
    guarded.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetName: "thirty-days-monthly",
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 10, Unit: "USD" },
        CostFilters: { TagKeyValue: ["user:Project$thirty-days"] },
      },
      NotificationsWithSubscribers: [
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 80 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "FORECASTED", Threshold: 100 }) }),
      ],
    });
    guarded.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "owner@example.com" });
  });

  it("alarms on API Gateway 5xx, which counts route errors the Lambda answers with 500", () => {
    const apiId = logicalIdOf(guarded, "AWS::ApiGatewayV2::Api", () => true);
    const fiveXx = alarms().find((a) => a.MetricName === "5xx");
    expect(fiveXx).toMatchObject({
      Namespace: "AWS/ApiGateway",
      Statistic: "Sum",
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 5,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
      TreatMissingData: "notBreaching",
    });
    expect(fiveXx?.Dimensions).toEqual(
      expect.arrayContaining([
        { Name: "ApiId", Value: { Ref: apiId } },
        { Name: "Stage", Value: "$default" },
      ]),
    );
  });

  it("keeps the api Lambda Errors alarm and adds one for the reminder, all mailed", () => {
    const lambdaAlarms = alarms().filter((a) => a.Namespace === "AWS/Lambda" && a.MetricName === "Errors");
    expect(lambdaAlarms.map((a) => [a.Period, a.Threshold]).sort()).toEqual([
      [300, 5],
      [3600, 2],
    ]);
    const topic = logicalIdOf(guarded, "AWS::SNS::Topic", () => true);
    expect(alarms()).toHaveLength(3);
    for (const a of alarms()) expect(a.AlarmActions).toEqual([{ Ref: topic }]);
    // The Lambda alarm kept its logical id (no replacement on deploy).
    expect(Object.keys(guarded.findResources("AWS::CloudWatch::Alarm")).some((id) => id.startsWith("CostGuardApiErrors"))).toBe(true);
  });
});

describe("outputs and secrets", () => {
  it("exports the deploy outputs", () => {
    const outputs = Object.keys(template.toJSON().Outputs ?? {});
    expect(outputs).toEqual(
      expect.arrayContaining(["SiteUrl", "DistributionId", "TableName", "MediaBucketName", "ApiFunctionName"]),
    );
  });

  it("contains no secret-looking material", () => {
    const json = JSON.stringify(template.toJSON());
    expect(json).not.toMatch(/PRIVATE KEY/);
    // Long base64/base64url runs. Asset hashes are hex; logical IDs (keys, Ref, GetAtt, DependsOn,
    // IAM PolicyName) are skipped.
    const ID_KEYS = new Set(["Ref", "DependsOn", "Fn::GetAtt", "PolicyName"]);
    const values: string[] = [];
    const walk = (node: unknown, key?: string): void => {
      if (typeof node === "string") {
        if (!ID_KEYS.has(key ?? "")) values.push(node);
      } else if (Array.isArray(node)) {
        for (const item of node) walk(item, key === "Fn::GetAtt" || key === "DependsOn" ? key : undefined);
      } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) walk(v, k);
      }
    };
    walk(template.toJSON().Resources);
    walk(template.toJSON().Outputs);
    const suspicious = values
      .flatMap((v) => v.match(/[A-Za-z0-9+/_-]{64,}={0,2}/g) ?? [])
      .filter((m) => !/^[0-9a-f]{64}$/.test(m.replace(/\.zip$/, "")));
    expect(suspicious).toEqual([]);
  });

  it("scripts/setup-secrets.mjs creates the parameters the stack reads, with the right types", async () => {
    const secrets = await setupSecrets();
    expect(secrets.PARAM).toEqual(PARAM);
    expect(secrets.PARAM_TYPES).toEqual({
      [PARAM.vapidPublicKey]: "String",
      [PARAM.vapidPrivateKey]: "SecureString",
      [PARAM.adminToken]: "SecureString",
      [PARAM.originVerify]: "String",
      [PARAM.originVerifySend]: "String",
      [PARAM.ipHashKey]: "SecureString",
    });
    expect(secrets.ROTATABLE).toEqual(["vapid", "admin-token", "ip-hash-key", "origin-verify"]);
  });
});

type SetupSecrets = {
  PARAM: Record<string, string>;
  PARAM_TYPES: Record<string, string>;
  ROTATABLE: string[];
  acceptList(value: string | undefined): string[];
  originVerifyState(accept: string | undefined, send: string | undefined): string;
  nextOriginVerifyStep(accept: string, send: string, newValue: string): { step: number; accept?: string; send?: string };
  checkParameters(found: Map<string, { type: string; value?: string }>): string[];
};

/** The script runs main() only when executed; importing it just gives the helpers. */
async function setupSecrets(): Promise<SetupSecrets> {
  const file = path.join(here, "../../scripts/setup-secrets.mjs");
  return (await import(file)) as SetupSecrets;
}

describe("origin-verify rotation (scripts/setup-secrets.mjs, D8)", () => {
  it("reads the accept list as comma-separated, trimmed and without duplicates", async () => {
    const { acceptList } = await setupSecrets();
    expect(acceptList("a")).toEqual(["a"]);
    expect(acceptList(" a , b ,")).toEqual(["a", "b"]);
    expect(acceptList("a,a")).toEqual(["a"]);
    expect(acceptList(undefined)).toEqual([]);
  });

  it("walks steady → step 1 → step 2 → step 3 → steady, and CloudFront always sends an accepted value", async () => {
    const { nextOriginVerifyStep, originVerifyState } = await setupSecrets();
    let accept = "old";
    let send = "old";
    const seen: number[] = [];
    // After every step (= every deploy) the value CloudFront sends is one the API accepts.
    const accepted = () => accept.split(",").includes(send);
    for (let i = 0; i < 3; i++) {
      const next = nextOriginVerifyStep(accept, send, "new");
      seen.push(next.step);
      if (next.accept !== undefined) accept = next.accept;
      if (next.send !== undefined) send = next.send;
      expect(accepted()).toBe(true);
    }
    expect(seen).toEqual([1, 2, 3]);
    expect([accept, send]).toEqual(["new", "new"]);
    expect(originVerifyState(accept, send)).toBe("steady");
  });

  it("names each state, and refuses to continue from a broken one", async () => {
    const { nextOriginVerifyStep, originVerifyState } = await setupSecrets();
    expect(originVerifyState("s", "s")).toBe("steady");
    expect(originVerifyState("s,n", "s")).toBe("step1");
    expect(originVerifyState("s,n", "n")).toBe("step2");
    expect(originVerifyState("s", "n")).toBe("broken");
    expect(originVerifyState("a,b,c", "a")).toBe("broken");
    expect(originVerifyState("s", undefined)).toBe("broken");
    expect(() => nextOriginVerifyStep("s", "n", "x")).toThrow(/想定外/);
  });

  it("a hand-written list in the other order still never drops the value being sent", async () => {
    const { nextOriginVerifyStep } = await setupSecrets();
    // "new,old" while CloudFront still sends old: read as step 2 done → keeps only "old" (safe).
    expect(nextOriginVerifyStep("new,old", "old", "x")).toEqual({ step: 3, accept: "old" });
    // "new,old" while CloudFront sends new: read as step 1 done → sends old again (accepted, safe).
    expect(nextOriginVerifyStep("new,old", "new", "x")).toEqual({ step: 2, send: "old" });
  });

  it("--check lists missing parameters, wrong types and an origin-verify CloudFront would be refused with", async () => {
    const { checkParameters, PARAM_TYPES } = await setupSecrets();
    const all = () =>
      new Map(
        Object.entries(PARAM_TYPES).map(([name, type]) => [name, { type, value: type === "String" ? "v" : undefined }]),
      );
    expect(checkParameters(all())).toEqual([]);

    const missing = all();
    missing.delete(PARAM.ipHashKey);
    missing.delete(PARAM.originVerifySend);
    expect(checkParameters(missing)).toEqual([`${PARAM.originVerifySend} がありません`, `${PARAM.ipHashKey} がありません`]);

    const wrongType = all();
    wrongType.set(PARAM.ipHashKey, { type: "String", value: "k" });
    expect(checkParameters(wrongType)).toEqual([`${PARAM.ipHashKey} は SecureString のはずですが String です`]);

    const refused = all();
    refused.set(PARAM.originVerify, { type: "String", value: "a,b" });
    refused.set(PARAM.originVerifySend, { type: "String", value: "c" });
    expect(checkParameters(refused)).toEqual([expect.stringContaining("403")]);

    const rotating = all();
    rotating.set(PARAM.originVerify, { type: "String", value: "v,w" });
    expect(checkParameters(rotating)).toEqual([]);
  });
});
