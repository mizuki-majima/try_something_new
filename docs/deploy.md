# デプロイ手順（AWS）

構成は [SPEC.md](../SPEC.md) の Architecture。IaC は `infra/`（AWS CDK、スタック名 `ThirtyDays`、リージョン `ap-northeast-1`）。生成 AI は使っていないので、Bedrock の設定やモデルの有効化は不要（[ADR 0003](decisions/0003-no-ai-mock-suggestions.md)）。

> **本番公開（URL を人に配ること）は CEO の承認が要る**（[docs/validation-plan.md](validation-plan.md)）。CEO は 2026-10-07 に PILOT（友人・同僚に配る）を承認した（[ADR 0005](decisions/0005-pilot-approval.md)）。`https://d1zw3n37kpuo7t.cloudfront.net` が PILOT 用の環境で、招待は Gate 6（実機の Live smoke と、通知メールの購読の承認の後）。一般公開（LIVE）には、改めて CEO の承認が要る（Gate 7）。
>
> 2026-10-07 に `ALERT_EMAIL`（宛先は CEO のメールアドレス。リポジトリには書かない）を付けて再デプロイし、予算 `thirty-days-monthly` とアラーム5つを作った（[#6](https://github.com/mizuki-majima/try_something_new/issues/6)）。
>
> - **次からのデプロイでも同じ宛先を付ける。** 外すと予算・SNS トピック・アラームが確認なしで消え、付け直しても購読の承認からやり直しになる。宛先はどこにも新しく書かず、`aws sns list-subscriptions-by-topic --topic-arn <ThirtyDays-CostGuardAlarmTopic… の ARN>` の `Endpoint` で確かめるか CEO に聞く
> - 予算のメールは宛先に直接届く（承認は要らない）。アラームのメールは SNS 経由なので、AWS からの確認メール（件名「AWS Notification - Subscription Confirmation」）で購読を承認してから届く
> - 確認メールのリンクには期限がある（数日。過ぎると承認されないまま消える）。期限が過ぎたら、同じコマンドの代わりに `aws sns subscribe --topic-arn <上の ARN> --protocol email --notification-endpoint <宛先>` で確認メールを送り直す（CloudFormation は消えた購読に気づかないので、再デプロイでは送り直されない）

## 前提

- AWS アカウントと、デプロイできる権限の認証情報（`aws configure` または `AWS_PROFILE`。初回の bootstrap には管理者相当の権限が必要）
- AWS CLI（`aws`）。origin-verify の入れ替えの手順 3 でデプロイ済みの状態を読む（読み取りだけ）のと、秘密情報の入れ替え後に api 関数を作り直させるのに使う
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

SSM Parameter Store に次を作る。すでにあるものは変えない（何度実行してもよい）。

| 名前 | 種類 | 中身 | 読むもの |
|---|---|---|---|
| `/thirty-days/vapid-public-key` | String | Web Push の公開鍵 | デプロイ時に Lambda の環境変数へ |
| `/thirty-days/vapid-private-key` | SecureString | Web Push の秘密鍵 | api・reminder が起動時に読む |
| `/thirty-days/admin-token` | SecureString | `/admin` の管理トークン | api が起動時に読む |
| `/thirty-days/ip-hash-key` | SecureString | レート制限のキーにする IP の HMAC-SHA256 の鍵（32バイトの乱数。表示しない） | api が起動時に読む。**無い・空・読めないと api は起動しない**（全リクエストが 500 になり `ApiErrors` が鳴る。リポジトリに載っている既定の鍵では動かない。R4） |
| `/thirty-days/origin-verify` | String | API が受け付ける確認用ヘッダの値（入れ替え中だけ `古い値,新しい値`）。空や `,` だけにすると API はすべて 403 を返す（確認が外れることはない。R6） | デプロイ時に api の `ORIGIN_VERIFY` へ |
| `/thirty-days/origin-verify-send` | String | CloudFront が API へ送る確認用ヘッダの値（1つ） | デプロイ時に CloudFront へ |

**管理トークンは作成時に1回だけ表示される。** パスワードマネージャーに保存する。値はリポジトリにも CloudFormation テンプレートにも入らない。

`npm run deploy` は、ビルドのあと `cdk deploy` の前に `node scripts/setup-secrets.mjs --check` を実行し、パラメータが足りない・種類が違う・CloudFront が送る値を API が受け付けない（受け付ける値が空の場合も）、のどれかならデプロイしない。

### 3. 費用配分タグを有効にする（予算のため。1回だけ）

**2026-10-07 に有効化済み**（いまの AWS アカウント。アカウントを変えたらやり直す）。

AWS アカウントは他のプロジェクトと共用なので、予算 `thirty-days-monthly` は **`Project=thirty-days` タグの付いた費用だけ**を数える（`ALERT_EMAIL` を付けてデプロイしたとき）。そのためにタグを費用配分タグとして有効にする。

1. 支払いを管理しているアカウント（Organizations なら管理アカウント）で、Billing and Cost Management → **Cost allocation tags**（コスト配分タグ）を開く
2. ユーザー定義タグ **`Project`** を選んで **Activate**（有効化）。タグはリソースができてから一覧に出るまで最大24時間かかる
3. 有効にしてから予算に反映されるまでも最大24時間

**有効にするまで、この予算は $0 のまま（通知は来ない）。** その間は、このアカウントにもともとあるアカウント全体の予算アラートが頼り（SPEC の Non-functional Requirements）。タグの付かない費用（CDK bootstrap の資産バケットなど）はこの予算に入らない。

## デプロイ（初回・更新とも）

```sh
PUBLIC_ORIGIN=https://d1zw3n37kpuo7t.cloudfront.net ALERT_EMAIL=you@example.com npm run deploy
```

ビルド（API と Web）→ `setup-secrets.mjs --check` → `cdk deploy` の順に実行する（ルートの `npm run deploy` は `npm run build && npm run deploy -w infra`、`infra` の `deploy` が `--check` のあと `cdk deploy`）。`--check` で止まるのはビルドのあと。最後に出る `ThirtyDays.SiteUrl` が公開 URL。初回は CloudFront の作成で 5〜10 分かかる。

| 環境変数・オプション | 内容 |
|---|---|
| `PUBLIC_ORIGIN=https://<CloudFront のドメイン>` | **毎回指定する。** Web のビルドで `index.html` の `og:image` / `twitter:image` を絶対 URL にする（X・LINE のリンクのプレビューに画像を出すため）。末尾の `/` は不要。初回はドメインがまだ無いので付けずにデプロイし、出てきた `SiteUrl` を付けてもう一度デプロイする。付け忘れると `cdk` が「警告: Web のビルドの OGP 画像が公開用になっていません」と出す |
| `ALERT_EMAIL=...`（または `-c alertEmail=...`） | **強く推奨。** 予算（月 $10、`Project=thirty-days` の費用だけ。実績 80%・予測 100% 超えでメール）とアラーム5つ（下の「アラーム」）を作る。初回は AWS から届く確認メールの「Confirm subscription」を押す。**毎回のデプロイで指定する**（外すと予算とアラームが消える） |
| `-c webDistPath=...` `-c apiDistPath=...` `-c reminderDistPath=...` | ビルド済みファイルの場所を変える（既定は `apps/web/dist`、`apps/api/dist/api`、`apps/api/dist/reminder`） |

`-c` を使うときは `infra/` から実行する（ルートの `npm run deploy` 経由だと npm がフラグを受け取ってしまう）。この場合 `--check` は自動では走らないので先に実行する（飛ばして `ip-hash-key` が無いと、デプロイは通っても API が 500 になる）。

```sh
node scripts/setup-secrets.mjs --check
PUBLIC_ORIGIN=https://d1zw3n37kpuo7t.cloudfront.net npm run build
cd infra && npx cdk deploy -c alertEmail=you@example.com
```

変更内容だけを見るには `npm run diff -w infra`。

### 既存の環境を、2026-10 のレビュー修正版に更新するとき

先に一度だけ `node scripts/setup-secrets.mjs` を実行する。`/thirty-days/ip-hash-key` を作り、`/thirty-days/origin-verify-send` を**いまの `origin-verify` と同じ値**で作る（CloudFront が送る値は変わらないので、更新中も API は止まらない）。実行しないと `npm run deploy` は `--check` で止まる。

### デプロイ後の確認

1. `SiteUrl` を開き、「レシピから選ぶ」→ チャレンジ開始 → 印を押す（CUF-1）
2. `<SiteUrl>/api/health` が `{"ok":true}` を返す
3. API Gateway の URL（`https://<apiId>.execute-api.ap-northeast-1.amazonaws.com/api/health`）を直接開くと 403（CloudFront 経由のみ受け付ける）。AWS アカウントは他のプロジェクトと共用なので、コンソールでは API 名 `ThirtyDaysApi`、スタックの説明「30日だけ (try_something_new)」で見分ける
4. `<SiteUrl>/media/hidden/share/x.png` が 404（公開されるのは `/media/share/<id>.png` だけ。通報や管理で非表示にしたカードの画像は `hidden/share/` に移る）
5. `curl -s <SiteUrl>/ | grep og:image` が `https://` で始まる URL を返す
6. （`ALERT_EMAIL` を付けたとき）確認メールの購読を承認した。CloudWatch のアラームが5つ（下）と、ロググループ `ApiLogs…` のメトリクスフィルタ（`CostGuardSessionCeilingFilter…` のような名前）があり、Budgets に `thirty-days-monthly` がある
7. DynamoDB のテーブル（コンソールの「追加の設定」→ 読み込み/書き込みキャパシティ）で、テーブルと GSI 3つの最大オンデマンドスループットが読み込み 1000・書き込み 100 になっている

## アラーム（`ALERT_EMAIL` 指定時）

どれも SNS トピック「thirty-days alerts」からメールで届く。データが無い間は「正常」扱い。

| 名前（コンソールでは `ThirtyDays-CostGuard` で始まる） | 条件 | 何が分かるか |
|---|---|---|
| `Api5xx` | API Gateway（`ThirtyDaysApi`、ステージ `$default`）の 5xx が5分間に5回以上 | ルートの例外（DynamoDB の権限エラーなど）。API はこれを普通の 500 として返すので、Lambda の Errors には数えられない |
| `ApiErrors` | api Lambda の Errors が5分間に5回以上 | 起動・SSM の読み込み・タイムアウトの失敗 |
| `ReminderErrors` | reminder Lambda の Errors が1時間に2回以上 | リマインドの実行そのものの失敗（1人ずつの送信失敗はログにだけ出る） |
| `DynamoThrottles` | DynamoDB のスロットル（`ThrottledRequests`、api と reminder が使う操作の合計）が5分間に1回以上 | 費用の上限（下の「費用の目安」。テーブルと GSI ごとに読み込み 1000・書き込み 100 ユニット/秒）に当たった。100人規模では当たらないので、荒らしか、バックアップの読み込みのような大きな書き込みの集中。スロットルされた要求は SDK が数回やり直し、それでも通らなければ API は 500 を返す（`Api5xx` も鳴りうる）。上限に当たっている間は、ほかの人の読み込み（認証を含むので API 全体）と書き込みも遅れる（書き込みは端末の送信待ちに残り、あとで送られる）。上限の少し下で使われ続けているときは鳴らない（下の「費用の目安」） |
| `SessionCeiling` | api のログの `global session ceiling reached`（アカウント作成の全体の上限、1時間2000件に当たった）が5分間に1回以上。ロググループのメトリクスフィルタ `SessionCeilingFilter` が数える | 新しく来た人がアカウントを作れず断られている（画面には「混み合っています」の帯。端末の中では使えるが、1日組・共有・PILOT の数に出ない）。ネットワークごと（IPv4 /16・IPv6 /48）に1時間60件までなので、34以上のネットワークからの大量作成か、本当に人が一気に来たか。CloudWatch Logs Insights で api のログの `session created` の数を見て、PILOT の参加者に影響があれば CEO に報告する。その時間が終わると自然に戻る |

## 費用の目安

2026-10 時点の東京リージョンの単価で、月100人ほど使う想定。AI は使わないので AI の費用は無い。

| 項目 | 月額の目安 | 備考 |
|---|---|---|
| CloudFront | $0 | 無料枠（毎月 1TB の転送・1,000万リクエスト・CloudFront Functions 200万回）の範囲 |
| S3（Web・カード画像） | $0 | 数 MB。$0.01 未満 |
| Lambda（api・reminder） | $0 | 無料枠（100万リクエスト・40万 GB 秒）の範囲。reminder は15分ごと（月約2,900回） |
| EventBridge（15分ごとのスケジュールルール） | $0 | スケジュールルールは無料 |
| SSM Parameter Store（Standard 6個） | $0 | Standard パラメータは無料 |
| CloudWatch Logs（14日保持） | $0 | 取り込み 5GB の無料枠の範囲 |
| API Gateway HTTP API | 約 $0.06 | 100万リクエストあたり約 $1.29 |
| DynamoDB（オンデマンド＋PITR） | 約 $0.02 | 書き込み・読み込みと PITR（数 MB）。オンデマンドの最大スループットに上限あり（下） |
| アラーム（`ALERT_EMAIL` 指定時） | 最大 約 $1.2 | CloudWatch はアラームを**メトリクスの数**で課金する（1つのメトリクスを見るアラームは1、式のアラームは式の中のメトリクスの数）。このスタックはアラームのメトリクス 12個（`Api5xx`・`ApiErrors`・`ReminderErrors`・`SessionCeiling` が1つずつ、`DynamoThrottles` が DynamoDB の操作ごとに8つ）で、1個 月 約 $0.10。無料枠はアカウント全体で10個なので、共用アカウントで他のプロジェクトが使っていれば 約 $1.2 になる。`SessionCeilingFilter` のカスタムメトリクスは警告が出た時間だけ課金（月 $0.30 を時間割り。普段は $0） |
| SNS（メール）・Budgets（`ALERT_EMAIL` 指定時） | $0 | メール通知と予算（アクションなし）は無料 |
| **合計** | **約 $0.1（アラームを付けると最大 約 $1.3）** | 目標は月 $1 未満（SPEC）。アラームの無料枠が使われていると目標を超える。下げるなら `DynamoThrottles` をテーブルの `ReadThrottleEvents`・`WriteThrottleEvents` の2つにする（アラームのメトリクス 6個、約 $0.6） |

- 無料枠はアカウント単位なので、他のプロジェクトが使い切っている場合は CloudFront・Lambda・Logs にも費用が付く。その場合でも100人規模なら月 $0.5 前後の見込み
- **DynamoDB の費用の上限（R1、R15、R16）**: テーブルと GSI 3つのそれぞれに、オンデマンドの最大スループット（読み込み 1000・書き込み 100 ユニット/秒。`infra/lib/config.ts` の `TABLE_MAX_THROUGHPUT`）を付けてある。超えた分は課金されずにスロットル（拒否）される。**これが抑えるのは1時間あたりの速さで、月の合計ではない。** 東京のオンデマンドの単価（約 $0.1425／100万 RRU、約 $0.715／100万 WRU）で、テーブルか GSI 1つが上限まで使われると読み込み **約 $0.51/時**・書き込み **約 $0.26/時**、テーブルと GSI 3つ全部なら 約 $3.1/時（1日 約 $74）。上限に当たると5分以内に `DynamoThrottles` のメールが来るが、**上限の少し下で使われ続けるとスロットルは起きず、アラームは鳴らない**。続く使い方に気づけるのは予算のメール（実績 80%・予測 100%。費用配分タグの有効化が前提で、数時間遅れる）だけ。荒らしで書き込まれたデータは、止まったあとも保存と PITR の費用として毎月残るので、見つけたら消す（消すのも書き込みの上限の速さでしかできない）。API 側でも書き込みの量を抑えている: ニックネーム・進捗公開の変更は1人1日10回まで（そのたびに自分のチャレンジの公開用の情報を書き直すため）、書き直すのは中身が変わる項目だけ、保存する文字は UTF-8 のバイト数でも上限（`文字数 × 4 + 32` バイト）、バックアップの読み込みは1人1日3回・同時に1つだけ
- **それ以外の上限の目安（荒らしなどで API がステージの上限 20 リクエスト/秒で使われ続けた場合）**: 月約5,200万リクエストで、CloudFront 約 $60、API Gateway 約 $67、Lambda 約 $20、CloudWatch Logs 約 $20 で、**月 $170 前後**（DynamoDB は上の上限まで）。こうしたリクエストは 2xx か 429 で終わるので `Api5xx` は鳴らない。気づけるのは予算のメール（実績 80%・予測 100%）だけで、**費用配分タグを有効にするまで予算は $0 のまま**（「費用配分タグを有効にする」）。月 $10 を超えそうなら CEO に報告する（ADR 0001）

## 秘密情報の入れ替え

```sh
node scripts/setup-secrets.mjs --rotate admin-token     # 新しいトークンを1回だけ表示
node scripts/setup-secrets.mjs --rotate ip-hash-key     # 表示しない。レート制限の回数が数え直しになる
node scripts/setup-secrets.mjs --rotate vapid           # あとで npm run deploy。既存の通知登録は無効になる
node scripts/setup-secrets.mjs --rotate origin-verify   # 3段階（下）
```

**api 関数は SecureString（管理トークン・IP のハッシュ鍵・VAPID 秘密鍵）を起動時に読んでメモリに持つ。** `npm run deploy` は関数の設定が変わらないと実行環境を入れ替えないので、放っておくと古い値がしばらく（実行環境が入れ替わるまで。時期は AWS 次第）使われる。すぐ切り替えるには、関数の説明だけを変えて実行環境を作り直させる（説明は次のデプロイで元に戻る）:

```sh
aws lambda update-function-configuration --function-name <ApiFunctionName の出力> --description "thirty-days API (Hono) rotated $(date +%F)"
```

### origin-verify（止めずに入れ替える）

CloudFront の反映には数分かかり、Lambda の切り替えは数秒で終わる。片方だけを一度に変えると、その間の API 呼び出しがすべて 403 になり、端末の送信待ちの書き込みが捨てられる。そのため API が受け付ける値（`origin-verify`）と CloudFront が送る値（`origin-verify-send`）を分け、3回に分けて入れ替える。**毎回 `npm run deploy` を最後まで終えてから次へ進む。**

| 手順 | 実行するもの | 変わるパラメータ | デプロイ後 |
|---|---|---|---|
| 1 | `node scripts/setup-secrets.mjs --rotate origin-verify` → `npm run deploy` | `origin-verify` = `古い値,新しい値` | API は両方を受け付ける。CloudFront は古い値を送る |
| 2 | 同じコマンド → `npm run deploy` | `origin-verify-send` = 新しい値 | CloudFront が新しい値を送る（デプロイは CloudFront の反映が終わるまで待つ） |
| 3 | 同じコマンド → `npm run deploy` | `origin-verify` = 新しい値 | 古い値は 403。入れ替え完了 |

- スタックは api 関数を CloudFront より先に更新する。手順 1 と 2 を1回のデプロイで出しても、API が新しい値を受け付けてから CloudFront が送り始める
- 手順 2 と 3 を1回のデプロイで出してはいけない（API が古い値を捨てたとき、まだ古い値を送る拠点が残る）。そのため**手順 3 の前に、スクリプトはデプロイ済みの状態を AWS CLI で読む**（読み取りだけ: `aws cloudformation describe-stacks` と `aws cloudfront get-distribution`）。スタックが `UPDATE_COMPLETE`（初回なら `CREATE_COMPLETE`）で、最後のデプロイが新しい `origin-verify-send` を使っていて、CloudFront が `Deployed` で新しい値を送っているときだけ進む。手順 2 のあとのデプロイが失敗した・飛ばした・まだ終わっていない・ロールバックした、CloudFront の反映中、AWS CLI が無い・読めない、のどれでも何も変えずに止まる（R6）
- 手順 3 だけを1回のデプロイで出すのは安全（CloudFront はもう新しい値だけを送っている）
- 途中かどうかは `node scripts/setup-secrets.mjs --check` が表示する。手で直すときは、`origin-verify` が `origin-verify-send` の値を必ず含むようにする（含まないと `--check` がデプロイを止める）

## ロールバック

- **コード**: 直前の正常なコミットに戻して、同じ手順でデプロイし直す（`git checkout <commit>` → `npm ci` → `npm run deploy`）。Web の古いハッシュ付きファイルは消さない設定なので、開いたままのタブも壊れない。2026-10 のレビュー修正より前の版は CloudFront にも `origin-verify` の値を送らせるので、戻すのは `origin-verify` と `origin-verify-send` が同じ1つの値のとき（入れ替えが終わった状態）だけにする。違うまま戻すと、そのデプロイの数分間 API が 403 になる。2026-10 の再レビュー修正（R1〜R10）より前の版に戻すと、DynamoDB のスループットの上限と `DynamoThrottles` のアラームも外れる。最終確認の修正（R11〜R16）より前に戻すと、アカウント削除でモデレーションの印（`MOD#`）がまた消え、`SessionCeiling` のアラームが外れる
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
| SSM パラメータ `/thirty-days/*`（6個） | Parameter Store で削除 |
| CDK bootstrap（`CDKToolkit` スタックと資産バケット） | 他に CDK を使っていなければ削除 |
| 費用配分タグ `Project` の有効化 | 他のプロジェクトが使っていなければ Cost allocation tags で無効化 |
