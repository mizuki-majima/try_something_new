# Test Plan — 30日だけ

Owner: AI QA ／ 対象: SPEC v1.3 ／ 最終更新: 2026-10-07

方針: MVP では Critical User Flow（CUF）を最優先。網羅より「CUF が壊れたら必ず CI が赤になる」こと。次に過去の不具合の回帰、最後にエッジケース。課金される外部 API はどのテストからも呼ばない（このサービスには AI も課金 API も無い。[ADR 0003](decisions/0003-no-ai-mock-suggestions.md)）。

## テストレベル

| レベル | 対象 | ツール | 場所 | 実行 |
|---|---|---|---|---|
| Unit | 共有ロジック（日付・文字数・スキーマ） | Vitest | `packages/shared/test/` | CI（`npm test`） |
| Unit | Web のロジックと画面（store・outbox・共有カード・各ページ） | Vitest + jsdom + Testing Library | `apps/web/test/` | CI（`npm test`） |
| Integration | API の全ルート・DB・リマインドジョブ（DynamoDB は dynalite、S3 / SSM / Web Push はモック） | Vitest + dynalite + aws-sdk-client-mock | `apps/api/test/` | CI（`npm test`） |
| Integration | インフラ（CDK テンプレートの検証。CloudFront Function のコードも実行して確認。DynamoDB のスループットの上限とスロットルのアラーム、アラームが API の使う DynamoDB の操作をすべて含むこと）と `scripts/setup-secrets.mjs` の入れ替え・確認のロジック（origin-verify の手順 3 がデプロイ済みの CloudFront を確かめること。AWS CLI はモック） | Vitest + aws-cdk-lib/assertions | `infra/test/` | CI（`npm test`） |
| E2E | CUF-1〜3 と全画面のスモーク。本番ビルドの Web + ローカル API | Playwright（Chromium。`mobile` 390×844 タッチ / `desktop` 1280×800） | `tests/e2e/` | CI（`npm run test:e2e`） |
| Live smoke | デプロイ後の実環境で CUF・Web Push・OGP | 手動（下のチェックリスト） | 本書 | 初回公開前・インフラ変更後・リリースごと |

### E2E の仕組み

- `npm run test:e2e` = `npm run build -w apps/web && playwright test`。CI と同じく**本番ビルド**（`apps/web/dist`）を試す
- `playwright.config.ts` の `webServer` が `scripts/e2e-server.mjs` を起動する: ローカル API（`apps/api/src/local.ts` の `startLocal`、毎回まっさらなインメモリ dynalite、一時ディレクトリの媒体置き場）を `127.0.0.1:8787` に、`vite preview` を `127.0.0.1:4173` に立て、`/api` `/s` `/media` を API へプロキシする（本番の CloudFront と同じ形）。SIGTERM / SIGINT で両方を止め、一時ディレクトリを消す
- ブラウザのタイムゾーンは `Asia/Tokyo`、ロケール `ja-JP`。「今日」「何日目」「今月の組」はこのゾーンで決まる
- Service Worker は既定で `block`（キャッシュが手順の間に挟まらないように）。PWA のオフライン表示を確かめる 1 件だけ `allow`
- テストごとに別の `x-viewer-ip` ヘッダを送る（本番では CloudFront Function が付ける）。API のセッション作成は IP ごと 1時間 20件までなので、並列実行やリトライで枠を取り合わないようにするため
- 過去に始めたチャレンジ（CUF-2 の「30日前」）は、実 API の `POST /api/session` → `POST /api/me/import`（バックアップの読み込み。過去のチャレンジを作れる正規の手段）で用意し、トークンを `localStorage['thirty-days.token']` に入れてからアプリを開く
- 画面に出たものがサーバに保存されたかは、同じオリジンの API（`GET /api/challenges` など）で確かめる。セレクタは role / label / 文言（SPEC の文言）を使い、CSS セレクタや固定の待ち時間は使わない
- CI: `retries: 1`、`workers: 2`、失敗時は `playwright-report/`（HTML）と初回リトライのトレースを artifact に残す

### 実行方法

```sh
npm run test:e2e                         # build + 全 E2E（mobile / desktop）
npx playwright test tests/e2e/cuf2-reflect-and-share.spec.ts --project desktop
npx playwright test --ui                 # デバッグ
npx playwright show-report               # 前回の HTML レポート
```

