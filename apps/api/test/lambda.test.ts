/**
 * The API Lambda entry point (lambda.ts) with SSM mocked: on AWS (IP_HASH_KEY_PARAM set) a missing or
 * unreadable IP hash key fails the invocation (API Gateway 500, the ApiErrors alarm counts the Lambda
 * error) instead of running with the key that is public in this repository (NF-4).
 */
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLogLevel } from "../src/log";

const ssm = mockClient(SSMClient);

const event = {
  version: "2.0",
  routeKey: "$default",
  rawPath: "/api/health",
  rawQueryString: "",
  headers: { host: "abc.execute-api.ap-northeast-1.amazonaws.com", "x-viewer-ip": "203.0.113.1" },
  requestContext: {
    accountId: "123456789012",
    apiId: "abc",
    domainName: "abc.execute-api.ap-northeast-1.amazonaws.com",
    domainPrefix: "abc",
    http: { method: "GET", path: "/api/health", protocol: "HTTP/1.1", sourceIp: "203.0.113.1", userAgent: "test" },
    requestId: "req",
    routeKey: "$default",
    stage: "$default",
    time: "07/Oct/2026:00:00:00 +0000",
    timeEpoch: 0,
  },
  isBase64Encoded: false,
};

async function loadHandler() {
  vi.resetModules();
  const mod = await import("../src/lambda");
  setLogLevel("silent");
  return mod.handler as unknown as (e: typeof event) => Promise<{ statusCode: number }>;
}

describe("lambda handler: IP hash key", () => {
  beforeEach(() => {
    ssm.reset();
    vi.stubEnv("TABLE_NAME", "thirty-days-test");
    vi.stubEnv("AWS_REGION", "ap-northeast-1");
    vi.stubEnv("LOG_LEVEL", "silent");
    vi.stubEnv("ADMIN_TOKEN", "admin-from-env");
    vi.stubEnv("IP_HASH_KEY_PARAM", "/thirty-days/ip-hash-key");
    vi.stubEnv("ORIGIN_VERIFY", undefined);
    vi.stubEnv("IP_HASH_KEY", undefined);
    vi.stubEnv("VAPID_PRIVATE_KEY_PARAM", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => ssm.restore());

  it("fails the invocation while the parameter is missing, and starts once it exists", async () => {
    ssm.on(GetParameterCommand).rejects(Object.assign(new Error("Parameter not found"), { name: "ParameterNotFound" }));
    const handler = await loadHandler();
    await expect(handler(event)).rejects.toMatchObject({ name: "ParameterNotFound" });
    // Not cached: the same warm container recovers on the next request once the parameter is there.
    ssm.reset();
    ssm.on(GetParameterCommand, { Name: "/thirty-days/ip-hash-key" }).resolves({ Parameter: { Value: "a-real-secret" } });
    expect((await handler(event)).statusCode).toBe(200);
  });

  it("fails the invocation when the parameter is empty or cannot be read", async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: "" } });
    await expect((await loadHandler())(event)).rejects.toThrow(/empty/);
    ssm.reset();
    ssm.on(GetParameterCommand).rejects(Object.assign(new Error("not authorized"), { name: "AccessDeniedException" }));
    await expect((await loadHandler())(event)).rejects.toMatchObject({ name: "AccessDeniedException" });
  });
});
