# 30日だけ — Specification

| | |
|---|---|
| Version | v1.1 |
| Status | Accepted（Gate 3 判定は [docs/decisions/0002](docs/decisions/0002-full-service-on-aws.md)） |
| Last updated | 2026-10-07 |

API の型と入力検証は [`packages/shared/src/schemas.ts`](packages/shared/src/schemas.ts)、ルート一覧は [`packages/shared/src/api.ts`](packages/shared/src/api.ts) が正。この文書と食い違ったらコードを直すか、この文書を直す。

v1.1: Gate 5 の独立レビュー（2026-10-07）を受けた AI PM 決定 **D1〜D13** を反映した（記録は [docs/decisions/0004](docs/decisions/0004-gate5-review-fixes.md)）。本文の該当箇所に（D番号）を付けている。

| | 決定 | 主な節 |
|---|---|---|
| D1 | バックアップの読み込みに回数・件数の上限と、通常の操作と同じ検査。読み込んだものは本人が操作するまで1日組に出ない | FR-16, Security |
| D2 | 非表示のカード画像は `hidden/share/` へ移して配信しない。カード画像のキャッシュは5分 | FR-7, FR-18, Architecture, Data Model |
| D3 | 管理・通報で止めたカードを本人が作り直して公開できない | FR-7, FR-18 |
| D4 | 作成の開始日は今日の7日前〜翌日と次の1日を受け付ける（オフラインの作成の再送） | FR-3, API |
| D5 | PILOT の指標は人単位（開始した人・7日継続・完走・共有） | FR-18 |
| D6 | レート制限の IP キーは秘密鍵つきの HMAC-SHA256（鍵は SSM）。IPv6 は /64 で数える | Security, Data Model, Logging |
| D7 | 自動非表示に数える通報は、作成から24時間以上たち、チャレンジを持つアカウントからだけ | FR-18 |
| D8 | origin-verify は API が複数の値を受け付け、止めずに入れ替えられる | Architecture, Security |
| D9 | リマインドは EventBridge のイベントの予定時刻で枠を決め、古いイベントは捨てる | FR-14, Architecture |
| D10 | `/s/:id` に「このカードを通報する」 | FR-7, FR-18, UI |
| D11 | 重複のない人数でなければ「人」と表示しない | FR-8, FR-10 |
| D12 | お問い合わせの返信先（任意）は返信にだけ使い180日で消す。プライバシーポリシーもそう書く | FR-19, Data Model |
| D13 | 開始・投稿の前に同意の一文、全画面にフッター（規約などへのリンク） | FR-21, FR-22, UI |

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
5. 次に何をやるかは「ガチャ」か「ひらめき提案」で決める
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
| FR-3 | **チャレンジ**: 開始日は「今日」か「次の1日」（画面で選べるのはこの2つ）。API は、端末に溜めた作成が数日後に届く場合に備えて、今日の7日前〜翌日と次の1日を受け付ける（D4。それ以外は 400。溜めた印も一緒に失われないように）。同時に開いておけるのは5件まで。新しく始められるのは1人1日10件まで（`QUOTAS.challengesPerUserPerDay`、日本時間の日付。同じ `id` の再送は数えない。作っては消すことで「人気」の並びを水増しさせないため）。タイトル・印（1文字）を編集でき、開始前なら開始日を変えられる。削除できる（公開カードがあれば、その画像と公開ページも消える） |
| FR-4 | **1日1タップ記録**: 1〜「今日の日数」のマスに印を押せる（押し忘れた過去の日も押せる。未来は不可）。取り消し可。各日にひとこと（120字、本人だけに見える） |
| FR-5 | **写真メモ**: 各日に写真を1枚添えられる。写真は端末内（IndexedDB）だけに保存し、サーバに送らない。保存前に縮小・再エンコードし、位置情報などのメタデータを残さない |
| FR-6 | **振り返り**: 30日目以降、または7日目以降の「ここで区切る」で、判定（続ける／やめる／形を変える）とひとこと（140字）を決める。判定後は記録が確定（印は変えられない） |
| FR-7 | **振り返りカード**: 判定・印・タイトル・押せた日数・30マス・ひとことを描いた 1200×630 の PNG を端末で生成。画像保存、Web Share（画像つき）、X／LINE 共有リンク、公開リンク（`/s/:id`、OGP 付き）を作れる。公開リンクは本人が削除できる。公開ページとカード画像にはニックネームも出る（共有前の案内に書く）。カード画像は `Cache-Control: public, max-age=300` で配信し、削除・非表示から5分以内に CloudFront とブラウザから消える（無効化はしない。D2）。通報・管理で非表示や削除になったカード、1日組から外されたチャレンジのカードは、本人が作り直して公開できない（403。D3）。`/s/:id` には「このカードを通報する」があり、`/contact?report=share:<id>` でそのカードの通報フォームを開く（D10）。どの共有手段が使われたかだけを匿名で数える（`POST /api/metrics/share`） |
| FR-8 | **1日組（同期スタート）**: 同じ月に始めた人の一覧（ニックネーム・印・タイトル・ミニ30マス・応援数）。開始日が1日の人に「1日組」バッジ。次の1日の予約は、予約している人数（重複のない人数。`peopleCount`）とレシピ別の内訳（件数）。進捗公開は既定 ON、設定で OFF にすると一覧から消える。ひとことメモは公開しない。**画面で「N人」と出すのは重複のない人数だけ**。1人が複数持てるチャレンジの件数や、作成の回数を「人」と表示しない（D11） |
| FR-9 | **応援**: 他の人のチャレンジに1日1回「応援」できる。応援数だけを表示し、メッセージは送れない（DM 機能は作らない） |
| FR-10 | **レシピ**: 公式23本（端末に同梱、オフラインでも見られる）＋みんなのレシピ。検索、ジャンル絞り込み、並び替え（おすすめ・人気・新着）。「人気」は始められた回数（`startCount`。人数ではないので「N人」と表示しない。D11）。詳細に、やり方・30日後・体験談・「これを30日やる」 |
| FR-11 | **投稿**: レシピ（1日5件まで）と体験談（1日10件まで）を投稿・削除できる。公開テキストに URL は入れられない |
| FR-12 | **ガチャ**: 時間（5／15／30／60分以内・制限なし）・ジャンル・場所で絞って抽選。スロット風の演出（reduce-motion では省略）。結果からそのまま開始 |
| FR-13 | **ひらめき提案（お試し）**: ガチャ画面で条件（時間・ジャンル・場所）とひとこと（100字）を渡すと、オリジナル案を最大3つ返す。**AI は使わない**（CEO 決定 [ADR 0003](docs/decisions/0003-no-ai-mock-suggestions.md)）。サーバに内蔵した案（公式レシピとは別に約60本）から、条件で絞り、ひとことのキーワードとの一致で並べて選ぶ。画面に「いまは AI を使わず、ルールで選んでいます」と表示する。1人1日10回まで。結果はそのまま開始・レシピとして投稿できる（開始・投稿の画面には FR-22 の同意の一文が出る） |
| FR-14 | **リマインド**: Web Push。時刻（15分刻み）を設定すると、その時刻にまだ印を押していないチャレンジがあれば通知。iOS はホーム画面に追加した場合のみと案内。テスト通知ボタン。代替として Google カレンダーに毎日の予定を入れるリンクと .ics ダウンロード。ジョブ（15分ごと）は EventBridge のイベントの予定時刻（`time`）の枠を処理するので、遅れて届いても別の枠の人に送らない。15分より古いイベントは捨て、再試行しない（同じ通知を2回送らない。D9） |
| FR-15 | **記録**: 終わったチャレンジの一覧（判定バッジ・押せた日数・ひとこと）、合計（試した数・押した印の数・判定の内訳）、日ごとのメモ一覧 |
| FR-16 | **バックアップ**: JSON の書き出し・読み込み（読み込みは自分のアカウントにマージ）。ファイルは利用者の入力なので、読み込みにも通常の操作と同じ決まりを当てる（D1）: 1人1日3回まで（`QUOTAS.importsPerUserPerDay`、超えると 429）、1回100件まで（`LIMITS.importChallenges`）。新しく増えるチャレンジは、開いているもの5件（`LIMITS.openChallenges`）・1人合計200件（`LIMITS.challengesPerUser`）の範囲だけで、超えた分は読み込まない（`skipped` に数える）。中身は作成・印・振り返りと同じ規則で整える: 開始日は次の1日まで、印は「今日の日数 + 1」日目まで、振り返り済みは7日目以降で判定があるものだけ（それ以外は進行中として読み込む）、レシピは存在するものだけ、文字は投稿と同じ検証。読み込んだチャレンジ（`imported`）は、本人が印を押す・編集するなど通常の書き込みをするまで1日組に出ず、PILOT の指標にも数えない。管理で1日組から外したチャレンジは、消して読み込み直しても外れたまま |
| FR-17 | **データ削除**: 設定の「すべてのデータを削除」で、アカウント・チャレンジ・投稿・公開カード・通知登録を消す |
| FR-18 | **通報とモデレーション**: レシピ・体験談・公開カード（`/s/:id` の「このカードを通報する」。D10）・1日組の表示に「通報」。3人から通報で自動非表示。ただし数えるのは、作成から24時間以上たち（`REPORTER_MIN_ACCOUNT_AGE_HOURS`）、チャレンジを1件以上持つアカウントの通報だけ（使い捨ての匿名アカウントで隠せないように。それ以外の通報も記録して管理画面に出す。D7）。公開カードを非表示にすると、画像も `hidden/share/<id>.png` に移して配信をやめ、「復元」で戻す（D2）。管理画面（`/admin`、管理トークン）で一覧・非表示・復元・削除、おすすめ指定、統計、お問い合わせ閲覧。**削除**はレシピ・体験談・公開カードでは本当に消す。**1日組（member）の削除は本人の記録（印・メモ）を消さない**（AI PM 決定）: そのチャレンジを1日組の一覧から恒久的に外し（`hiddenFromCohort`、gsi1 を外す）、公開カードがあれば非表示にする。どの種類でも通報に削除済みの印（`deletedAt`）を付け、以後の「復元」は受け付けない（409）。止めたカードは本人が作り直して公開できない（D3）。統計には PILOT の指標を、[docs/validation-plan.md](docs/validation-plan.md) の定義どおり**人単位**で、いまあるチャレンジから集計して出す（D5）: 開始した人（`starters`、開始日が来たチャレンジを持つ人）、7日継続の分母（`eligible7`、最初に始めたチャレンジが8日目以降の人）と分子（`retained7`、そのうち1〜7日目に印5個以上のチャレンジを持つ人）、振り返った人（`reflected`）、共有した人（`sharers`、振り返り済みで公開カードがいまある人）。読み込んだチャレンジは数えない |
| FR-19 | **お問い合わせ**: フォーム。返信先（メールアドレスなど）は任意入力で、書かれたら返信のためだけに使い、内容とともに180日で消す（D12。プライバシーポリシーにもそう書く）。`?report=share:<id>` で開くと公開カードの通報フォームになる（FR-18）。管理画面で読む |
| FR-20 | **PWA**: ホーム画面に追加でき、オフラインでも「きょう」と公式レシピが開ける。オフライン中の操作は端末に溜め、復帰時に送る |
| FR-21 | **表示**: **ネオ・ブルータリズム**（太い黒線・ずらし影・フラットな原色・太い見出し。詳細は [docs/design.md](docs/design.md)）。ライト／ダーク（端末設定に追従、手動切替可）。スマホは下のタブバー、PC は上のタブ。すべての画面の下にフッター（このサービスについて・利用規約・プライバシーポリシー・お問い合わせ。D13）。30マスと朱色の印、方眼の背景は前回のアーティファクトから引き継ぐ |
| FR-22 | **静的ページ**: このサービスについて（TED へのクレジットとリンク）、利用規約、プライバシーポリシー。利用規約は「始めた・投稿した時点で同意」とするので、チャレンジの開始（「30日、始める」）とレシピ・体験談の投稿のボタンの近くに、規約とプライバシーポリシーへのリンクつきで「同意したことになります」の一文を出す（D13） |