ブラウザは `npx playwright install chromium`（CI は `--with-deps`）。別の場所に入っている場合は `PLAYWRIGHT_BROWSERS_PATH` を指定する。`:8787` / `:4173` が埋まっているときは `E2E_API_PORT` / `E2E_WEB_PORT` で変えられる（ローカルでは起動済みの `:4173` を再利用する）。

## E2E の一覧（mobile / desktop の2プロジェクトで実行）

| ファイル | テスト | SPEC |
|---|---|---|
| `cuf1-start-and-stamp.spec.ts` | 初回ヒーロー → レシピ一覧 →「毎日1枚、写真を撮る」→ 今日から・ニックネーム →「30日、始める」→ カード（印「写」・1日目・0/30）→「きょう（1日目）の分を押す」→ 1/30・ひとこと保存 → 再読み込みで残る → API にも印・ひとこと・ニックネーム | CUF-1 1〜5 |
| `cuf1-offline-stamp.spec.ts` | オフラインで押す →「オフライン・あとで同期」・送信待ち1件・サーバは未保存 → 復帰で「同期済み」とサーバ保存 | CUF-1 E |
| 同上 | API が 503 の間に押す → 画面に残り「オフライン・あとで同期」→ API 復旧後の再送で保存 | CUF-1 E |
| 同上 | Service Worker あり: 一度開いたあとオフラインで再読み込み（SW から配信）→「きょう」と公式レシピが開け、オフラインの印が復帰後に同期 | FR-20 |
| `cuf2-reflect-and-share.spec.ts` | 30日前開始・23印のチャレンジ →「30日が終わりました」→「振り返る」→「続ける」→ ひとこと →「決める」→ 1200×630 のカード →「リンクを作って共有」→ `/s/<id>` にタイトル・印・判定・ひとこと・「自分も30日やってみる」、`og:image` が絶対 URL で `image/png` 1200×630 → 「記録」に「続ける」バッジ → API で done / continue / shareId | CUF-2 1〜4 |
| 同上 | 画像アップロードが 500 → エラー表示、公開リンクは出ない、「画像を保存」で 1200×630 の PNG が保存でき「Xで共有」も使える | CUF-2 E |
| `rate-limit-429.spec.ts` | API Gateway のステージのスロットル（`Retry-After` なしの 429）を新しいチャレンジの作成が受けても、作成とその間に押した印が残り、あとで両方送られる（R9） | Error Handling 429, CUF-1 |
| 同上 | アカウント作成（`POST /api/session`）の 429 の間、理由と再開の目安が帯で見え、チャレンジは残ってあとで同期される（R7・R10） | Error Handling 429 |
| `cuf3-cohort-cheer.spec.ts` | A が今月開始（公開は既定 ON）→ 別ブラウザの B が「みんな」→ 今月の組に A のニックネーム・印・タイトル・ミニ30マス →「応援」で 0→1・「応援済み」で押せない（再読み込み後も）・API の2回目は 409 → A が設定で「みんなに進捗を表示する」を OFF → B の再読み込みで A が消える | CUF-3 1〜4 |
| `smoke.spec.ts` | `/` `/recipes` `/recipes/photo` `/recipes/new` `/gacha` `/together` `/log` `/settings` `/about` `/terms` `/privacy` `/contact` `/admin` と未知のパス（404 画面）が、コンソールエラーなし・横スクロールなしで開く（14 件） | SPEC UI |
| 同上 | ガチャを1回まわして結果と「これを30日やる」、ひらめき提案で3案と「いまは AI を使わず、ルールで選んでいます」、残り回数 | FR-12, FR-13 |
| 同上 | `/s/<存在しないID>` がサーバ生成の HTML 404（「カードが見つかりません」） | FR-7 |
| `csp.spec.ts` | 本番の CSP（`infra/lib/edge.ts` の `SITE_CSP`）を付けて主要画面を開き、開始と印まで進めても `securitypolicyviolation` が出ない | Architecture |
| `pwa-recipe-cache.spec.ts` | Service Worker あり: サーバで消したレシピを、SW のキャッシュから出し続けない | FR-18, FR-20 |
| `tap-targets.spec.ts` | 360px 幅でチップと30マスが 44px 以上 | NFR アクセシビリティ |

## CUF のトレーサビリティ

Unit / Integration の欄はファイルと `it(...)` の名前（抜粋）。E2E はすべて `tests/e2e/`。

