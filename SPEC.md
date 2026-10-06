# 30日だけ — Specification

| | |
|---|---|
| Version | v1 |
| Status | Accepted（Gate 3 判定は [docs/decisions/0002](docs/decisions/0002-full-service-on-aws.md)） |
| Last updated | 2026-10-06 |

API の型と入力検証は [`packages/shared/src/schemas.ts`](packages/shared/src/schemas.ts)、ルート一覧は [`packages/shared/src/api.ts`](packages/shared/src/api.ts) が正。この文書と食い違ったらコードを直すか、この文書を直す。

## Goal

TED「Try something new for 30 days」（Matt Cutts）の考え方を、誰でもすぐ試せる形にする。**習慣化アプリではなく「お試し」のためのサービス**。30日で区切り、続ける／やめる／形を変えるを自分で決める。やめることも成果として扱う。

## Target User

- 新しいことを試したいが、1人だと途中で消えてしまう人（最初は Mizuki の友人・同僚 10人前後）
- 何をやるか決められない人（レシピとガチャで決める）
- スマホ中心。PC でも使える

## User Story

1. レシピを眺めて「これを30日やる」を押し、今日から、または次の1日から始める
2. 毎日1タップで30マスのカードに印（漢字1文字）を押す。一言メモも残せる
3. 同じ月に始めた人（1日組）の進捗が並んで見え、応援できる
4. 30日目（7日目以降なら途中でも）に「続ける／やめる／形を変える」を選び、シェア用カードを作る
5. 次に何をやるかは「ガチャ」か AI の提案で決める
6. 自分の体験をレシピや体験談として残し、次の人が使う

## Critical User Flow

壊れていたらリリース禁止。E2E は `tests/e2e/`、ローカルの API（dynalite）と本番ビルドの Web で CI ごとに実行する。

**CUF-1: レシピから始めて、印を押す**

| # | ステップ | 期待結果 | 自動テスト |
|---|---|---|---|
| 1 | 初回訪問で `/` を開く | ヒーロー「どうせ過ぎる30日なら…」と「レシピから選ぶ」が見える | e2e `cuf1-start-and-stamp` |
| 2 | レシピ一覧 → 「毎日1枚、写真を撮る」を開く | やり方・30日後・「これを30日やる」が見える | 同上 |
| 3 | 「これを30日やる」→「今日から」→ ニックネーム入力 →「30日、始める」 | `/` にカード（印「写」、1日目、0/30）が出る | 同上 |
| 4 | 「きょう（1日目）の分を押す」 | 1マス目に印、1/30。ひとこと入力欄が出る | 同上 |
| 5 | ページを再読み込み | 印が残っている（サーバに保存済み） | 同上 |
| E | API が落ちている／オフライン | 印は画面に残り「オフライン・あとで同期」表示。復帰後に同期される | e2e `cuf1-offline-stamp` |

**CUF-2: 30日目に振り返り、カードを公開する**

| # | ステップ | 期待結果 | 自動テスト |
|---|---|---|---|
| 1 | 30日前に始めたチャレンジ（API で用意）がある状態で `/` | 「30日が終わりました」と「振り返る」 | e2e `cuf2-reflect-and-share` |
| 2 | 「振り返る」→「続ける」→ ひとこと →「決める」 | シェア用カード画像（1200×630）がプレビューされる | 同上 |
| 3 | 「リンクを作って共有」 | `/s/<id>` の URL が出る。開くとタイトル・印・判定・ひとことと「自分も30日やってみる」が見え、`og:image` が画像を指す | 同上 |
| 4 | 「記録」タブ | 終わったチャレンジに判定バッジ「続ける」 | 同上 |
| E | 画像のアップロードに失敗 | 「画像を保存」「Xで共有」など端末内の共有手段は使える。エラー表示 | unit `share-card` |

**CUF-3: 1日組で並んで、応援する**

| # | ステップ | 期待結果 | 自動テスト |
|---|---|---|---|
| 1 | ユーザー A が今月開始のチャレンジを持ち、進捗公開 ON | — | e2e `cuf3-cohort-cheer` |
| 2 | ユーザー B（別ブラウザ）が「みんな」タブを開く | A のニックネーム・印・ミニ30マスが今月の組に出る | 同上 |
| 3 | B が A に「応援」 | 応援数が 1 増え、同じ日にもう一度は押せない | 同上 |
| 4 | A が進捗公開を OFF | B の一覧から A が消える | 同上 |
| E | 一覧の取得に失敗 | エラー表示と再試行ボタン。他のタブは使える | unit |

## Functional Requirements

