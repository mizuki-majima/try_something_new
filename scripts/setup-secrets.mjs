#!/usr/bin/env node
/**
 * The SSM parameters the stack reads (docs/deploy.md).
 * Creates whatever is missing and never overwrites, unless asked with --rotate <name>.
 *
 *   node scripts/setup-secrets.mjs                       作る（足りないものだけ）
 *   node scripts/setup-secrets.mjs --check               確かめるだけ（npm run deploy が最初に実行する）
 *   node scripts/setup-secrets.mjs --rotate <name>       vapid | admin-token | ip-hash-key | origin-verify
 *
 * origin-verify rotates in three steps, one `npm run deploy` after each (nextOriginVerifyStep).
 * Region: AWS_REGION, else ap-northeast-1 (the stack's region).
 * The only secret ever printed is a newly created admin token, once. SecureStrings are never read
 * back (listed without decryption); the origin-verify Strings are compared but never printed.
 */
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Keep in sync with infra/lib/config.ts (infra/test checks they are equal).
export const PARAM = {
  vapidPublicKey: "/thirty-days/vapid-public-key",
  vapidPrivateKey: "/thirty-days/vapid-private-key",
  adminToken: "/thirty-days/admin-token",
  originVerify: "/thirty-days/origin-verify",
  originVerifySend: "/thirty-days/origin-verify-send",
  ipHashKey: "/thirty-days/ip-hash-key",
};

/** The SSM type the stack expects for each parameter (CloudFormation can only resolve Strings). */
export const PARAM_TYPES = {
  [PARAM.vapidPublicKey]: "String",
  [PARAM.vapidPrivateKey]: "SecureString",
  [PARAM.adminToken]: "SecureString",
  [PARAM.originVerify]: "String",
  [PARAM.originVerifySend]: "String",
  [PARAM.ipHashKey]: "SecureString",
};

const DESCRIPTION = {
  [PARAM.vapidPublicKey]: "30日だけ: Web Push VAPID public key",
  [PARAM.vapidPrivateKey]: "30日だけ: Web Push VAPID private key",
  [PARAM.adminToken]: "30日だけ: /admin token",
  [PARAM.originVerify]: "30日だけ: x-origin-verify values the API accepts (comma-separated while rotating)",
  [PARAM.originVerifySend]: "30日だけ: x-origin-verify value CloudFront sends",
  [PARAM.ipHashKey]: "30日だけ: HMAC key for client IPs in rate-limit keys",
};

const STACK_REGION = "ap-northeast-1";
export const ROTATABLE = ["vapid", "admin-token", "ip-hash-key", "origin-verify"];

/**
 * Step 3 of an origin-verify rotation drops the old value. It must wait until CloudFront sends the
 * new one everywhere (the deploy after step 2 waits for that); this only stops step 3 from being
 * run straight after step 2, before any deploy.
 */
export const ORIGIN_VERIFY_SETTLE_MINUTES = 10;

const USAGE = `使い方: node scripts/setup-secrets.mjs [--check | --rotate ${ROTATABLE.join("|")}]
  足りないパラメータだけを作ります。既存の値は --rotate で指定したものしか変えません。
  --check は作らずに確かめるだけです（npm run deploy が最初に実行します）。`;