**CUF-1: レシピから始めて、印を押す**

| ステップ | Unit | Integration | E2E |
|---|---|---|---|
| 1 初回 `/` でヒーロー・「レシピから選ぶ」 | `apps/web/test/today.test.tsx` "shows the hero with three ways to start on the first visit (CUF-1 step 1)" | — | `cuf1-start-and-stamp`, `smoke` |
| 2 レシピ一覧 → 詳細（やり方・30日後・開始） | `apps/web/test/recipes.test.tsx` "shows the official recipes at once…", "renders the recipe, stories newest first and the start CTA" | `apps/api/test/recipes.test.ts` "lists the official recipes to anonymous visitors", "serves official recipes with their stories" | `cuf1-start-and-stamp` |
| 3 今日から・ニックネーム →「30日、始める」→ カード | `apps/web/test/start.test.tsx` "starts today from a recipe, with the nickname (CUF-1 step 3)"; `apps/web/test/appStore.test.ts` "shows a new challenge at once and syncs it, creating the account with the nickname" | `apps/api/test/session.test.ts` "creates an anonymous user with defaults and a working token"; `apps/api/test/challenges.test.ts` "creates a challenge with its cohort projection, lists it, and replays idempotently" | `cuf1-start-and-stamp` |
| 4 「きょう（1日目）の分を押す」→ 1/30・ひとこと欄 | `apps/web/test/today.test.tsx` "shows an active card and stamps today with one tap (CUF-1 step 4)"; `apps/web/test/grid30.test.tsx` | `apps/api/test/challenges.test.ts` "allows days 1..today+1, keeps the first stamp time, and edits or clears the note" | `cuf1-start-and-stamp` |
| 5 再読み込みで残る（サーバ保存） | `apps/web/test/appStore.test.ts`（同期と再取得） | `apps/api/test/challenges.test.ts`（GET 一覧） | `cuf1-start-and-stamp`（再読み込み + API 確認） |
| E オフライン／API 停止 | `apps/web/test/outbox.test.ts` "keeps a 5xx item and everything after it…", "treats network errors and timeouts as retryable"; `apps/web/test/appStore.test.ts` "keeps a stamp on screen while the API is down and sends it after recovery" | `apps/api/test/challenges.test.ts`（作成・印の冪等な再送） | `cuf1-offline-stamp`（オフライン・503・SW） |

**CUF-2: 30日目に振り返り、カードを公開する**

| ステップ | Unit | Integration | E2E |
|---|---|---|---|
| 1 30日前開始 →「30日が終わりました」「振り返る」 | `apps/web/test/today.test.tsx` "asks for the reflection when the 30 days are over (CUF-2 step 1)" | `apps/api/test/me.test.ts` "merges: newer wins for own ids…"（E2E の用意に使う import） | `cuf2-reflect-and-share` |
| 2 「続ける」→ ひとこと →「決める」→ 1200×630 プレビュー | `apps/web/test/share-card.test.tsx` "places every part inside the 1200×630 card", "decides 続ける with a ひとこと and shows the card…" | `apps/api/test/challenges.test.ts` "records day 30 for a challenge reflected after its end…" | `cuf2-reflect-and-share`（naturalWidth/Height） |
| 3 「リンクを作って共有」→ `/s/<id>`・OGP | `apps/web/test/share-card.test.tsx` "shows the public URL with copy and LINE once the link exists" | `apps/api/test/shares.test.ts` "stores the image and the public fields, and links the challenge", "renders the card with OGP tags and a CTA to the same recipe", "builds absolute URLs from x-forwarded-host (CloudFront)", png checks | `cuf2-reflect-and-share`（ページ・`og:image` → PNG 1200×630） |
| 4 「記録」に判定バッジ「続ける」 | `apps/web/test/today.test.tsx` "lists finished challenges with their verdict, totals and notes (CUF-2 step 4)" | — | `cuf2-reflect-and-share` |
| E 画像アップロード失敗 | `apps/web/test/share-card.test.tsx` "keeps saving and X sharing usable when the upload fails" | `apps/api/test/shares.test.ts` "rejects images that are not a 1200x630 PNG", "is 413 when…" | `cuf2-reflect-and-share` "CUF-2 E" |

**CUF-3: 1日組で並んで、応援する**