| ID | 要件 |
|---|---|
| FR-1 | **アカウント**: メール不要の匿名アカウント。最初に書き込む操作（開始・投稿など）で `POST /api/session` を呼び、トークンを端末に保存。閲覧（レシピ・みんな・ガチャ）はアカウント不要 |
| FR-2 | **端末の引き継ぎ**: 設定で8文字の引き継ぎコード（15分有効・1回限り）を発行し、別端末で入力すると同じアカウントで使える |
| FR-3 | **チャレンジ**: 開始日は「今日」か「次の1日」。同時に開いておけるのは5件まで。タイトル・印（1文字）を編集でき、開始前なら開始日を変えられる。削除できる |
| FR-4 | **1日1タップ記録**: 1〜「今日の日数」のマスに印を押せる（押し忘れた過去の日も押せる。未来は不可）。取り消し可。各日にひとこと（120字、本人だけに見える） |
| FR-5 | **写真メモ**: 各日に写真を1枚添えられる。写真は端末内（IndexedDB）だけに保存し、サーバに送らない。保存前に縮小・再エンコードし、位置情報などのメタデータを残さない |
| FR-6 | **振り返り**: 30日目以降、または7日目以降の「ここで区切る」で、判定（続ける／やめる／形を変える）とひとこと（140字）を決める。判定後は記録が確定（印は変えられない） |
| FR-7 | **振り返りカード**: 判定・印・タイトル・押せた日数・30マス・ひとことを描いた 1200×630 の PNG を端末で生成。画像保存、Web Share（画像つき）、X／LINE 共有リンク、公開リンク（`/s/:id`、OGP 付き）を作れる。公開リンクは本人が削除できる。どの共有手段が使われたかだけを匿名で数える（`POST /api/metrics/share`、PILOT の共有率の計測用） |
| FR-8 | **1日組（同期スタート）**: 同じ月に始めた人の一覧（ニックネーム・印・タイトル・ミニ30マス・応援数）。開始日が1日の人に「1日組」バッジ。次の1日に予約中の人数とレシピ別の内訳。進捗公開は既定 ON、設定で OFF にすると一覧から消える。ひとことメモは公開しない |
| FR-9 | **応援**: 他の人のチャレンジに1日1回「応援」できる。応援数だけを表示し、メッセージは送れない（DM 機能は作らない） |
| FR-10 | **レシピ**: 公式23本（端末に同梱、オフラインでも見られる）＋みんなのレシピ。検索、ジャンル絞り込み、並び替え（おすすめ・人気・新着）。詳細に、やり方・30日後・体験談・「これを30日やる」 |
| FR-11 | **投稿**: レシピ（1日5件まで）と体験談（1日10件まで）を投稿・削除できる。公開テキストに URL は入れられない |
| FR-12 | **ガチャ**: 時間（5／15／30／60分以内・制限なし）・ジャンル・場所で絞って抽選。スロット風の演出（reduce-motion では省略）。結果からそのまま開始 |
| FR-13 | **AI 案**: ガチャ画面で条件とひとこと（100字）を渡すと AI がオリジナル案を最大3つ返す。1人1日3回、全体で1日20回まで。AI が使えないときはボタンを無効にし理由を表示。案は検証してから表示し、そのまま開始・レシピとして投稿できる |
| FR-14 | **リマインド**: Web Push。時刻（15分刻み）を設定すると、その時刻にまだ印を押していないチャレンジがあれば通知。iOS はホーム画面に追加した場合のみと案内。テスト通知ボタン。代替として Google カレンダーに毎日の予定を入れるリンクと .ics ダウンロード |
| FR-15 | **記録**: 終わったチャレンジの一覧（判定バッジ・押せた日数・ひとこと）、合計（試した数・押した印の数・判定の内訳）、日ごとのメモ一覧 |
| FR-16 | **バックアップ**: JSON の書き出し・読み込み（読み込みは自分のアカウントにマージ） |
| FR-17 | **データ削除**: 設定の「すべてのデータを削除」で、アカウント・チャレンジ・投稿・公開カード・通知登録を消す |
| FR-18 | **通報とモデレーション**: レシピ・体験談・公開カード・1日組の表示に「通報」。3人から通報で自動非表示。管理画面（`/admin`、管理トークン）で一覧・非表示・復元・削除、おすすめ指定、統計、お問い合わせ閲覧 |
| FR-19 | **お問い合わせ**: フォーム（返信先は任意入力）。管理画面で読む |
| FR-20 | **PWA**: ホーム画面に追加でき、オフラインでも「きょう」と公式レシピが開ける。オフライン中の操作は端末に溜め、復帰時に送る |
| FR-21 | **表示**: ライト／ダーク（端末設定に追従、手動切替可）。スマホは下のタブバー、PC は上のタブ。方眼紙の背景、朱色の印（前回のアーティファクトのデザインを踏襲） |
| FR-22 | **静的ページ**: このサービスについて（TED へのクレジットとリンク）、利用規約、プライバシーポリシー |

