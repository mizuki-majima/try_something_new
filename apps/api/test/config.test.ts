import type { GetParameterCommand } from "@aws-sdk/client-ssm";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(loadConfig({ ORIGIN_VERIFY: "  ", MEDIA_BUCKET: "" }).originVerify).toBeUndefined();
    expect(() => loadConfig({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });
});

describe("loadSecrets", () => {
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

  it("falls back to the built-in IP hash key when none is configured or its parameter is missing", async () => {
    expect(await loadSecrets(loadConfig({}), fakeSsm({}) as never)).toEqual({
      adminToken: undefined,
      vapidPrivateKey: undefined,
      ipHashKey: DEFAULT_IP_HASH_KEY,
    });
    resetSecretsCache();
    // A deploy before scripts/setup-secrets.mjs created the parameter must not take the API down.
    expect((await loadSecrets(loadConfig({ IP_HASH_KEY_PARAM: "/thirty/ip" }), fakeSsm({}) as never)).ipHashKey).toBe(DEFAULT_IP_HASH_KEY);
    resetSecretsCache();
    // Any other SSM failure still fails (and is retried on the next request).
    await expect(loadSecrets(loadConfig({ IP_HASH_KEY_PARAM: "/thirty/ip" }), fakeSsm({}, true) as never)).rejects.toThrow("ssm down");
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
