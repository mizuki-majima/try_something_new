# デプロイ手順（AWS）

構成は [SPEC.md](../SPEC.md) の Architecture。IaC は `infra/`（AWS CDK、スタック名 `ThirtyDays`、リージョン `ap-northeast-1`）。生成 AI は使っていないので、Bedrock の設定やモデルの有効化は不要（[ADR 0003](decisions/0003-no-ai-mock-suggestions.md)）。

## 前提

- AWS アカウントと、デプロイできる権限の認証情報（`aws configure` または `AWS_PROFILE`。初回の bootstrap には管理者相当の権限が必要）
- Node.js 22（`.nvmrc`）
- リポジトリのルートで `npm ci` 済み

## 初回だけ

### 1. CDK bootstrap

```sh
cd infra
npx cdk bootstrap aws://<アカウントID>/ap-northeast-1
```

### 2. 秘密情報を作る

```sh
node scripts/setup-secrets.mjs
```

SSM Parameter Store に次を作る。すでにあるものは変えない。

| 名前 | 種類 | 中身 |
|---|---|---|
| `/thirty-days/vapid-public-key` | String | Web Push の公開鍵 |
| `/thirty-days/vapid-private-key` | SecureString | Web Push の秘密鍵 |
| `/thirty-days/admin-token` | SecureString | `/admin` の管理トークン |
| `/thirty-days/origin-verify` | String | CloudFront → API の確認用ヘッダ |

**管理トークンは作成時に1回だけ表示される。** パスワードマネージャーに保存する。値はリポジトリにも CloudFormation テンプレートにも入らない。

## デプロイ（初回・更新とも）

```sh
ALERT_EMAIL=you@example.com npm run deploy
```

ビルド（API と Web）→ `cdk deploy` の順に実行する。最後に出る `ThirtyDays.SiteUrl` が公開 URL。初回は CloudFront の作成で 5〜10 分かかる。

| オプション | 内容 |
|---|---|
| `ALERT_EMAIL=...`（または `-c alertEmail=...`） | **強く推奨。** 月 $10 の予算（実績 80%・予測 100% 超えでメール）と、API エラーのアラーム（5分で5回以上）を作る。初回は AWS から届く確認メールの「Confirm subscription」を押す。**毎回のデプロイで指定する**（外すと予算とアラームが消える） |
| `-c webDistPath=...` `-c apiDistPath=...` `-c reminderDistPath=...` | ビルド済みファイルの場所を変える（既定は `apps/web/dist`、`apps/api/dist/api`、`apps/api/dist/reminder`） |

`-c` を使うときは `infra/` から実行する（ルートの `npm run deploy` 経由だと npm がフラグを受け取ってしまう）。

```sh
npm run build
cd infra && npx cdk deploy -c alertEmail=you@example.com
```

変更内容だけを見るには `npm run diff -w infra`。

### デプロイ後の確認

1. `SiteUrl` を開き、「レシピから選ぶ」→ チャレンジ開始 → 印を押す（CUF-1）
2. `<SiteUrl>/api/health` が `{"ok":true}` を返す
3. API Gateway の URL（`https://<apiId>.execute-api.ap-northeast-1.amazonaws.com/api/health`）を直接開くと 403（CloudFront 経由のみ受け付ける）。AWS アカウントは他のプロジェクトと共用なので、コンソールでは API 名 `ThirtyDaysApi`、スタックの説明「30日だけ (try_something_new)」で見分ける

## 費用の目安

| 項目 | 月額の目安 |
|---|---|
| CloudFront | （PM が記入） |
| Lambda（api・reminder） | （PM が記入） |
| API Gateway HTTP API | （PM が記入） |
| DynamoDB（オンデマンド＋PITR） | （PM が記入） |
| S3 | （PM が記入） |
| SSM Parameter Store（Standard） | （PM が記入） |
| CloudWatch Logs（14日保持） | （PM が記入） |
| 合計 | （PM が記入） |

## 秘密情報の入れ替え

```sh
node scripts/setup-secrets.mjs --rotate admin-token     # 新しいトークンを表示
node scripts/setup-secrets.mjs --rotate origin-verify   # あとで npm run deploy
node scripts/setup-secrets.mjs --rotate vapid           # あとで npm run deploy。既存の通知登録は無効になる
```

## ロールバック

- **コード**: 直前の正常なコミットに戻して、同じ手順でデプロイし直す（`git checkout <commit>` → `npm ci` → `npm run deploy`）。Web の古いハッシュ付きファイルは消さない設定なので、開いたままのタブも壊れない
- **データ**: DynamoDB はポイントインタイムリカバリ（PITR、35日）が有効。コンソールの DynamoDB → テーブル → バックアップ →「ポイントインタイムに復元」で**別名の新しいテーブル**に復元し、必要な項目を元のテーブルへ書き戻す。スタックのテーブルを差し替えない（CloudFormation の管理から外れる）

## 片付け（停止するとき）

```sh
cd infra && npx cdk destroy
```

次は消えずに残る（データを失わないための設定）。不要なら手で消す。

| 残るもの | 消し方 |
|---|---|
| DynamoDB テーブル | 削除保護をオフにしてから削除 |
| S3 バケット 2つ（Web・メディア） | 中身を空にしてから削除 |
| SSM パラメータ `/thirty-days/*` | Parameter Store で削除 |
| CDK bootstrap（`CDKToolkit` スタックと資産バケット） | 他に CDK を使っていなければ削除 |