## Non-functional Requirements

| 項目 | 基準 |
|---|---|
| コスト | AWS は月 $5 以内を目標（100人規模）。AI は全体で1日20回まで（Claude Opus 5.5 で最悪でも月 $20 弱、通常は月 $1 未満。Haiku 4.5 に切り替えると約1/4）。AWS Budgets で月 $10 超過をメール通知（`alertEmail` 指定時） |
| 性能 | API p95 < 500ms（コールドスタート除く）。初回表示 JS < 250KB gzip（フォント除く） |
| 可用性 | 個人の趣味サービスとして、障害時は「データを失わない」を優先（DynamoDB PITR 有効）。SLA なし |
| 対応環境 | iOS Safari 16.4+、Android Chrome、デスクトップの Chrome / Edge / Safari / Firefox 最新 |
| アクセシビリティ | ボタンに名前、フォーカス表示、コントラスト AA、`prefers-reduced-motion` 対応、タップ領域 44px 以上 |
| データ保持 | 引き継ぎコード 15分、レート制限カウンタ 2日、お問い合わせ 180日、それ以外は本人が消すまで |

## Architecture

```
Browser (React PWA)
   │ https://<dist>.cloudfront.net   （独自ドメインは任意・後から）
CloudFront ─ /*        → S3 web bucket (OAC)      … SPA。CloudFront Function で拡張子なしのパスを /index.html へ
           ─ /api/*    → API Gateway HTTP API → Lambda "api" (Hono)
           ─ /s/*      → 同上（公開カードの HTML。OGP）
           ─ /media/*  → S3 media bucket (OAC)    … 公開カード画像
EventBridge rule (15分ごと) → Lambda "reminder" → Web Push (VAPID)
Lambda "api" → DynamoDB（1テーブル, on-demand, PITR） / S3 media / SSM Parameter Store / Amazon Bedrock (Claude)
```

