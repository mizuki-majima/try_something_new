import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipHashSecret } from "../src/auth";
import { createDynamoClient, DYNAMO_MAX_ATTEMPTS } from "../src/db/client";
import { DEFAULT_IP_HASH_KEY, loadConfig, loadSecrets, resetSecretsCache } from "../src/config";
import { log, setLogLevel } from "../src/log";

describe("loadConfig", () => {
  it("has safe defaults", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ region: "ap-northeast-1", logLevel: "info", vapidSubject: expect.stringMatching(/^https:\/\//) });
    expect(c.originVerify).toBeUndefined();
    expect(c.adminToken).toBeUndefined();
  });

  it("treats empty values as unset and rejects unknown log levels", () => {
    expect(loadConfig({ MEDIA_BUCKET: "", ADMIN_TOKEN: "  " })).toMatchObject({ mediaBucket: undefined, adminToken: undefined });
    expect(() => loadConfig({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });

  it("keeps ORIGIN_VERIFY when it is set but blank, so the check fails closed instead of turning off (NF-6)", () => {
    expect(loadConfig({ ORIGIN_VERIFY: "  " }).originVerify).toBe("  ");
    expect(loadConfig({ ORIGIN_VERIFY: "" }).originVerify).toBe("");
    expect(loadConfig({}).originVerify).toBeUndefined();
  });
});

describe("loadSecrets", () => {
  beforeEach(() => setLogLevel("silent")); // the fail-closed paths log an error on purpose
  afterEach(() => resetSecretsCache());

  const fakeSsm = (values: Record<string, string>, fail = false) => {
    const calls: { Name?: string; WithDecryption?: boolean }[] = [];
    return {
      calls,
      send: vi.fn(async (cmd: GetParameterCommand) => {
        calls.push(cmd.input);
        if (fail) throw new Error("ssm down");
        const value = values[cmd.input.Name ?? ""];
        if (value === undefined) throw Object.assign(new Error("not found"), { name: "ParameterNotFound" });
        return { Parameter: { Value: value } };
      }),
    };
  };

  it("reads SecureStrings with decryption, once per cold start", async () => {
    const ssm = fakeSsm({ "/thirty/admin": "adm", "/thirty/vapid": "vap", "/thirty/ip": "ip-secret" });
    const config = loadConfig({ ADMIN_TOKEN_PARAM: "/thirty/admin", VAPID_PRIVATE_KEY_PARAM: "/thirty/vapid", IP_HASH_KEY_PARAM: "/thirty/ip" });
    expect(await loadSecrets(config, ssm as never)).toEqual({ adminToken: "adm", vapidPrivateKey: "vap", ipHashKey: "ip-secret" });
    await loadSecrets(config, ssm as never);
    expect(ssm.calls).toHaveLength(3);
    expect(ssm.calls.every((c) => c.WithDecryption === true)).toBe(true);
  });

  it("prefers values from the environment and does not cache failures", async () => {
    const config = loadConfig({ ADMIN_TOKEN: "env-admin", VAPID_PRIVATE_KEY_PARAM: "/thirty/vapid", IP_HASH_KEY: "env-ip", IP_HASH_KEY_PARAM: "/thirty/ip" });
    await expect(loadSecrets(config, fakeSsm({}, true) as never)).rejects.toThrow("ssm down");
    const ok = fakeSsm({ "/thirty/vapid": "vap" });
    expect(await loadSecrets(config, ok as never)).toEqual({ adminToken: "env-admin", vapidPrivateKey: "vap", ipHashKey: "env-ip" });
    expect(ok.calls.map((c) => c.Name)).toEqual(["/thirty/vapid"]);
  });

  it("never falls back to the public built-in IP hash key: a missing or empty parameter fails closed (NF-4)", async () => {
    // Nothing configured (the reminder Lambda): no key, and no built-in one either.
    expect(await loadSecrets(loadConfig({}), fakeSsm({}) as never)).toEqual({
      adminToken: undefined,
      vapidPrivateKey: undefined,
      ipHashKey: undefined,
    });
    resetSecretsCache();
    // On AWS (IP_HASH_KEY_PARAM set) a missing parameter fails the cold start: 500 + ApiErrors alarm.
    const config = loadConfig({ IP_HASH_KEY_PARAM: "/thirty/ip" });
    await expect(loadSecrets(config, fakeSsm({}) as never)).rejects.toMatchObject({ name: "ParameterNotFound" });
    // An empty value too.
    const empty = { send: vi.fn(async () => ({ Parameter: { Value: "" } })) };
    await expect(loadSecrets(config, empty as never)).rejects.toThrow(/empty/);
    // Any other SSM failure still fails (and is retried on the next request).
    await expect(loadSecrets(config, fakeSsm({}, true) as never)).rejects.toThrow("ssm down");
    // Not cached: once the parameter exists, the next request starts normally.
    expect((await loadSecrets(config, fakeSsm({ "/thirty/ip": "ip-secret" }) as never)).ipHashKey).toBe("ip-secret");
    expect((await loadSecrets(config, fakeSsm({}) as never)).ipHashKey).toBe("ip-secret");
  });

  it("hashes IPs with the built-in key only under tests (NODE_ENV=test) or when local.ts passes it", () => {
    const deps = { secrets: {}, config: loadConfig({}) };
    expect(ipHashSecret(deps)).toBe(DEFAULT_IP_HASH_KEY); // vitest: NODE_ENV=test
    expect(ipHashSecret({ secrets: { ipHashKey: "from-ssm" }, config: loadConfig({}) })).toBe("from-ssm");
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => ipHashSecret(deps)).toThrow(/IP hash key is not configured/);
      expect(ipHashSecret({ secrets: { ipHashKey: DEFAULT_IP_HASH_KEY }, config: loadConfig({}) })).toBe(DEFAULT_IP_HASH_KEY);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("DynamoDB client", () => {
  it("retries throttling a few more times on AWS, where the table's throughput is capped (R1)", async () => {
    const aws = createDynamoClient({ region: "ap-northeast-1" });
    expect(await aws.config.maxAttempts()).toBe(DYNAMO_MAX_ATTEMPTS);
    expect(DYNAMO_MAX_ATTEMPTS).toBeGreaterThan(3); // the SDK default
    aws.destroy();
  });
});

describe("log", () => {
  it("drops sensitive fields and shortens user ids", () => {
    const lines: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    setLogLevel("info");
    try {
      log.info("x", { uid: "abcdefghijklmnop", token: "secret-token", note: "private", endpoint: "https://push", ip: "1.2.3.4", route: "/api/me" });
    } finally {
      setLogLevel("silent");
      out.mockRestore();
    }
    const entry = JSON.parse(lines[0] ?? "{}");
    expect(entry).toMatchObject({ level: "info", msg: "x", uid: "abcdef", route: "/api/me" });
    expect(lines[0]).not.toMatch(/secret-token|private|https:\/\/push|1\.2\.3\.4|ghijklmnop/);
  });
});
