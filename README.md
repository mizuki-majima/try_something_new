# 30日だけ

新しいことを **30日だけ** 試して、30日目に「続ける／やめる／形を変える」を自分で決める Web サービス（PWA）。
TED「Try something new for 30 days」（Matt Cutts）の考え方を、誰でもすぐ試せる形にしたもの。習慣化アプリではなく「お試し」のためのサービスで、やめることも成果として扱う。

- 公開 URL: https://d1zw3n37kpuo7t.cloudfront.net
- 現在の Phase: **BUILD**（次は Gate 4 → REVIEW）。何を作り、何を作らないかは [PRODUCT.md](PRODUCT.md)、仕様は [SPEC.md](SPEC.md)

## できること

- **レシピ**から選んで、今日から／次の1日から始める（公式23本＋みんなのレシピ）
- 毎日1タップで、30マスのカードに **印**（漢字1文字）を押す。ひとことメモ、端末内だけの写真メモ
- 同じ月に始めた人の **1日組** が並び、応援できる（メッセージは送れない）
- 30日目（7日目以降なら途中でも）に振り返り、**振り返りカード**（画像と公開ページ）を作る
- 次にやることは **ガチャ** か **ひらめき提案（お試し）** で決める。提案は AI を使わず、内蔵の案からルールで選ぶ（[ADR 0003](docs/decisions/0003-no-ai-mock-suggestions.md)）
- Web Push のリマインド、引き継ぎコード、バックアップ、通報と管理画面

アカウントはメール不要の匿名アカウント。料金・広告はない（趣味のサービス。[ADR 0001](docs/decisions/0001-hobby-service-skip-payment-validation.md)）。

## 構成

| 層 | 使っているもの |
|---|---|
| Web | React 19 + React Router、Vite、PWA（vite-plugin-pwa、Service Worker）。デザインはネオ・ブルータリズム（[docs/design.md](docs/design.md)） |
| API | Hono（TypeScript）を AWS Lambda（Node.js 22 / arm64）で動かす。入力検証は zod（`packages/shared` のスキーマを Web と共用） |
| データ | DynamoDB 1テーブル（オンデマンド、PITR）。ローカルとテストは dynalite（Java / Docker 不要） |
| 配信 | CloudFront → S3（Web）／API Gateway HTTP API `ThirtyDaysApi`（`/api/*` `/s/*`）／S3（公開カード画像 `/media/*`） |
| 通知 | EventBridge（15分ごと）→ Lambda → Web Push（VAPID） |
| IaC | AWS CDK（`infra/`、スタック `ThirtyDays`、リージョン `ap-northeast-1`） |

生成 AI・課金される外部 API は使わない。AWS 費用は月 $1 未満が目標（[SPEC.md](SPEC.md) の Non-functional Requirements）。

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

デプロイ（AWS）は [docs/deploy.md](docs/deploy.md)。初回は CDK bootstrap と `node scripts/setup-secrets.mjs`、以降は `ALERT_EMAIL=you@example.com npm run deploy`。

## リポジトリの構成

```
packages/shared/   API の型・入力スキーマ（zod）・定数・日付・公式レシピ。Web と API が共用
apps/api/          API（Hono）。src/routes/ がルート、src/db/ が DynamoDB、src/reminder.ts が通知ジョブ
apps/web/          PWA（React）。src/pages/ が画面、src/lib/ が API クライアント・送信待ち（outbox）・状態
infra/             AWS CDK のスタック（lib/thirty-days-stack.ts）とテスト
tests/e2e/         Critical User Flow の E2E（Playwright）
scripts/           dev.mjs（ローカル起動）、setup-secrets.mjs（SSM の秘密情報）
docs/              設計・デプロイ・検証計画・意思決定の記録
```

## Docs

| ファイル | 内容 |
|---|---|
| [PRODUCT.md](PRODUCT.md) | 課題・顧客・価値・Phase・作らないもの（Do Not Build） |
| [SPEC.md](SPEC.md) | 仕様・Critical User Flow・API・データモデル・完了の定義 |
| [docs/validation-plan.md](docs/validation-plan.md) | PILOT の計画と合格ライン（実施前に固定） |
| [docs/design.md](docs/design.md) | デザイン（ネオ・ブルータリズム）のトークンと原則 |
| [docs/deploy.md](docs/deploy.md) | AWS へのデプロイ・秘密情報・ロールバック・片付け |
| [docs/test-plan.md](docs/test-plan.md) | テスト計画 |
| [docs/decisions/](docs/decisions/) | 意思決定の記録（ADR） |
| [ROADMAP.md](ROADMAP.md) | Now / Next / Later |
| [CHANGELOG.md](CHANGELOG.md) | 変更履歴 |
| [AGENTS.md](AGENTS.md) | AI エージェント向けのルールとコマンド |

着想: Matt Cutts「Try something new for 30 days」（TED2011） https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days