- リージョン `ap-northeast-1`。IaC は AWS CDK（`infra/`）。Lambda は Node.js 22 / arm64、esbuild で自前バンドル（`apps/api/build.mjs`）
- `/api/*` と `/s/*` には CloudFront Function（viewer-request）で `x-forwarded-host`（公開 URL の組み立て用）と `x-viewer-ip`（レート制限用）を付ける。オリジンには秘密ヘッダ `x-origin-verify` を付け、API は一致しないリクエストを 403 にする（API Gateway の直接呼び出しを防ぐ）
- キャッシュ: `/api/*` `/s/*` はキャッシュしない。`/assets/*` は 1年 immutable。`index.html` と `sw.js` は no-cache
- セキュリティヘッダ（CloudFront Response Headers Policy）: CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`、HSTS、nosniff、Referrer-Policy `strict-origin-when-cross-origin`
- フォントは `@fontsource` で自己ホスト（Google Fonts へ外部送信しない）
- 秘密情報（VAPID 秘密鍵、管理トークン）は SSM SecureString。`scripts/setup-secrets.mjs` で初回に作る。リポジトリ・CloudFormation テンプレートに秘密を書かない

### ローカル実行とテスト

- `npm run dev`: dynalite（インメモリ DynamoDB 互換）+ API（`@hono/node-server`, :8787）+ Vite（:5173、`/api` `/s` `/media` をプロキシ）
- ローカルでは媒体を `.local-data/media` に保存、AI は `AI_PROVIDER=mock`、VAPID 鍵は起動時に生成
- 課金 API（Bedrock）はテスト・CI で呼ばない

## UI

| 画面 | パス | 状態 |
|---|---|---|
| きょう | `/` | 初回: ヒーロー＋3ステップ＋TED クレジット ／ 進行中: チャレンジカード（30マス・今日の印ボタン・予約中・終了） ／ 下に「次の1日組」予告 |
| レシピ一覧 | `/recipes` | 検索・ジャンル・並び替え・読み込み中・0件 |
| レシピ詳細 | `/recipes/:id` | やり方・30日後・体験談一覧・開始・体験談を書く・通報・（自分の投稿なら）削除 |
| レシピを書く | `/recipes/new` | フォーム、入力エラー、送信中 |
| ガチャ | `/gacha` | 条件チップ・回す・結果・AI 案（読み込み中・残り回数・使えない理由） |
| みんな | `/together` | 今月の組・次の1日組（予約）・先月の組。読み込み中・0人・エラー（再試行） |
| 記録 | `/log` | 合計・終わった30日・メモ一覧・0件 |
| チャレンジ詳細 | `/c/:id` | 30マス（日をタップでメモ・写真・押し忘れ）・編集・リマインド・削除・ここで区切る |
| 振り返り | `/c/:id/reflect` | 判定選択 → ひとこと → カード生成中 → 共有（画像保存・Web Share・X・LINE・リンク作成／削除） |
| 公開カード | `/s/:id` | サーバ生成 HTML。画像・タイトル・判定・ひとこと・「自分も30日やってみる」（同じレシピの開始へ） |
| 設定 | `/settings` | ニックネーム・進捗公開・リマインド（通知許可・時刻・テスト）・カレンダー・引き継ぎコード（発行／入力）・バックアップ・テーマ・データ削除・各ページへのリンク |
| このサービスについて／規約／プライバシー／お問い合わせ | `/about` `/terms` `/privacy` `/contact` | |
| 管理 | `/admin` | トークン入力・通報一覧・統計・お問い合わせ |

すべての画面で、読み込み中・エラー・空の状態を出す。オフライン時は上部に帯を出す。

## API

ルートと型は [`packages/shared/src/api.ts`](packages/shared/src/api.ts) と [`schemas.ts`](packages/shared/src/schemas.ts)。共通の約束:

- JSON のみ。`POST` `PUT` `PATCH` は `Content-Type: application/json` 必須（違えば 415）。リクエスト本文は 1MB まで（共有画像を含む）
- 認証: `Authorization: Bearer <token>`。トークンは 32 バイトの乱数（base64url）。サーバは SHA-256 だけを保存する
- エラー: `{ "error": { "code", "message", "fields?" } }`。400 bad_request / 401 unauthorized / 403 forbidden / 404 not_found / 409 conflict / 413 payload_too_large / 415 unsupported_media_type / 429 rate_limited / 503 ai_unavailable / 500 internal
- 日付の判定はユーザーのタイムゾーン（`tz`）での「今日」。端末とずれる場合に備えて、印は「今日の日数 + 1」まで受け付ける
- `POST /api/challenges` はクライアント生成の `id` で冪等（同じ `id` の再送は既存を返す）。印の `PUT` / `DELETE` も冪等
- AI（課金 API）を呼ぶ `POST /api/ai/suggest` はタイムアウトしても自動で再試行しない（クライアント・サーバとも）
- 公開レスポンスにトークン・ユーザー ID・ひとことメモ・通知の登録情報を含めない

## Data Model

DynamoDB 1テーブル（`pk`, `sk`）＋ GSI 3つ（`gsi1pk/gsi1sk`, `gsi2pk/gsi2sk`, `gsi3pk/gsi3sk`）、TTL 属性 `ttl`。

| Item | pk | sk | GSI | 備考 |
|---|---|---|---|---|
| ユーザー | `USER#<uid>` | `PROFILE` | | nickname, tz, shareProgress, reminder |
| トークン | `TOKEN#<sha256>` | `TOKEN` | | userId。逆引き用に `USER#<uid>` / `TOKEN#<sha256>` も置く |
| チャレンジ | `USER#<uid>` | `CH#<chId>` | gsi1: `COHORT#<YYYY-MM>` / `<updatedAt13>#<chId>`（進捗公開 ON かつ非表示でないときだけ） | stamps は `{ "1": { at, note? } }` |
| チャレンジ参照 | `CHREF#<chId>` | `REF` | | userId（応援・通報で使う） |
| 応援の記録 | `CHEER#<chId>#<date>` | `BY#<uid>` | | TTL 2日。1日1回の判定 |
| みんなのレシピ | `RECIPE#<rid>` | `META` | gsi1: `RECIPES` / `<createdAt13>#<rid>`（公開中のみ）; gsi2: `AUTHOR#<uid>` / `RECIPE#<rid>` | status: published / hidden |
| レシピの集計 | `RSTATS` | `<rid>` | | startCount, storyCount, featured（公式・みんな共通） |
| 体験談 | `RECIPE#<rid>` | `STORY#<createdAt13>#<sid>` | gsi2: `AUTHOR#<uid>` / `STORY#<rid>#<sid>` | |
| 公開カード | `SHARE#<sid>` | `META` | gsi2: `AUTHOR#<uid>` / `SHARE#<sid>` | 画像は S3 `share/<sid>.png` |
| 通知の登録 | `USER#<uid>` | `PUSH#<sha256(endpoint)>` | gsi3: `SLOT#<HH:MM UTC>` / `<uid>#<hash>`（リマインド ON のときだけ） | endpoint, keys |
| 引き継ぎコード | `TRANSFER#<code>` | `META` | | TTL 15分 |
| レート制限 | `RATE#<scope>#<key>#<window>` | `RATE` | | TTL 2日 |
| 通報 | `REPORT#<type>#<id>` | `META` | gsi1: `REPORTS` / `<lastAt13>` | count, reasons（直近10件） |
| 通報者 | `REPORT#<type>#<id>` | `BY#<uid>` | | 同じ人の重複通報を数えない |
| お問い合わせ | `CONTACT#<id>` | `META` | gsi1: `CONTACTS` / `<createdAt13>` | TTL 180日 |
| 統計 | `STATS` | `GLOBAL` | | users, challengesStarted, challengesDone, verdict_*, communityRecipes, stories, shares, pushSubscriptions |