| ステップ | Unit | Integration | E2E |
|---|---|---|---|
| 1 A が今月開始・進捗公開 ON | `apps/web/test/start.test.tsx` | `apps/api/test/challenges.test.ts` "projects into next month's cohort for a reservation, and not at all when progress is private" | `cuf3-cohort-cheer` |
| 2 B の「みんな」に A（ニックネーム・印・ミニ30マス） | `apps/web/test/together.test.tsx` "lists this month's members with 1日組, counts and cheer states" | `apps/api/test/cohorts.test.ts` "shows A to B without notes or ids, counts one cheer per day, and hides A when A turns sharing off" | `cuf3-cohort-cheer` |
| 3 「応援」で +1、同じ日は2回目不可 | `apps/web/test/together.test.tsx` "cheers optimistically…", "409: already cheered today…" | `apps/api/test/cohorts.test.ts`（同上）, "refuses cheering one's own challenge, unknown or hidden ones, and anonymous cheers" | `cuf3-cohort-cheer`（画面 + API 409） |
| 4 A が公開 OFF → B の一覧から消える | `apps/web/test/settings.test.tsx` "toggles shareProgress and explains what is shown" | `apps/api/test/me.test.ts` "rewrites the nickname on challenges and toggles the cohort projection" | `cuf3-cohort-cheer` |
| E 一覧の取得に失敗 | `apps/web/test/together.test.tsx` "shows an error with retry, and the empty state" | — | —（Unit で十分） |

## Edge cases

