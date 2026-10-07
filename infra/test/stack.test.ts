import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { TABLE } from "../../apps/api/src/db/table";
import { CACHE_CONTROL, HTTP_API_NAME, NO_CACHE_FILES, PARAM, STACK_DESCRIPTION, TABLE_KEYS } from "../lib/config";
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

/** Evaluates a CloudFront Function body (plain ES5) in Node. */
function edgeHandler(code: string): (event: unknown) => { uri: string; headers: Record<string, { value: string }> } {
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
    expect(env.ORIGIN_VERIFY).toEqual({ Ref: expect.stringMatching(/^SsmParameterValue/) });
    expect(env.VAPID_PUBLIC_KEY).toEqual({ Ref: expect.stringMatching(/^SsmParameterValue/) });

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

  it("sends the origin-verify header to the API origin, from SSM", () => {
    const apiOrigin = dist.Origins.find((o) => o.OriginCustomHeaders?.some((h) => h.HeaderName === "x-origin-verify"));
    expect(apiOrigin).toBeDefined();
    expect(JSON.stringify(apiOrigin?.DomainName)).toContain(".execute-api.ap-northeast-1.amazonaws.com");
    const header = apiOrigin?.OriginCustomHeaders?.find((h) => h.HeaderName === "x-origin-verify");
    expect(header?.HeaderValue).toEqual({ Ref: expect.stringMatching(/^SsmParameterValue/) });
    const params = template.toJSON().Parameters as Record<string, { Type: string; Default: string }>;
    expect(Object.values(params).map((p) => p.Default)).toEqual(
      expect.arrayContaining([PARAM.originVerify, PARAM.vapidPublicKey]),
    );
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
    expect(req.headers["x-forwarded-host"]).toEqual({ value: "d111.cloudfront.net" });
    expect(req.headers["x-viewer-ip"]).toEqual({ value: "203.0.113.7" });
  });

  it("media-path strips /media so the bucket key is share/<id>.png", () => {
    const run = (uri: string) => edgeHandler(MEDIA_PATH_CODE)({ request: { uri, headers: {} } }).uri;
    expect(run("/media/share/abc.png")).toBe("/share/abc.png");
  });
});

describe("cost guard", () => {
  it("creates nothing without alertEmail", () => {
    template.resourceCountIs("AWS::Budgets::Budget", 0);
    template.resourceCountIs("AWS::SNS::Topic", 0);
    template.resourceCountIs("AWS::CloudWatch::Alarm", 0);
  });

  it("creates a $10 budget, a mail topic and an error alarm with alertEmail", () => {
    const t = synth({ alertEmail: "owner@example.com" });
    t.resourceCountIs("AWS::Budgets::Budget", 1);
    t.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: { BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: { Amount: 10, Unit: "USD" } },
      NotificationsWithSubscribers: [
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "ACTUAL", Threshold: 80 }) }),
        Match.objectLike({ Notification: Match.objectLike({ NotificationType: "FORECASTED", Threshold: 100 }) }),
      ],
    });
    t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "email", Endpoint: "owner@example.com" });
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "Errors",
      Namespace: "AWS/Lambda",
      Period: 300,
      Threshold: 5,
      ComparisonOperator: "GreaterThanOrEqualToThreshold",
    });
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

  it("scripts/setup-secrets.mjs creates the parameters the stack reads", () => {
    const script = readFileSync(path.join(here, "../../scripts/setup-secrets.mjs"), "utf8");
    for (const name of Object.values(PARAM)) expect(script).toContain(name);
  });
});