## Non-functional Requirements

| 項目 | 基準 |
|---|---|
| コスト | AWS は月 $1 未満を目標（100人規模で約 $0.1。内訳は [docs/deploy.md](docs/deploy.md)）。AI は使わない。AWS Budgets で `Project=thirty-days` の費用が月 $10 を超えそうならメール通知（`alertEmail` 指定時。共用アカウントなので費用配分タグで絞る。タグを有効にするまでは $0 のままなので、アカウントに既存のアカウント全体の予算アラートが頼り） |
| 監視 | `alertEmail` 指定時にメール: API Gateway の 5xx が5分で5回以上（ルートの例外は 500 の応答になり Lambda の Errors に出ないため）、api Lambda の Errors が5分で5回以上、reminder の Errors が1時間に2回以上 |
| 性能 | API p95 < 500ms（コールドスタート除く）。初回表示 JS < 250KB gzip（フォント除く） |
| 可用性 | 個人の趣味サービスとして、障害時は「データを失わない」を優先（DynamoDB PITR 有効）。SLA なし |
| 対応環境 | iOS Safari 16.4+、Android Chrome、デスクトップの Chrome / Edge / Safari / Firefox 最新 |
| アクセシビリティ | ボタンに名前、フォーカス表示、コントラスト AA、`prefers-reduced-motion` 対応、タップ領域 44px 以上 |
| データ保持 | 引き継ぎコード 15分、レート制限カウンタ 2日、お問い合わせ（返信先を含む）180日、それ以外は本人が消すまで |