| ケース | どこで確かめるか |
|---|---|
| 未来の日は押せない／押し忘れた過去の日は押せる／30日を過ぎたら 30 まで | `apps/web/test/today.test.tsx` "toggles a past day…", `apps/api/test/challenges.test.ts` "stamps" |
| 端末と API の日付のずれ（今日 +1 日まで受け付ける）・タイムゾーン・DST | `apps/api/test/challenges.test.ts`, `apps/api/test/reminder.test.ts` "…DST…", `packages/shared/test/` |
| 同時に開けるのは5件、1日10件の作成上限、同じ id の再送は数えない | `apps/api/test/challenges.test.ts` "creation quota…", `apps/web/test/start.test.tsx` "explains the limit when 5 challenges are open" |
| 送る前の作成＋削除は両方送らない、削除への 404 は成功扱い、4xx は巻き戻し | `apps/web/test/outbox.test.ts`, `apps/web/test/appStore.test.ts` |
| 401 でトークン破棄と引き継ぎコード案内 | `apps/web/test/appStore.test.ts` "flags the session on 401…", `apps/web/test/settings.test.tsx` "transfer" |
| 振り返り後は印が変えられない | `apps/api/test/challenges.test.ts` "is locked after the reflection" |
| 公開カードの HTML エスケープ、存在しない・非表示カードは 404 | `apps/api/test/shares.test.ts` "escapes every interpolated value", "is a 404 HTML page…"; E2E `smoke` |
| 共有画像の検証（PNG・1200×630・600KB） | `apps/api/test/shares.test.ts` "png checks" |
| 自分への応援・非表示への応援・日をまたいだ再応援 | `apps/api/test/cohorts.test.ts` |
| 公開レスポンスに ひとことメモ・ユーザー ID を含めない | `apps/api/test/cohorts.test.ts` "…without notes or ids" |
| 通報3件（作成24時間以上・チャレンジあり・2つ以上のネットワーク）で自動非表示・管理画面の削除／復元 | `apps/api/test/reports.test.ts`, `apps/api/test/admin.test.ts`, `apps/web/test/admin.test.tsx` |
| ひらめき提案の上限（1日10回）と失敗時の表示 | `apps/api/test/suggestions.test.ts`, `apps/web/test/gacha.test.tsx` |
| Push の宛先制限（SSRF）、404/410 の登録削除 | `apps/api/test/push.test.ts`, `apps/api/test/reminder.test.ts` |
| 横スクロールが出ない（390px / 1280px） | E2E `smoke` |
| 書き込みの費用の上限（R1）: ニックネーム・進捗公開の変更は1日10回、書き直すのは変わる項目だけ、保存する文字は UTF-8 のバイト数でも上限、DynamoDB のスロットルは SDK が多めにやり直す | `apps/api/test/me.test.ts`, `packages/shared/test/schemas.test.ts`, `apps/api/test/challenges.test.ts`, `apps/api/test/config.test.ts`, `apps/web/test/appStore.test.ts`, `apps/web/test/settings.test.tsx`；テーブルと GSI の上限・スロットルのアラームは `infra/test/stack.test.ts` |
| モデレーションはチャレンジを消して読み込み直しても残る（`MOD#<chId>`。R2） | `apps/api/test/shares.test.ts`, `apps/api/test/me.test.ts` |
| 判定の内訳は、数えたチャレンジ（`counted`）だけを移し替える（R3） | `apps/api/test/challenges.test.ts` |
| IP のハッシュ鍵が無いと起動しない（R4）、`ORIGIN_VERIFY` が空なら全部 403（R6） | `apps/api/test/config.test.ts`, `apps/api/test/http.test.ts`, `apps/api/test/lambda.test.ts` |
| 読み込みは1人ずつ（同時は 409。R5） | `apps/api/test/me.test.ts`, `apps/web/test/settings.test.tsx` |
| origin-verify の手順 3 はデプロイ済みの CloudFront が新しい値を送るまで進まない（R6） | `infra/test/stack.test.ts` |
| IPv6 は /56 で数える、アカウント作成は全体で上限あり（R7。R11 で1時間2000件）、自動非表示は2つ以上のネットワークからの通報が要る（R8） | `apps/api/test/http.test.ts`, `apps/api/test/reports.test.ts`, `apps/web/test/report.test.tsx` |
| 429 は `Retry-After` で決める（1時間を超えるときだけ捨てる。R9）、API の上限の 429 には必ず `Retry-After` | `apps/web/test/outbox.test.ts`, `apps/web/test/appStore.test.ts`, `apps/api/test/http.test.ts`；E2E `rate-limit-429` |
| アカウント作成はネットワーク（IPv4 /16・IPv6 /48）ごとに1時間60件、全体は2000件。1つの /48 では全体を使い切れない。断られた要求は狭いほうの数を戻す。全体の上限の警告ログとメトリクスフィルタ・アラーム `SessionCeiling` の文字列が一致（R11） | `apps/api/test/http.test.ts` "one IPv6 /48 cannot use up the global ceiling…", "counts an IPv4 /16…", "stops new sessions from all clients together…"；`infra/test/stack.test.ts` "alarms when the global new-session ceiling…"；`apps/web/test/static.test.tsx`（プライバシーポリシー） |
| `MOD#<chId>` はアカウントを消しても残り（gsi2 なし）、新しいアカウントで読み込んでも止めたまま。前の版の印は gsi2 だけ外す（R12） | `apps/api/test/shares.test.ts` "a stopped card stays stopped after export → delete the account…", `apps/api/test/me.test.ts` "account deletion keeps a moderation marker…" |
| 進捗公開のオフは上限に数えず断らない（ニックネームと一緒でも）。オンとニックネームは数える。Web は上限中もオフを送れる（R13） | `apps/api/test/me.test.ts` "turning sharing off never uses…", "a rename sent together with turning sharing off…"；`apps/web/test/appStore.test.ts` "R13…", `apps/web/test/settings.test.tsx` "R1/R13…" |
| 読み込みで長すぎるひとことだけを落とし、印とチャレンジは残す（`notesDropped`）。保存する大きさの上限のエラーは「あと N 文字」（R14） | `apps/api/test/me.test.ts` "drops only a note…", `packages/shared/test/schemas.test.ts` "says how many characters to remove…", `apps/api/test/challenges.test.ts`, `apps/web/test/settings.test.tsx` "R14…" |
| 読み込みの上限 1000・書き込み 100（テーブルと GSI）。一覧と書き出しは200件より多く読まない、作成も合計200件まで。PILOT の集計は必要な項目だけ・1ページ500件・20秒で打ち切り `partial`（R15）。アラームのメトリクスの数と deploy.md の費用の記載が一致（R16） | `infra/test/stack.test.ts`；`apps/api/test/challenges.test.ts` "never reads more than 200…", "refuses a create once…"；`apps/api/test/pilot.test.ts`；`apps/web/test/admin.test.tsx` "R15…" |

## Live smoke（手動）と品質ルーブリック

デプロイ後の `SiteUrl`（CloudFront）で行う。結果は日付・端末・OS / ブラウザのバージョン付きでリリースの Issue にコメントする。テスト用のアカウントは最後に「すべてのデータを削除」で消す。課金が増える操作（大量送信など）はしない。

