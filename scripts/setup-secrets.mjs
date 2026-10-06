#!/usr/bin/env node
/**
 * One-time setup of the SSM parameters the stack reads (docs/deploy.md).
 * Creates whatever is missing and never overwrites, unless asked with --rotate <name>.
 *
 *   node scripts/setup-secrets.mjs
 *   node scripts/setup-secrets.mjs --rotate admin-token     (vapid | admin-token | origin-verify)
 *
 * Region: AWS_REGION, else ap-northeast-1 (the stack's region).
 * The only secret ever printed is a newly created admin token, once.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { GetParametersCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import webpush from "web-push";

// Keep in sync with infra/lib/config.ts (a unit test checks the names).
const PARAM = {
  vapidPublicKey: "/thirty-days/vapid-public-key",
  vapidPrivateKey: "/thirty-days/vapid-private-key",
  adminToken: "/thirty-days/admin-token",
  originVerify: "/thirty-days/origin-verify",
};
const STACK_REGION = "ap-northeast-1";
const ROTATABLE = ["vapid", "admin-token", "origin-verify"];

const USAGE = `使い方: node scripts/setup-secrets.mjs [--rotate ${ROTATABLE.join("|")}]
  足りないパラメータだけを作ります。既存の値は --rotate で指定したものしか変えません。`;

function parseCli() {
  try {
    const { values } = parseArgs({
      options: { rotate: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
    });
    if (values.help) {
      console.log(USAGE);
      process.exit(0);
    }
    if (values.rotate !== undefined && !ROTATABLE.includes(values.rotate)) {
      throw new Error(`--rotate には ${ROTATABLE.join(" / ")} のどれかを指定してください`);
    }
    return { rotate: values.rotate };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(2);
  }
}

async function main() {
  const { rotate } = parseCli();
  const region = process.env.AWS_REGION || STACK_REGION;
  const ssm = new SSMClient({ region });

  console.log(`リージョン: ${region}`);
  if (region !== STACK_REGION) {
    console.warn(`注意: スタックは ${STACK_REGION} にあります。AWS_REGION を確認してください。`);
  }

  // Existence only: no decryption, so nothing secret is read back.
  const found = await ssm.send(new GetParametersCommand({ Names: Object.values(PARAM) }));
  const existing = new Set((found.Parameters ?? []).map((p) => p.Name));

  const put = async (name, value, type, description, overwrite) => {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: type,
        Description: description,
        Tier: "Standard",
        Overwrite: overwrite,
        // PutParameter accepts tags only on creation.
        ...(overwrite ? {} : { Tags: [{ Key: "Project", Value: "thirty-days" }] }),
      }),
    );
    console.log(`${overwrite ? "更新" : "作成"}: ${name}`);
  };
  const keep = (name) => console.log(`そのまま: ${name}`);
  const notes = [];

  // VAPID key pair: both or neither.
  const hasPublic = existing.has(PARAM.vapidPublicKey);
  const hasPrivate = existing.has(PARAM.vapidPrivateKey);
  if (rotate === "vapid" || (!hasPublic && !hasPrivate)) {
    const overwrite = rotate === "vapid";
    const keys = webpush.generateVAPIDKeys();
    await put(PARAM.vapidPrivateKey, keys.privateKey, "SecureString", "30日だけ: Web Push VAPID private key", overwrite && hasPrivate);
    await put(PARAM.vapidPublicKey, keys.publicKey, "String", "30日だけ: Web Push VAPID public key", overwrite && hasPublic);
    if (overwrite) {
      notes.push("VAPID 鍵を作り直しました。npm run deploy で反映してください。既存の通知登録は届かなくなるので、各端末で通知をオンにし直す必要があります。");
    }
  } else if (hasPublic !== hasPrivate) {
    throw new Error("VAPID 鍵の片方だけがあります。--rotate vapid で両方を作り直してください。");
  } else {
    keep(PARAM.vapidPrivateKey);
    keep(PARAM.vapidPublicKey);
  }

  if (rotate === "admin-token" || !existing.has(PARAM.adminToken)) {
    const token = randomBytes(32).toString("base64url");
    await put(PARAM.adminToken, token, "SecureString", "30日だけ: /admin token", existing.has(PARAM.adminToken));
    console.log("");
    console.log("管理トークン（この1回だけ表示します。パスワードマネージャーに保存してください）:");
    console.log(token);
    console.log("");
    if (rotate === "admin-token") {
      notes.push("動いている Lambda は古いトークンを覚えています。すぐ切り替えるには npm run deploy などで api 関数を更新してください。");
    }
  } else {
    keep(PARAM.adminToken);
  }

  if (rotate === "origin-verify" || !existing.has(PARAM.originVerify)) {
    const value = randomBytes(32).toString("hex");
    await put(PARAM.originVerify, value, "String", "30日だけ: CloudFront → API shared header", existing.has(PARAM.originVerify));
    if (rotate === "origin-verify") notes.push("origin-verify を変えました。npm run deploy で CloudFront と API の両方に反映してください。");
  } else {
    keep(PARAM.originVerify);
  }

  for (const note of notes) console.log(`\n${note}`);
  console.log("\n完了。次は npm run deploy です（docs/deploy.md）。");
}

main().catch((err) => {
  const name = err instanceof Error ? err.name : "Error";
  const message = err instanceof Error ? err.message : String(err);
  console.error(`失敗しました: ${name}: ${message}`);
  if (name === "CredentialsProviderError" || /credential/i.test(message)) {
    console.error("AWS の認証情報が見つかりません。aws configure または AWS_PROFILE を確認してください。");
  }
  process.exit(1);
});