## Architecture

```
Browser (React PWA)
   │ https://<dist>.cloudfront.net   （独自ドメインは任意・後から）
CloudFront ─ /*        → S3 web bucket (OAC)      … SPA。CloudFront Function で拡張子なしのパスを /index.html へ
           ─ /api/*    → API Gateway HTTP API → Lambda "api" (Hono)
           ─ /s/*      → 同上（公開カードの HTML。OGP）
           ─ /media/*  → S3 media bucket (OAC)    … 公開カード画像。CloudFront Function が share/<id>.png 以外を 404 にする
EventBridge rule (15分ごと) → Lambda "reminder" → Web Push (VAPID)
Lambda "api" → DynamoDB（1テーブル, on-demand, PITR） / S3 media / SSM Parameter Store
```

- リージョン `ap-northeast-1`。IaC は AWS CDK（`infra/`、スタック `ThirtyDays`、説明「30日だけ (try_something_new)」）。AWS アカウントは他のプロジェクトと共用なので、HTTP API の名前は `ThirtyDaysApi`、全リソースに `Project=thirty-days` タグ。Lambda は Node.js 22 / arm64、esbuild で自前バンドル（`apps/api/build.mjs`）
- `/api/*` と `/s/*` には CloudFront Function（viewer-request）で `x-forwarded-host`（公開 URL の組み立て用）と `x-viewer-ip`（レート制限用）を付ける。オリジンには秘密ヘッダ `x-origin-verify` を付け、API は受け付ける値のどれとも一致しないリクエストを 403 にする（API Gateway の直接呼び出しを防ぐ）。CloudFront が送る値は SSM `/thirty-days/origin-verify-send`（1つ）、API が受け付ける値は `/thirty-days/origin-verify`（環境変数 `ORIGIN_VERIFY`、カンマ区切りで複数可）。入れ替えは「受け付ける値に新しい値を足す → 送る値を変える → 古い値を外す」の3回のデプロイで、止めずにできる（スタックは api 関数を CloudFront より先に更新する。手順は [docs/deploy.md](docs/deploy.md)。D8）
- `/media/*` は `share/<id>.png` だけを配信する。非表示にしたカードの画像を置く `hidden/share/` などは CloudFront Function が 404 を返す（D2）
- reminder の非同期呼び出しは再試行 0 回・イベントの最大経過時間 15分（EventBridge 側の再試行も15分まで。D9）
- キャッシュ: `/api/*` `/s/*` はキャッシュしない。`/assets/*` は 1年 immutable。`index.html` と `sw.js` は no-cache。カード画像（`/media/share/*`）は5分（D2）
- `index.html` の `og:image` / `twitter:image` は、ビルド時の環境変数 `PUBLIC_ORIGIN`（`https://<CloudFront のドメイン>`）で絶対 URL にする（デプロイ時に指定。無いと相対 URL のままで、CDK が警告を出す）
- セキュリティヘッダ（CloudFront Response Headers Policy）: CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`、HSTS、nosniff、Referrer-Policy `strict-origin-when-cross-origin`
- フォントは `@fontsource` で自己ホスト（Google Fonts へ外部送信しない）
- 秘密情報（VAPID 秘密鍵、管理トークン、IP のハッシュ鍵 `/thirty-days/ip-hash-key`）は SSM SecureString。`scripts/setup-secrets.mjs` で初回に作る（足りないものだけ作る。`--check` は `npm run deploy` の最初に確かめ、`--rotate` で入れ替える）。リポジトリ・CloudFormation テンプレートに秘密を書かない

### ローカル実行とテスト

- `npm run dev`: dynalite（インメモリ DynamoDB 互換）+ API（`@hono/node-server`, :8787）+ Vite（:5173、`/api` `/s` `/media` をプロキシ）
- ローカルでは媒体を `.local-data/media` に保存、VAPID 鍵は起動時に生成
- 課金される外部 API は使わない（AI なし）

## UI

| 画面 | パス | 状態 |
|---|---|---|
| きょう | `/` | 初回: ヒーロー＋3ステップ＋TED クレジット ／ 進行中: チャレンジカード（30マス・今日の印ボタン・予約中・終了） ／ 下に「次の1日組」予告 |
| レシピ一覧 | `/recipes` | 検索・ジャンル・並び替え・読み込み中・0件 |
| レシピ詳細 | `/recipes/:id` | やり方・30日後・体験談一覧・開始・体験談を書く・通報・（自分の投稿なら）削除 |
| レシピを書く | `/recipes/new` | フォーム、入力エラー、送信中 |
| ガチャ | `/gacha` | 条件チップ・回す・結果・ひらめき提案（お試し。読み込み中・残り回数・「AI は使っていません」の注記） |
| みんな | `/together` | 今月の組・次の1日組（予約）・先月の組。読み込み中・0人・エラー（再試行） |
| 記録 | `/log` | 合計・終わった30日・メモ一覧・0件 |
| チャレンジ詳細 | `/c/:id` | 30マス（日をタップでメモ・写真・押し忘れ）・編集・リマインド・削除・ここで区切る |
| 振り返り | `/c/:id/reflect` | 判定選択 → ひとこと → カード生成中 → 共有（画像保存・Web Share・X・LINE・リンク作成／削除） |
| 公開カード | `/s/:id` | サーバ生成 HTML。画像・タイトル・判定・ひとこと・「自分も30日やってみる」（同じレシピの開始へ）・「このカードを通報する」（`/contact?report=share:<id>`。D10） |
| 設定 | `/settings` | ニックネーム・進捗公開・リマインド（通知許可・時刻・テスト）・カレンダー・引き継ぎコード（発行／入力）・バックアップ・テーマ・データ削除・各ページへのリンク |
| このサービスについて／規約／プライバシー／お問い合わせ | `/about` `/terms` `/privacy` `/contact` | お問い合わせ: 内容・返信先（任意）。`?report=share:<id>` なら公開カードの通報 |
| 管理 | `/admin` | トークン入力・通報一覧・統計・お問い合わせ |

すべての画面で、読み込み中・エラー・空の状態を出す。オフライン時は上部に帯を出す。すべての画面の下にフッター（このサービスについて・利用規約・プライバシーポリシー・お問い合わせ。D13）。

## API

ルートと型は [`packages/shared/src/api.ts`](packages/shared/src/api.ts) と [`schemas.ts`](packages/shared/src/schemas.ts)。共通の約束:

- JSON のみ。`POST` `PUT` `PATCH` は `Content-Type: application/json` 必須（違えば 415）。リクエスト本文は 1MB まで（共有画像を含む）
- 認証: `Authorization: Bearer <token>`。トークンは 32 バイトの乱数（base64url）。サーバは SHA-256 だけを保存する
- エラー: `{ "error": { "code", "message", "fields?" } }`。400 bad_request / 401 unauthorized / 403 forbidden / 404 not_found / 409 conflict / 413 payload_too_large / 415 unsupported_media_type / 429 rate_limited / 503 ai_unavailable / 500 internal
- 日付の判定はユーザーのタイムゾーン（`tz`）での「今日」。端末とずれる場合に備えて、印は「今日の日数 + 1」まで受け付ける
- `POST /api/challenges` はクライアント生成の `id` で冪等（同じ `id` の再送は既存を返し、作成の上限 `QUOTAS.challengesPerUserPerDay` にも数えない。上限を超えた作成は 429）。開始日は今日の7日前〜翌日か次の1日（D4）。印の `PUT` / `DELETE` も冪等
- `POST /api/me/import` は1人1日3回まで（429）。件数と中身の決まりは FR-16（D1）
- `POST /api/shares` は、通報・管理で止めたカードやチャレンジでは 403（D3）
- Web クライアントは `POST` `PUT` `PATCH` に本文が無くても `{}` を `Content-Type: application/json` で送る（`apps/web/src/lib/http.ts`）
- 公開レスポンスにトークン・ユーザー ID・ひとことメモ・通知の登録情報を含めない

## Data Model

DynamoDB 1テーブル（`pk`, `sk`）＋ GSI 3つ（`gsi1pk/gsi1sk`, `gsi2pk/gsi2sk`, `gsi3pk/gsi3sk`）、TTL 属性 `ttl`。

| Item | pk | sk | GSI | 備考 |
|---|---|---|---|---|
| ユーザー | `USER#<uid>` | `PROFILE` | | nickname, tz, shareProgress, reminder |
| トークン | `TOKEN#<sha256>` | `TOKEN` | | userId。逆引き用に `USER#<uid>` / `TOKEN#<sha256>` も置く |
| チャレンジ | `USER#<uid>` | `CH#<chId>` | gsi1: `COHORT#<YYYY-MM>` / `<updatedAt13>#<chId>`（進捗公開 ON かつ非表示でなく、読み込んだままでないときだけ） | stamps は `{ "1": { at, note? } }`。hiddenFromCohort（通報・管理で1日組から外した）、moderated（管理・通報で止めた。カードを作り直せない。D3）、imported（バックアップから読み込んだまま。本人が書き込むと外れる。D1）、shareId（公開カード） |
| チャレンジ参照 | `CHREF#<chId>` | `REF` | gsi2: `AUTHOR#<uid>` / `CHREF#<chId>` | userId（応援・通報で使う）。チャレンジ本体が無くてもアカウント削除で見つかるように gsi2 を持つ |
| 応援の記録 | `CHEER#<chId>#<date>` | `BY#<uid>` | gsi2: `AUTHOR#<uid>` / `CHEER#<chId>#<date>` | TTL 2日。1日1回の判定。gsi2 は応援した人のアカウント削除用 |
| みんなのレシピ | `RECIPE#<rid>` | `META` | gsi1: `RECIPES` / `<createdAt13>#<rid>`（公開中のみ）; gsi2: `AUTHOR#<uid>` / `RECIPE#<rid>` | status: published / hidden |
| レシピの集計 | `RSTATS` | `<rid>` | | startCount, storyCount, featured（公式・みんな共通） |
| 体験談 | `RECIPE#<rid>` | `STORY#<createdAt13>#<sid>` | gsi2: `AUTHOR#<uid>` / `STORY#<rid>#<sid>` | |
| 公開カード | `SHARE#<sid>` | `META` | gsi2: `AUTHOR#<uid>` / `SHARE#<sid>` | 画像は S3 `share/<sid>.png`（`/media/share/<sid>.png` で公開、`Cache-Control: public, max-age=300`）。非表示の間は `hidden/share/<sid>.png`（配信しない。D2）。元のチャレンジを削除すると一緒に消える |
| 通知の登録 | `USER#<uid>` | `PUSH#<sha256(endpoint)>` | gsi3: `SLOT#<HH:MM UTC>` / `<uid>#<hash>`（リマインド ON のときだけ） | endpoint, keys |
| 引き継ぎコード | `TRANSFER#<code>` | `META` | | TTL 15分 |
| レート制限 | `RATE#<scope>#<key>#<window>` | `RATE` | | TTL 2日。IP 単位のキーは `HMAC-SHA256(/thirty-days/ip-hash-key, IPv4 アドレスまたは IPv6 の /64)`（D6） |
| 通報 | `REPORT#<type>#<id>` | `META` | gsi1: `REPORTS` / `<lastAt13>` | count（自動非表示に数える通報の数。D7）, reasons（直近10件）, deletedAt（管理画面で削除した。復元不可）。通報されていない対象を削除したときは gsi1 なしで作る（一覧には出ない） |
| 通報者 | `REPORT#<type>#<id>` | `BY#<uid>` | gsi2: `AUTHOR#<uid>` / `REPORT#<type>#<id>` | 同じ人の重複通報を数えない。gsi2 は通報した人のアカウント削除用 |
| お問い合わせ | `CONTACT#<id>` | `META` | gsi1: `CONTACTS` / `<createdAt13>` | message, replyTo（任意の返信先）。TTL 180日（D12） |
| 統計 | `STATS` | `GLOBAL` | | users, challengesStarted, challengesDone, verdict_*（判定を変えると移し替える）, communityRecipes, stories, shares（カードを作った回数。PILOT の共有率には使わない）, pushSubscriptions |