用意: Android（Chrome 最新）、iPhone（iOS 16.4 以上・Safari）、PC（Chrome / Safari / Firefox のいずれか）。管理トークンは SSM の SecureString。

**基盤**

- [ ] `<SiteUrl>/api/health` が `{"ok":true}`。API Gateway の URL を直接開くと 403
- [ ] `/` のレスポンスヘッダに CSP・HSTS・`X-Content-Type-Options: nosniff`。DevTools のコンソールにエラー（CSP 違反を含む）が無い
- [ ] `/recipes/photo` を直接開いて表示される（SPA の書き換え）。`/s/<存在しないID>` は 404 の HTML
- [ ] `/media/hidden/share/x.png` が 404（公開されるのは `/media/share/<id>.png` だけ）。`/` の `og:image` が `https://` で始まる（`PUBLIC_ORIGIN` を付けてデプロイした）

**CUF（iPhone Safari と Android Chrome の両方）**

- [ ] CUF-1: 初回のヒーロー → レシピ →「毎日1枚、写真を撮る」→ 今日から・ニックネーム → 1日目を押す → 再読み込みで残る。上部が「同期済み」
- [ ] CUF-1 E: 機内モードで押す →「オフライン・あとで同期」と上部の帯 → 機内モード解除で「同期済み」
- [ ] PWA: ホーム画面に追加 → 機内モードでアイコンから開き、「きょう」と公式レシピが見える
- [ ] CUF-2: 30日前に始めたチャレンジを用意する（設定 → バックアップの読み込みで、開始日を30日前にしたバックアップ JSON を読み込む。形は `tests/e2e/fixtures.ts` の `pastChallenge`）→ 振り返る → 続ける → カード → リンクを作って共有 → 別のブラウザ（シークレット）で `/s/<id>` を開く
- [ ] OGP: `/s/<id>` を LINE（自分だけのトーク）と X の投稿画面に貼り、画像つきのカードが出る。`og:image` が `https://<CloudFront ドメイン>/media/share/<id>.png`。トップの URL を貼っても画像が出る
- [ ] 通報: `/s/<id>` の「このカードを通報する」→ お問い合わせ画面の通報フォーム → 送ると管理画面の通報一覧に出る。管理画面で「非表示」→（キャッシュの5分以内に）`/s/<id>` は 404、`/media/share/<id>.png` は 403（S3 は無いキーに 403 を返す。CloudFront には一覧の権限を与えていないため。404 でもよい）。「復元」で両方戻る。`/s/<id>` の下にフッター（このサービスについて・利用規約・プライバシーポリシー・お問い合わせ）
- [ ] CUF-3: 端末 A で今月開始、端末 B（別アカウント）の「みんな」に A が出る → 応援 → 応援済み → A が設定で公開 OFF → B の再読み込みで消える

**Web Push（FR-14）**

- [ ] Android Chrome: 設定 → リマインド →「通知を許可する」→ 許可 →「テスト通知」が1分以内に届き、タップでアプリが開く
- [ ] Android Chrome: 印を押していないチャレンジがある状態で、リマインド時刻を次の15分の区切りにする → その時刻（15分ごとのジョブ）に通知が届く。押したあとの区切りでは届かない
- [ ] iPhone の Safari タブ: リマインドに「ホーム画面に追加」の案内が出る（通知ボタンは出ない）
- [ ] iPhone のホーム画面アプリ: 「通知を許可する」→ 許可 →「テスト通知」がロック画面に届き、タップでアプリが開く
- [ ] 通知を使えない環境でも、チャレンジ画面のカレンダー（Google カレンダーのリンク・.ics）で毎日の予定が入る

**運用**

- [ ] `/admin` に管理トークンで入り、統計（開始した人・7日継続・完走）とお問い合わせが見える。別アカウントで通報した項目が一覧に出る
- [ ] 設定 →「すべてのデータを削除」で、アカウント・公開カード（`/s/<id>` が 404）・1日組の表示が消える
- [ ] CloudWatch Logs に 5xx が無い。ログにトークン・ひとこと・投稿本文・Push の宛先・IP が出ていない
- [ ] AWS Budgets `thirty-days-monthly`（月 $10、`Project=thirty-days` で絞り込み）とアラーム5つ（`Api5xx`・`ApiErrors`・`ReminderErrors`・`DynamoThrottles`・`SessionCeiling`）、api のロググループのメトリクスフィルタ（名前に `SessionCeilingFilter` を含む）がある（`alertEmail` を付けてデプロイした場合）。費用配分タグ `Project` が有効になっている。アラームの SNS のメール購読が ARN（`PendingConfirmation` や `Deleted` ではない）で、`set-alarm-state` のテストのメールが届く（docs/deploy.md）
- [ ] DynamoDB のテーブルと GSI 3つに最大オンデマンドスループット（読み込み 1000・書き込み 100）が付いている。`DynamoThrottles` と `SessionCeiling` が「OK」（Live smoke の操作で上限に当たらない）
- [ ] `node scripts/setup-secrets.mjs --check` が「6 個がそろっています」