/** The values the API accepts, from /thirty-days/origin-verify ("old,new" while rotating). */
export function acceptList(value) {
  return [
    ...new Set(
      String(value ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Where an origin-verify rotation stands. accept = /thirty-days/origin-verify (what the API
 * accepts), send = /thirty-days/origin-verify-send (what CloudFront sends).
 *   "steady"  accept [S]   send S
 *   "step1"   accept [S,N] send S   step 1 done; next: CloudFront sends N
 *   "step2"   accept [S,N] send N   step 2 done; next: the API drops S
 *   "broken"  anything else; above all, CloudFront would send a value the API refuses (403 for all)
 */
export function originVerifyState(accept, send) {
  const list = acceptList(accept);
  if (!send || !list.includes(send)) return "broken";
  if (list.length === 1) return "steady";
  if (list.length === 2) return send === list[0] ? "step1" : "step2";
  return "broken";
}

/**
 * The parameter writes of the next rotation step. Run `npm run deploy` (to the end) after each.
 *   1. accept "S,N"  the API accepts both; CloudFront still sends S
 *   2. send N        CloudFront switches to N (the stack updates the API before CloudFront)
 *   3. accept "N"    the API refuses S again
 * Whatever the order of a hand-edited list, a step never drops the value CloudFront sends.
 */
export function nextOriginVerifyStep(accept, send, newValue) {
  const list = acceptList(accept);
  switch (originVerifyState(accept, send)) {
    case "steady":
      return { step: 1, accept: `${send},${newValue}` };
    case "step1":
      return { step: 2, send: list[1] };
    case "step2":
      return { step: 3, accept: send };
    default:
      throw new Error(
        "origin-verify の状態が想定外です（CloudFront が送る値を API が受け付けない、または値が3つ以上）。docs/deploy.md の手順で直してください。",
      );
  }
}

const ORIGIN_VERIFY_BROKEN = `${PARAM.originVerify}（API が受け付ける値）が ${PARAM.originVerifySend}（CloudFront が送る値）を含んでいないか、値が3つ以上あります。このままデプロイすると API がすべて 403 になります`;

/**
 * Problems that would break a deploy or the running API ([] when everything is in place).
 * found: Map of name → { type, value } (value only for String parameters).
 */
export function checkParameters(found) {
  const problems = [];
  for (const [name, type] of Object.entries(PARAM_TYPES)) {
    const p = found.get(name);
    if (!p) problems.push(`${name} がありません`);
    else if (p.type !== type) problems.push(`${name} は ${type} のはずですが ${p.type} です`);
  }
  const accept = found.get(PARAM.originVerify);
  const send = found.get(PARAM.originVerifySend);
  if (accept?.type === "String" && send?.type === "String" && originVerifyState(accept.value, send.value) === "broken") {
    problems.push(ORIGIN_VERIFY_BROKEN);
  }
  return problems;
}

const ROTATION_NOTE = {
  1: "origin-verify 入れ替え 1/3: API が古い値と新しい値の両方を受け付けるようにしました。npm run deploy を最後まで実行してから、もう一度 --rotate origin-verify を実行してください。",
  2: "origin-verify 入れ替え 2/3: CloudFront が新しい値を送るようにしました。npm run deploy を最後まで実行してから（CloudFront の反映を待つので数分かかります）、もう一度 --rotate origin-verify を実行してください。",
  3: "origin-verify 入れ替え 3/3: 古い値を受け付けないようにしました。npm run deploy で反映すると完了です。",
};

const IN_PROGRESS_NOTE = {
  step1: "origin-verify の入れ替えが途中です（1/3 まで）。npm run deploy のあと --rotate origin-verify で次へ進めてください。",
  step2: "origin-verify の入れ替えが途中です（2/3 まで）。npm run deploy のあと --rotate origin-verify で終わらせてください。",
};

function parseCli() {
  try {
    const { values } = parseArgs({
      options: {
        rotate: { type: "string" },
        check: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });
    if (values.help) {
      console.log(USAGE);
      process.exit(0);
    }
    if (values.rotate !== undefined && !ROTATABLE.includes(values.rotate)) {
      throw new Error(`--rotate には ${ROTATABLE.join(" / ")} のどれかを指定してください`);
    }
    if (values.rotate !== undefined && values.check) throw new Error("--check と --rotate は一緒に使えません");
    return { rotate: values.rotate, check: values.check === true };
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(2);
  }
}

const newOriginVerifyValue = () => randomBytes(32).toString("hex");

async function main() {
  const { rotate, check } = parseCli();
  const region = process.env.AWS_REGION || STACK_REGION;
  const { GetParametersCommand, PutParameterCommand, SSMClient } = await import("@aws-sdk/client-ssm");
  const ssm = new SSMClient({ region });

  console.log(`リージョン: ${region}`);
  if (region !== STACK_REGION) {
    console.warn(`注意: スタックは ${STACK_REGION} にあります。AWS_REGION を確認してください。`);
  }

  // No decryption: a SecureString's value stays encrypted and is dropped right away.
  const res = await ssm.send(new GetParametersCommand({ Names: Object.values(PARAM) }));
  const found = new Map(
    (res.Parameters ?? []).map((p) => [
      p.Name,
      { type: p.Type, value: p.Type === "String" ? p.Value : undefined, modified: p.LastModifiedDate },
    ]),
  );

  if (check) {
    const problems = checkParameters(found);
    if (problems.length > 0) {
      console.error("SSM パラメータに問題があります:");
      for (const p of problems) console.error(`  - ${p}`);
      console.error("node scripts/setup-secrets.mjs で足りないものを作ってから、もう一度デプロイしてください（docs/deploy.md）。");
      process.exit(1);
    }
    console.log(`SSM パラメータ ${Object.keys(PARAM_TYPES).length} 個がそろっています。`);
    const state = originVerifyState(found.get(PARAM.originVerify)?.value, found.get(PARAM.originVerifySend)?.value);
    if (IN_PROGRESS_NOTE[state]) console.log(IN_PROGRESS_NOTE[state]);
    return;
  }

  for (const [name, p] of found) {
    if (p.type !== PARAM_TYPES[name]) {
      throw new Error(`${name} は ${PARAM_TYPES[name]} のはずですが ${p.type} です。Parameter Store で消してから、もう一度実行してください。`);
    }
  }

  const put = async (name, value, overwrite) => {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: value,
        Type: PARAM_TYPES[name],
        Description: DESCRIPTION[name],
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
  const hasPublic = found.has(PARAM.vapidPublicKey);
  const hasPrivate = found.has(PARAM.vapidPrivateKey);
  if (rotate === "vapid" || (!hasPublic && !hasPrivate)) {
    const { default: webpush } = await import("web-push");
    const keys = webpush.generateVAPIDKeys();
    await put(PARAM.vapidPrivateKey, keys.privateKey, hasPrivate);
    await put(PARAM.vapidPublicKey, keys.publicKey, hasPublic);
    if (rotate === "vapid") {
      notes.push("VAPID 鍵を作り直しました。npm run deploy で反映してください。既存の通知登録は届かなくなるので、各端末で通知をオンにし直す必要があります。");
    }
  } else if (hasPublic !== hasPrivate) {
    throw new Error("VAPID 鍵の片方だけがあります。--rotate vapid で両方を作り直してください。");
  } else {
    keep(PARAM.vapidPrivateKey);
    keep(PARAM.vapidPublicKey);
  }

  const restartNote = (what) =>
    `動いている api 関数は古い${what}を覚えています（実行環境が入れ替わるまで）。すぐ切り替える方法は docs/deploy.md の「秘密情報の入れ替え」を見てください。`;

  if (rotate === "admin-token" || !found.has(PARAM.adminToken)) {
    const token = randomBytes(32).toString("base64url");
    await put(PARAM.adminToken, token, found.has(PARAM.adminToken));
    console.log("");
    console.log("管理トークン（この1回だけ表示します。パスワードマネージャーに保存してください）:");
    console.log(token);
    console.log("");
    if (rotate === "admin-token") notes.push(restartNote("トークン"));
  } else {
    keep(PARAM.adminToken);
  }

  // Never printed: nobody needs to know it, the API reads it from SSM.
  if (rotate === "ip-hash-key" || !found.has(PARAM.ipHashKey)) {
    await put(PARAM.ipHashKey, randomBytes(32).toString("base64url"), found.has(PARAM.ipHashKey));
    if (rotate === "ip-hash-key") {
      notes.push(`IP のハッシュ鍵を変えました。レート制限の回数は数え直しになります。${restartNote("鍵")}`);
    }
  } else {
    keep(PARAM.ipHashKey);
  }

  // origin-verify: what the API accepts and what CloudFront sends.
  let accept = found.get(PARAM.originVerify)?.value;
  let send = found.get(PARAM.originVerifySend)?.value;
  if (accept === undefined && send === undefined) {
    const value = newOriginVerifyValue();
    await put(PARAM.originVerify, value, false);
    await put(PARAM.originVerifySend, value, false);
    accept = send = value;
  } else if (send === undefined) {
    // Stacks from before origin-verify-send: CloudFront keeps sending the value it sends today.
    const list = acceptList(accept);
    if (list.length !== 1) {
      throw new Error(`${PARAM.originVerify} に値が複数あります。${PARAM.originVerifySend} に CloudFront が送っている値を手で入れてください。`);
    }
    await put(PARAM.originVerifySend, list[0], false);
    send = list[0];
  } else if (accept === undefined) {
    await put(PARAM.originVerify, send, false);
    accept = send;
  } else if (rotate !== "origin-verify") {
    keep(PARAM.originVerify);
    keep(PARAM.originVerifySend);
  }

  const state = originVerifyState(accept, send);
  if (rotate === "origin-verify") {
    const sendModified = found.get(PARAM.originVerifySend)?.modified;
    if (state === "step2" && sendModified && Date.now() - sendModified.getTime() < ORIGIN_VERIFY_SETTLE_MINUTES * 60_000) {
      throw new Error(
        `手順 2/3 から ${ORIGIN_VERIFY_SETTLE_MINUTES} 分たっていません。npm run deploy が最後まで終わって CloudFront が新しい値を送るようになってから、もう一度実行してください。`,
      );
    }
    const next = nextOriginVerifyStep(accept, send, newOriginVerifyValue());
    if (next.accept !== undefined) await put(PARAM.originVerify, next.accept, true);
    if (next.send !== undefined) await put(PARAM.originVerifySend, next.send, true);
    notes.push(ROTATION_NOTE[next.step]);
  } else if (state === "broken") {
    notes.push(`注意: ${ORIGIN_VERIFY_BROKEN}（npm run deploy は --check で止まります）。docs/deploy.md の「秘密情報の入れ替え」を見て直してください。`);
  } else if (IN_PROGRESS_NOTE[state]) {
    notes.push(IN_PROGRESS_NOTE[state]);
  }

  for (const note of notes) console.log(`\n${note}`);
  if (rotate !== "origin-verify") console.log("\n完了。次は npm run deploy です（docs/deploy.md）。");
}

function isMain() {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch((err) => {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    console.error(`失敗しました: ${name}: ${message}`);
    if (name === "CredentialsProviderError" || /credential/i.test(message)) {
      console.error("AWS の認証情報が見つかりません。aws configure または AWS_PROFILE を確認してください。");
    }
    process.exit(1);
  });
}