**保存しないもの**: メールアドレス・電話番号・本名・位置情報・写真（写真は端末内のみ）・IP アドレス（レート制限のキーは IP の SHA-256 を時間窓つきで保存し 2日で消える）。

**個人に関する情報**: ニックネーム、チャレンジ内容、ひとこと、投稿、Push 購読（ブラウザのエンドポイント）。プライバシーポリシーに目的と削除方法を書く。

## Error Handling

| 状況 | 振る舞い |
|---|---|
| オフライン／API 5xx | 書き込みは端末の送信待ち（outbox）に入れて画面は先に更新。復帰時に順に再送（冪等なので重複しない）。4xx は再送せず、画面を元に戻してメッセージ |
| 401（トークン無効） | 端末のトークンを破棄し、引き継ぎコードでの復元を案内。ローカルの未送信データは書き出せる |
| 429 | 「今日はここまで」と残り回数・リセット時刻の目安を表示 |
| AI の失敗 | 1回だけ表示「AI 案を作れませんでした」。自動再試行しない。通常のガチャは使える |
| 公開カードの画像アップロード失敗 | 端末内の共有（保存・Web Share・X・LINE）は使える |
| Push の配信先が 404/410 | その登録を削除 |

## Security

- 秘密: SSM SecureString（VAPID 秘密鍵・管理トークン）。Lambda 起動時に読み、メモリにだけ持つ。フロントに API キーは無い（AI は Lambda から IAM で Bedrock を呼ぶ）
- 入力検証: すべての入力を `schemas.ts` で検証（文字数は書記素単位、制御文字・双方向制御文字を除去、公開テキストは URL 禁止）
- 出力: React のエスケープに任せ、`dangerouslySetInnerHTML` を使わない。`/s/:id` の HTML はサーバで全項目を HTML エスケープ
- AI 出力: スキーマ検証に通ったものだけを返す。ユーザーの「ひとこと」はプロンプト内で引用として扱い、指示として解釈しないよう明示。ツールは持たせない
- 認可: チャレンジ・投稿・カード・通知登録は本人だけが変更・削除できる。管理 API は `X-Admin-Token`（定数時間比較）
- レート制限: [`QUOTAS`](packages/shared/src/constants.ts)。API Gateway のステージ全体でも 20 rps / burst 40
- Push の宛先: 既知のプッシュサービス（`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`）の https だけを受け付ける（SSRF 対策）
- 共有画像: PNG のシグネチャと 1200×630 を検証、600KB まで。`Content-Type: image/png` 固定で保存
- 依存関係: `npm audit --omit=dev` を CI で確認（high 以上で失敗）
- CSRF: Cookie を使わない（Bearer トークン）ので対象外。CORS は許可しない（同一オリジンのみ）

## Logging

- 構造化 JSON ログ（level, msg, route, status, ms）。トークン・ひとこと・投稿本文・Push の宛先・IP を出さない。ユーザーは ID の先頭6文字だけ
- AI 呼び出しは入力・出力トークン数と概算コストを出す
- ロググループの保持は 14日

## Out of Scope

- メール・LINE での通知（LINE Notify は終了済み。将来やるなら Messaging API）
- メール／SNS ログイン、パスワード
- ユーザー間のメッセージ・コメント（応援数のみ）
- 写真のサーバ保存・公開
- 課金・広告
- 多言語（日本語のみ）
- ネイティブアプリ

## Definition of Done

1. 紐づく Issue の Acceptance Criteria をすべて満たす
2. Lint・型・Unit / Integration・Build・CUF の E2E が通る（CI 緑）
3. Developer 以外の AI Reviewer がレビューし、Critical / High が残っていない
4. 振る舞いが変わる場合は SPEC.md・README.md・CHANGELOG.md を更新
5. PRODUCT.md の Do Not Build に触れていない