**品質ルーブリック（判定）**

| 判定 | 条件 |
|---|---|
| 合格 | CUF-1〜3 と E がすべての端末で通る。コンソールエラー・5xx なし。Web Push が Android とホーム画面の iPhone で届く |
| 条件付き合格 | CUF は通るが、CUF 以外（例: 特定端末の見た目、カレンダー連携）に不具合 → `priority:p1` 以下の Issue を作ってリリース可 |
| 不合格 | CUF のどれかが失敗、データの消失、秘密情報・個人情報の露出、課金の異常 → リリース禁止・`status:needs-ceo`（重大なセキュリティ問題のとき） |

## Regression

- すべての PR と main への push で CI（lint → typecheck → unit / integration → build → audit → E2E → synth）
- CUF の E2E が赤のときはマージ・リリース禁止
- 不具合を直すときは、再現する自動テストを先に追加する（ロジックは Unit / Integration、CUF の手順に関わるものは E2E）。テスト名かコメントに Issue 番号を書く
- 新しい E2E は、マージ前に `npx playwright test <file> --repeat-each 4 --workers 4` で不安定でないことを確かめる
- 不安定なテストは消さない。原因を直すか、Issue を作って `test.fixme` で一時的に外し、1営業日以内に戻す
- E2E の型は `npm run typecheck`（`tsc -p tests/e2e`）で確認される（Playwright 自体は型を検査しない）

## 既知のリスク

- **日付の境目**: E2E は日本時間の「今日」で日数と今月の組を計算する。日本時間の 0 時（UTC 15:00）や月末をまたいで走ると、まれに落ちうる（CI はリトライ 1 回）
- **ローカルと本番の差**: E2E は dynalite と、ローカルの `/media` 配信を使う。CloudFront（SPA 書き換え・`x-forwarded-host`・`x-viewer-ip`・セキュリティヘッダ・キャッシュ）、S3 の OAC、DynamoDB の TTL、SSM は E2E の対象外（`infra/test/` のテンプレート検証と Live smoke で補う）
- **ブラウザ**: 自動テストは Chromium だけ。SPEC の対象の iOS Safari（WebKit）と Firefox は Live smoke に頼る。Canvas のカード描画とフォントは端末で差が出やすい
- **Web Push** は自動テストできない（Unit と Integration はモック）。iOS はホーム画面アプリでしか動かない
- **レート制限のキー**: API は `x-viewer-ip`（無ければ `x-forwarded-for`、それも無ければ共通の "unknown"）で数える。E2E はテストごとに別の値を送る。ローカルの `npm run dev` では全員が "unknown" になり、セッション作成が1時間 20件で止まる
- **Service Worker の更新**（新しい版への切り替え、古いタブのチャンク再読み込み）は自動テストしていない

## Not tested（意図的）

- 課金される外部 API（存在しない。AI は使わない）
- 負荷・性能（API p95 < 500ms、初回 JS < 250KB gzip）: 自動テストなし。ビルド出力の gzip サイズ（`npm run build -w apps/web`）と CloudWatch のレイテンシで目視確認する
- 見た目の回帰（スクリーンショット比較）: デザイン変更が続く MVP の間はしない。横スクロールだけ E2E で見る
- アクセシビリティの自動監査（axe など）: しない。E2E を role / label で書くことで、名前のないボタンなどは間接的に見つかる
- 管理画面・引き継ぎコード・バックアップ・データ削除・写真メモ（IndexedDB）・レシピ / 体験談の投稿の E2E: CUF ではないので Unit / Integration のみ（データ削除は Live smoke で確認）
- タイムゾーンが日本以外の E2E: Unit / Integration（`packages/shared/test/`, `apps/api/test/`）で扱う
