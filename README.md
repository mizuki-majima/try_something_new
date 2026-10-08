# 30日だけ

新しいことを **30日だけ** 試して、30日目に「続ける／やめる／形を変える」を自分で決める Web サービス（PWA）。
TED「Try something new for 30 days」（Matt Cutts）の考え方を、誰でもすぐ試せる形にしたもの。習慣化アプリではなく「お試し」のためのサービスで、やめることも成果として扱う。

- PILOT 用の環境: https://d1zw3n37kpuo7t.cloudfront.net（友人・同僚 10人前後の1日組。2026-11-01 開始）
- 現在の Phase: **PILOT**（次は [Gate 7: PILOT → LIVE](https://github.com/mizuki-majima/try_something_new/issues/5)）。何を作り、何を作らないかは [PRODUCT.md](PRODUCT.md)、仕様は [SPEC.md](SPEC.md)

## できること

- **レシピ**から選んで、今日から／次の1日から始める（公式23本＋みんなのレシピ）
- 毎日1タップで、30マスのカードに **印**（漢字1文字）を押す。ひとことメモ、端末内だけの写真メモ
- 同じ月に始めた人の **1日組** が並び、応援できる（メッセージは送れない）。ひとことメモは、本人が日ごとに「みんなに見せる」を選んだものだけ「詳しく見る」で読める（既定は自分だけ。[ADR 0007](docs/decisions/0007-opt-in-public-notes.md)）
- 30日目（7日目以降なら途中でも）に振り返り、**振り返りカード**（画像と公開ページ）を作る
- 次にやることは **ガチャ** か **ひらめき提案（お試し）** で決める。提案は AI を使わず、内蔵の案からルールで選ぶ（[ADR 0003](docs/decisions/0003-no-ai-mock-suggestions.md)）
- Web Push のリマインド、引き継ぎコード、バックアップ、通報（公開カードは `/s/:id` の「このカードを通報する」から）と管理画面

アカウントはメール不要の匿名アカウント。料金・広告はない（趣味のサービス。[ADR 0001](docs/decisions/0001-hobby-service-skip-payment-validation.md)）。

## 構成

| 層 | 使っているもの |
|---|---|
| Web | React 19 + React Router、Vite、PWA（vite-plugin-pwa、Service Worker）。デザインは「白いノート」（手書きの見出し・白ベース・夜にまぶしくないダーク。[docs/design.md](docs/design.md)） |
| API | Hono（TypeScript）を AWS Lambda（Node.js 22 / arm64）で動かす。入力検証は zod（`packages/shared` のスキーマを Web と共用） |
| データ | DynamoDB 1テーブル（オンデマンド。費用が増える速さの上限として最大スループットを設定、PITR）。ローカルとテストは dynalite（Java / Docker 不要） |
| 配信 | CloudFront → S3（Web）／API Gateway HTTP API `ThirtyDaysApi`（`/api/*` `/s/*`）／S3（公開カード画像 `/media/share/*` だけ） |
| 通知 | EventBridge（15分ごと）→ Lambda → Web Push（VAPID） |
| 秘密情報 | SSM Parameter Store（VAPID 秘密鍵・管理トークン・IP のハッシュ鍵は SecureString。`scripts/setup-secrets.mjs`） |
| IaC | AWS CDK（`infra/`、スタック `ThirtyDays`、リージョン `ap-northeast-1`）。`ALERT_EMAIL` 指定時は予算（`Project` タグの費用だけ）と API・リマインド・DynamoDB のスロットル・アカウント作成の全体の上限のアラーム |

生成 AI・課金される外部 API は使わない。AWS 費用は月 $1 未満が目標で、100人規模なら月約 $0.1。アラームを付けると、アカウントの無料枠が使われていれば最大 月 約 $1.2 が加わる（[docs/deploy.md](docs/deploy.md) の「費用の目安」）。

## Setup

前提: Node.js 22（`.nvmrc`）。

```sh
npm ci              # 依存関係を入れる
npm run dev         # ローカルで起動: dynalite + API（:8787）+ Vite（http://localhost:5173、/api /s /media をプロキシ）
npm test            # Unit / Integration（Vitest。shared・api・web・infra）
npm run build       # API の Lambda バンドル（apps/api/dist）と Web（apps/web/dist）
npm run test:e2e    # Critical User Flow の E2E（Playwright。tests/e2e/）
```

ほかに `npm run lint`（ESLint）、`npm run typecheck`（全ワークスペースの tsc）。CI（`.github/workflows/ci.yml`）は lint → typecheck → test → build → audit → E2E → CDK synth の順に実行する。

デプロイ（AWS）は [docs/deploy.md](docs/deploy.md)。初回は CDK bootstrap、`node scripts/setup-secrets.mjs`、費用配分タグ `Project` の有効化。以降は `PUBLIC_ORIGIN=https://<CloudFront のドメイン> ALERT_EMAIL=you@example.com npm run deploy`（ビルドのあと、`cdk deploy` の前に `setup-secrets.mjs --check` が SSM のパラメータを確かめる）。一般公開（LIVE）は CEO の承認が要る（Gate 7）。

## リポジトリの構成

```
packages/shared/   API の型・入力スキーマ（zod）・定数・日付・公式レシピ。Web と API が共用
apps/api/          API（Hono）。src/routes/ がルート、src/db/ が DynamoDB、src/reminder.ts が通知ジョブ
apps/web/          PWA（React）。src/pages/ が画面、src/lib/ が API クライアント・送信待ち（outbox）・状態
infra/             AWS CDK のスタック（lib/thirty-days-stack.ts）とテスト
tests/e2e/         Critical User Flow の E2E（Playwright）
scripts/           dev.mjs（ローカル起動）、e2e-server.mjs（E2E 用のローカル API と Web）、setup-secrets.mjs（SSM の秘密情報。作成・確認・入れ替え）
docs/              設計・デプロイ・検証計画・意思決定の記録
```

## Docs

| ファイル | 内容 |
|---|---|
| [PRODUCT.md](PRODUCT.md) | 課題・顧客・価値・Phase・作らないもの（Do Not Build） |
| [SPEC.md](SPEC.md) | 仕様・Critical User Flow・API・データモデル・完了の定義 |
| [docs/validation-plan.md](docs/validation-plan.md) | PILOT の計画と合格ライン（実施前に固定） |
| [docs/design.md](docs/design.md) | デザイン（白いノート）のトークン・コントラスト・部品・画面の並び |
| [docs/deploy.md](docs/deploy.md) | AWS へのデプロイ・秘密情報と入れ替え・アラーム・費用・ロールバック・片付け |
| [docs/test-plan.md](docs/test-plan.md) | テスト計画 |
| [docs/decisions/](docs/decisions/) | 意思決定の記録（ADR） |
| [ROADMAP.md](ROADMAP.md) | Now / Next / Later |
| [CHANGELOG.md](CHANGELOG.md) | 変更履歴 |
| [AGENTS.md](AGENTS.md) | AI エージェント向けのルールとコマンド |

着想: Matt Cutts「Try something new for 30 days」（TED2011） https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days