**保存しないもの**: アカウントのためのメールアドレス・電話番号、本名・位置情報・写真（写真は端末内のみ）・IP アドレス（レート制限のキーは IP から作った秘密鍵つきの HMAC-SHA256 を時間窓つきで保存し 2日で消える。鍵が無いと元の IP を総当たりで戻せない。D6）。

**個人に関する情報**: ニックネーム、チャレンジ内容、ひとこと、投稿、Push 購読（ブラウザのエンドポイント）、お問い合わせに任意で書かれた返信先（返信にだけ使い180日で消える。D12）。プライバシーポリシーに目的と削除方法を書く。

## Error Handling

| 状況 | 振る舞い |
|---|---|
| オフライン／API 5xx | 書き込みは端末の送信待ち（outbox）に入れて画面は先に更新。復帰時に順に再送（冪等なので重複しない）。4xx は再送せず、画面を元に戻してメッセージ。ただしチャレンジ削除への 404 は「もう無い」なので成功として扱う。送る前に作成と削除がそろった場合は、どちらも送らない |
| 401（トークン無効） | 端末のトークンを破棄し、引き継ぎコードでの復元を案内。ローカルの未送信データは書き出せる |
| 429 | 「今日はここまで」と残り回数・リセット時刻の目安を表示。送信待ちでは、すぐ解けない 429（作成の上限、1時間を超える `Retry-After`）は 4xx と同じく再送せず画面を戻す（後ろの書き込みを止めないため）。短い 429 は `Retry-After` を待って再送 |
| 提案の失敗 | 「提案を作れませんでした」を表示。通常のガチャは使える |
| 公開カードの画像アップロード失敗 | 端末内の共有（保存・Web Share・X・LINE）は使える |
| Push の配信先が 404/410 | その登録を削除 |

## Security

- 秘密: SSM SecureString（VAPID 秘密鍵・管理トークン・IP のハッシュ鍵）。Lambda 起動時に読み、メモリにだけ持つ。フロントに API キーは無い
- オリジンの確認: CloudFront が付ける `x-origin-verify` を API が確かめる。受け付ける値は複数持てるので、止めずに入れ替えられる（Architecture。D8）
- 入力検証: すべての入力を `schemas.ts` で検証（文字数は書記素単位で、変換前の長さにも上限。制御文字・双方向制御文字を除去、公開テキストは URL 禁止）。バックアップの読み込みも同じ検証と、作成・印・振り返りと同じ規則・上限を通す（FR-16。D1）
- 出力: React のエスケープに任せ、`dangerouslySetInnerHTML` を使わない。`/s/:id` の HTML はサーバで全項目を HTML エスケープ
- ひらめき提案: 内蔵データから選ぶだけ。ユーザーの「ひとこと」はキーワード照合にだけ使い、保存しない
- 認可: チャレンジ・投稿・カード・通知登録は本人だけが変更・削除できる。管理 API は `X-Admin-Token`（定数時間比較）
- レート制限: [`QUOTAS`](packages/shared/src/constants.ts)。API Gateway のステージ全体でも 20 rps / burst 40。IP ごとの上限（セッション作成・引き継ぎコードの入力・匿名のお問い合わせ・共有の計測）は、IPv4 はアドレス、IPv6 は /64 を1人と数える（1台の VPS や家庭の回線でも /64 以上を持つため）。キーは秘密鍵つきの HMAC-SHA256（鍵は SSM `/thirty-days/ip-hash-key`、api だけが読める。D6）
- 通報の重み: 自動非表示に数えるのは、作成から24時間以上たち、チャレンジを持つアカウントの通報だけ（FR-18。D7）
- 公開カードの画像: 配信するのは `share/<id>.png` だけ。非表示にしたら公開の場所から移す（D2）
- Push の宛先: 既知のプッシュサービス（`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`）の https だけを受け付ける（SSRF 対策）
- 共有画像: PNG のシグネチャと 1200×630 を検証、600KB まで。`Content-Type: image/png` 固定で保存
- 依存関係: `npm audit --omit=dev` を CI で確認（high 以上で失敗）
- CSRF: Cookie を使わない（Bearer トークン）ので対象外。CORS は許可しない（同一オリジンのみ）

## Logging

- 構造化 JSON ログ（level, msg, route, status, ms）。トークン・ひとこと・投稿本文・Push の宛先・IP（とその HMAC）・お問い合わせの返信先を出さない。ユーザーは ID の先頭6文字だけ
- 5xx の応答は `level: "error"` で出す。アラームは API Gateway の 5xx の数で見る（NFR「監視」）
- リマインドは1回の実行ごとに件数だけ（`reminder run`: 枠・登録数・送った人数・失敗・エラーなど）を出す。1人ずつの失敗は `warn`
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
