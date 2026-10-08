# Test Plan — 30日だけ

Owner: AI QA ／ 対象: SPEC v1.7 ／ 最終更新: 2026-10-08

方針: MVP では Critical User Flow（CUF）を最優先。網羅より「CUF が壊れたら必ず CI が赤になる」こと。次に過去の不具合の回帰、最後にエッジケース。課金される外部 API はどのテストからも呼ばない（このサービスには AI も課金 API も無い。[ADR 0003](decisions/0003-no-ai-mock-suggestions.md)）。

## テストレベル

| レベル | 対象 | ツール | 場所 | 実行 |
|---|---|---|---|---|
| Unit | 共有ロジック（日付・文字数・スキーマ） | Vitest | `packages/shared/test/` | CI（`npm test`） |
| Unit | Web のロジックと画面（store・outbox・共有カード・各ページ） | Vitest + jsdom + Testing Library | `apps/web/test/` | CI（`npm test`） |
| Integration | API の全ルート・DB・リマインドジョブ（DynamoDB は dynalite、S3 / SSM / Web Push はモック） | Vitest + dynalite + aws-sdk-client-mock | `apps/api/test/` | CI（`npm test`） |
| Integration | インフラ（CDK テンプレートの検証。CloudFront Function のコードも実行して確認。DynamoDB のスループットの上限とスロットルのアラーム、アラームが API の使う DynamoDB の操作をすべて含むこと、TLS のみの通知トピックにこのアカウント・リージョンのアラームだけが Publish できること（#6））と `scripts/setup-secrets.mjs` の入れ替え・確認のロジック（origin-verify の手順 3 がデプロイ済みの CloudFront を確かめること。AWS CLI はモック） | Vitest + aws-cdk-lib/assertions | `infra/test/` | CI（`npm test`） |
| E2E | CUF-1〜3 と全画面のスモーク。本番ビルドの Web + ローカル API | Playwright（Chromium。`mobile` 390×844 タッチ / `desktop` 1280×800） | `tests/e2e/` | CI（`npm run test:e2e`） |
| Live smoke | デプロイ後の実環境で CUF・Web Push・OGP | 手動（下のチェックリスト） | 本書 | 初回公開前・インフラ変更後・リリースごと（PILOT の前は行わず、CEO がリスクを受け入れた: [ADR 0006](decisions/0006-gate6-ceo-risk-acceptance.md)。一般公開の前には行う） |

### E2E の仕組み

- `npm run test:e2e` = `npm run build -w apps/web && playwright test`。CI と同じく**本番ビルド**（`apps/web/dist`）を試す
- `playwright.config.ts` の `webServer` が `scripts/e2e-server.mjs` を起動する: ローカル API（`apps/api/src/local.ts` の `startLocal`、毎回まっさらなインメモリ dynalite、一時ディレクトリの媒体置き場）を `127.0.0.1:8787` に、`vite preview` を `127.0.0.1:4173` に立て、`/api` `/s` `/media` を API へプロキシする（本番の CloudFront と同じ形）。SIGTERM / SIGINT で両方を止め、一時ディレクトリを消す
- ブラウザのタイムゾーンは `Asia/Tokyo`、ロケール `ja-JP`。「今日」「何日目」「今月の組」はこのゾーンで決まる
- Service Worker は既定で `block`（キャッシュが手順の間に挟まらないように）。SW そのものを確かめるテスト（オフライン表示・レシピのキャッシュ・フォントのキャッシュ）だけ `allow`
- テストごとに別の `x-viewer-ip` ヘッダを送る（本番では CloudFront Function が付ける）。API のセッション作成は IP ごと 1時間 20件までなので、並列実行やリトライで枠を取り合わないようにするため
- 過去に始めたチャレンジ（CUF-2 の「30日前」）は、実 API の `POST /api/session` → `POST /api/me/import`（バックアップの読み込み。過去のチャレンジを作れる正規の手段）で用意し、トークンを `localStorage['thirty-days.token']` に入れてからアプリを開く
- 1日組に出したまま2日分の印が要るとき（CUF-3 のひとことを見せる流れ。「昨日から」）は、`POST /api/session` → `POST /api/challenges`（開始日は今日の7日前まで受け付ける。D4。`fixtures.ts` の `createChallenge`）で用意する。読み込んだチャレンジは本人が書き込むまで1日組に出ず、ひとことも見せられないため、import は使わない
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
| `cuf1-start-and-stamp.spec.ts` | 初回ヒーロー → レシピ一覧 →「毎日1枚、写真を撮る」→ 今日から・ニックネーム →「30日、始める」→ カード（印「写」・1日目・0/30）→「きょう（1日目）の分を押す」→ 1/30・ひとこと保存 → 再読み込みで残る → API にも印・ひとこと・ニックネーム → ひとことは既定で自分だけ（`shown` なし・「みんなに見せる」はオフ・一覧の JSON に文面なし・`GET /api/members/:id/notes` は空。#17） | CUF-1 1〜5 |
| 同上 | 予約を今日からにする前の確認（#21）:「次の1日組」の「1日組で予約する」で次の1日に予約 → カードに「予約中」、API も次の1日 →「今日から始める」→ ダイアログ「今日から始めますか？」に「（次の1日）の1日組から外れ…」、フォーカスは「やめておく」→「やめておく」→ 予約中のまま・フォーカスはカードのボタンに戻る・送信待ち0件 → 再読み込みでも予約中、`PATCH` は0回、API も次の1日 → もう一度押して「今日から始める」→ 1日目・きょうの印のボタンにフォーカス・同期済み・`PATCH` はちょうど1回・API の開始日が今日 | FR-3 |
| `cuf1-offline-stamp.spec.ts` | オフラインで押す →「オフライン・あとで同期」・送信待ち1件・サーバは未保存 → 復帰で「同期済み」とサーバ保存 | CUF-1 E |
| 同上 | API が 503 の間に押す → 画面に残り「オフライン・あとで同期」→ API 復旧後の再送で保存 | CUF-1 E |
| 同上 | Service Worker あり: 一度開いたあとオフラインで再読み込み（SW から配信）→「きょう」と公式レシピが開け、オフラインの印が復帰後に同期 | FR-20 |
| `cuf2-reflect-and-share.spec.ts` | 30日前開始・23印のチャレンジ →「30日が終わりました」→「振り返る」→「続ける」→ ひとこと →「決める」→ 1200×630 のカード →「リンクを作って共有」→ `/s/<id>` にタイトル・印・判定・ひとこと・「自分も30日やってみる」、`og:image` が絶対 URL で `image/png` 1200×630 → 「記録」に「続ける」バッジ → API で done / continue / shareId | CUF-2 1〜4 |
| 同上 | 画像アップロードが 500 → エラー表示、公開リンクは出ない、「画像を保存」で 1200×630 の PNG が保存でき「Xで共有」も使える | CUF-2 E |
| `rate-limit-429.spec.ts` | API Gateway のステージのスロットル（`Retry-After` なしの 429）を新しいチャレンジの作成が受けても、作成とその間に押した印が残り、あとで両方送られる（R9） | Error Handling 429, CUF-1 |
| 同上 | アカウント作成（`POST /api/session`）の 429 の間、理由と再開の目安が帯で見え、チャレンジは残ってあとで同期される（R7・R10） | Error Handling 429 |
| `cuf3-cohort-cheer.spec.ts` | A が今月開始（公開は既定 ON）→ 別ブラウザの B が「みんな」→ 今月の組に A のニックネーム・印・タイトル・ミニ30マス（カードのボタンが1行の高さ）→「詳しく見る」で A の30マス（1日目に印）と「ひとことは、本人が「みんなに見せる」を選んだものだけ…」の注記（ひとことの欄なし）、Esc で閉じる →「応援」で 0→1・「応援済み」で押せない（再読み込み後も）・API の2回目は 409 → A が設定で「みんなに進捗を表示する」を OFF → B の再読み込みで A が消え、ひとことの API も 404 | CUF-3 1〜4 |
| 同上 | ひとことを見せる（#17）: 昨日開始の A が2日目（きょう）に NOTE2、1日目（チャレンジ詳細）に NOTE1 → どちらも一覧の JSON・`/api/members/:id/notes`・B の「詳しく見る」に出ない → A が1日目の「みんなに見せる」→ 確認のシート（「1日目」と NOTE1 のプレビュー・注意・同意の一文）→「見せる」→ 欄の名前が「（みんなに見せています）」、メモ一覧に「みんな」→ API は1日目だけ、一覧は `shownNoteCount: 1` で文面なし → B の再読み込みでカードに「ひとこと 1」、「詳しく見る」に「1日目」NOTE1 だけ → A が書き換える →「書き換えたので「自分だけ」に戻しました。…」の通知・欄の名前が「（自分だけに見えます）」・スイッチがオフ・API は空・B が再読み込みせずに開き直すと何も出ない → A が見せ直して戻す（確認なし、「自分だけに戻しました」）→ API はすぐ空・B も何も出ない → 見せ直してから書き換え、保存せずにすぐスイッチを押す（欄から出るときに保存される。サーバが受け付けるまでスイッチはオンのままで、押すとすぐ戻す。確認のシートは出ない）→ API は空 → 見せ直して進捗公開 OFF → API は 404・A の画面は「いまは誰にも見えていません」・B の一覧から A が消える。NOTE2 はどこにも出ない | CUF-3 4〜6 |
| `smoke.spec.ts` | `/` `/recipes` `/recipes/photo` `/recipes/new` `/gacha` `/together` `/log` `/settings` `/about` `/terms` `/privacy` `/contact` `/admin` と未知のパス（404 画面）が、コンソールエラーなし・横スクロールなし・17px より小さい手書き（Klee One）なしで開く（14 件。手書きの確認は #20） | SPEC UI, FR-21 |
| 同上 | アカウントあり（続けている・振り返り済み・終わったチャレンジ、メモ）で `/`・`/c/:id`（2つ）・`/c/:id/reflect`・`/log`・`/settings`（すべての小見出し）・`/together` に、17px より小さい手書きが無い（印の字は除く。#20） | FR-21 |
| 同上 | メニュー（表示されている方）のリンクが「きょう / えらぶ / みんな / 記録」の4つで、行き先が `/` `/recipes` `/together` `/log`。`/` で きょう、`/gacha` で えらぶ が `aria-current="page"` で、`/gacha` では えらぶ の行き先が `/gacha`（#20） | FR-21 |
| 同上 | 360px・オフライン・一番長い同期の文（「オフライン・あとで同期」）でも、ヘッダーの「設定」が画面の中に収まり、横スクロールがない（#20） | FR-21, NFR |
| 同上 | 端末がライトで「ダーク」を選んでいる: 文書を読み終えた時点（`readyState` が `interactive`、アプリのスクリプトより前）で `<html data-theme="dark">` と2つの `theme-color` が `#1c1b19`、背景が `rgb(28, 27, 25)`（`/theme-boot.js`。白い画面が一瞬出ない。#20） | FR-21 |
| 同上 | ガチャを1回まわして結果と「これを30日やる」、ひらめき提案で3案と「いまは AI を使わず、ルールで選んでいます」、残り回数。そのあと今のタブ「えらぶ」を押しても `/gacha` のままで、結果と3案が残る（#20） | FR-12, FR-13, FR-21 |
| 同上 | `/s/<存在しないID>` がサーバ生成の HTML 404（「カードが見つかりません」） | FR-7 |
| `csp.spec.ts` | 本番の CSP（`infra/lib/edge.ts` の `SITE_CSP`）を付けて主要画面を開き、開始と印まで進めても `securitypolicyviolation` が出ない | Architecture |
| `pwa-recipe-cache.spec.ts` | Service Worker あり: サーバで消したレシピを、SW のキャッシュから出し続けない | FR-18, FR-20 |
| `pwa-font-cache.spec.ts` | Service Worker あり: 前の版のフォントのキャッシュ `fonts` が端末にあっても、新しい SW が有効になると消え、Klee One の woff2 は `fonts-v2` に入る（#20） | FR-20, Architecture |
| `focus-visible.spec.ts` | キーボードのフォーカスが見える（#20）: `/c/:id` で選択中のきょうのマスに Tab で来ると、外側に 2px の緑の輪（選択の内側の墨の輪はそのまま）。`/recipes/new` の入力欄は ライト・ダーク・`prefers-contrast: more` の4通りで 2px の輪が出る（色の変化だけにしない）。強制カラー（Windows のハイコントラスト）でも、選択中のチップときょうのマスにフォーカスが来ると、選択の輪（2px・1px 外）と違う 3px・3px 外の輪になる | NFR アクセシビリティ |
| `tap-targets.spec.ts` | 360px 幅でチップと30マスが 44px 以上。「お知らせ」の帯（#17）が横にはみ出さず、閉じるボタンが 44px 以上、閉じると本文にフォーカスが移り、再読み込みしても出ない。`/recipes` と `/gacha` の「えらびかた」のリンク（レシピ / ガチャ）とヘッダーの「設定」が 44px 以上（#20） | NFR アクセシビリティ、FR-21、FR-22 |

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
| 2b B が A の「詳しく見る」（同じ公開情報だけ。#16） | `apps/web/test/together.test.tsx` "TogetherPage member detail"（開閉・追加の通信なし・レシピのリンクなし・応援後もフォーカスがシート内・途中で区切った人）, "member detail helpers" | —（#16 では API を変えていない。ひとことは下の 5・6） | `cuf3-cohort-cheer`（シートの30マスと注記・ひとことの欄なし、カードのボタンの高さ） |
| 3 「応援」で +1、同じ日は2回目不可 | `apps/web/test/together.test.tsx` "cheers optimistically…", "409: already cheered today…" | `apps/api/test/cohorts.test.ts`（同上）, "refuses cheering one's own challenge, unknown or hidden ones, and anonymous cheers" | `cuf3-cohort-cheer`（画面 + API 409） |
| 4 A が公開 OFF → B の一覧から消える（見せていたひとことも 404） | `apps/web/test/settings.test.tsx` "toggles shareProgress and explains what is shown"; `apps/web/test/today.test.tsx` "a note shown before progress was turned off is seen by nobody now…", "progress turned off here but not sent yet: the note is still seen…" | `apps/api/test/me.test.ts` "rewrites the nickname on challenges and toggles the cohort projection"; `apps/api/test/note-visibility.test.ts` "(i) shareProgress off: 404 at once, even while gsi1 still lists the challenge…" | `cuf3-cohort-cheer`（2件とも） |
| 5 A がある日のひとことを「みんなに見せる」→ B の「詳しく見る」にその日だけ（#17） | `apps/web/test/today.test.tsx` "saves a draft first and asks with the exact cleaned text…", "the label and the switch change only when the server confirms…"; `apps/web/test/appStore.test.ts` "is not optimistic…", "sends a note saved a moment ago first…", "sends 「みんなに表示」 turned on (still queued) before showing…"; `apps/web/test/together.test.tsx` "the card shows how many notes are shown (1–30), never the text…", "「詳しく見る」 fetches the shown notes on every open…", "cleans the notes response…"; `packages/shared/test/schemas.test.ts` "day notes shown in みんな (#17)" | `apps/api/test/note-visibility.test.ts` "(a) keeps every note private by default…", "(c) shows exactly the day the owner chose…", "(d) refuses a stale note (409)…", "(g) counts only a real private → shown change…", "(r) the visibility route decides from strong reads…"; `apps/api/test/cohorts.test.ts` "counts the notes a member shows (shownNoteCount…)" | `cuf3-cohort-cheer`（2件目） |
| 6 書き換える・「みんなに見せる」をオフ → B が次に開いたときには出ない | `apps/web/test/outbox.test.ts` "applyOp and a note shown in 「みんな」 (#17)"; `apps/web/test/today.test.tsx` "saving another text offline: private here, and it says the old text is seen until it is sent…", "saving another text online says it is private once the server has the edit", "on %s, editing a shown note and then pressing the switch to hide it never asks to show the new text", "on %s, a click with no press seen (a screen reader's) right after saving made the note private never asks…", "while an edit of a shown note cannot be sent yet, the switch stays on and turning it off takes the old text back at once", "turning it off keeps the switch enabled and focused…"; `apps/web/test/appStore.test.ts` "makes a note private at once, even while a write for the challenge is stuck in the queue", "an edit and an edit back made offline still make a shown note private…", "after an edit of a shown note, says whether the server has it…", "counts 「みんなに表示」 turned on in the queue…"; `apps/web/test/together.test.tsx` "a 404 (not listed any more) or a malformed answer shows nothing" | `apps/api/test/note-visibility.test.ts` "(e) any change of the text makes it private again…", "(f) a re-stamp read before an un-share and written after it never puts the choice back", "(g) stopping is never refused…", "(p) a stale consent is not revived by typing its old text again" | `cuf3-cohort-cheer`（2件目） |
| E 一覧の取得に失敗 | `apps/web/test/together.test.tsx` "shows an error with retry, and the empty state" | — | —（Unit で十分） |
| E 「詳しく見る」のひとことの取得に失敗 | `apps/web/test/together.test.tsx` "while loading says so; an error offers 「もう一度」" | — | —（Unit で十分） |

## Edge cases

| ケース | どこで確かめるか |
|---|---|
| アラームが TLS のみの SNS トピックに Publish できる（`enforceSSL` が既定のポリシーを置き換えても。#6） | `infra/test/stack.test.ts` "lets this account's CloudWatch alarms publish…"、本番では Live smoke の `set-alarm-state` のテスト |
| 予約を今日からに変えるのは確認のあとだけ（#21）: きょうのカードの「今日から始める」と編集の「今日から」の保存。文言は3通り（1日の予約は「N月1日の1日組から外れます。」、今日も1日なら「…から外れて、今日（…）の1日組で始めます。」、1日でない予約は「予約していたN月D日ではなく、今日から始めます。」）。「やめておく」・Esc は何も送らず送信待ちにも入れない（編集では選択が予約に戻り、シートは開いたまま。Esc は確認だけを閉じる）。「今日から始める」は `PATCH` 1回（編集では題名などと一緒に1回）。題名だけの編集や1日組への変更は聞かない | `apps/web/test/today.test.tsx` "予約を今日からにする前に確かめる (#21)"（6件）, "shows a reservation that can start today instead, after asking (#21)"；E2E `cuf1-start-and-stamp`（2件目） |
| 未来の日は押せない／押し忘れた過去の日は押せる／30日を過ぎたら 30 まで | `apps/web/test/today.test.tsx` "toggles a past day…", `apps/api/test/challenges.test.ts` "stamps" |
| 端末と API の日付のずれ（今日 +1 日まで受け付ける）・タイムゾーン・DST | `apps/api/test/challenges.test.ts`, `apps/api/test/reminder.test.ts` "…DST…", `packages/shared/test/` |
| 同時に開けるのは5件、1日10件の作成上限、同じ id の再送は数えない | `apps/api/test/challenges.test.ts` "creation quota…", `apps/web/test/start.test.tsx` "explains the limit when 5 challenges are open" |
| 送る前の作成＋削除は両方送らない、削除への 404 は成功扱い、4xx は巻き戻し | `apps/web/test/outbox.test.ts`, `apps/web/test/appStore.test.ts` |
| 401 でトークン破棄と引き継ぎコード案内 | `apps/web/test/appStore.test.ts` "flags the session on 401…", `apps/web/test/settings.test.tsx` "transfer" |
| 振り返り後は印が変えられない | `apps/api/test/challenges.test.ts` "is locked after the reflection" |
| 公開カードの HTML エスケープ、存在しない・非表示カードは 404 | `apps/api/test/shares.test.ts` "escapes every interpolated value", "is a 404 HTML page…"; E2E `smoke` |
| 共有画像の検証（PNG・1200×630・600KB） | `apps/api/test/shares.test.ts` "png checks" |
| 自分への応援・非表示への応援・日をまたいだ再応援 | `apps/api/test/cohorts.test.ts` |
| 公開レスポンスに 見せる選択のないひとことメモ・ユーザー ID を含めない。一覧には文面を入れない（数だけ） | `apps/api/test/cohorts.test.ts` "…without notes or ids", "counts the notes a member shows (shownNoteCount…) and never puts note text in the list"；`apps/api/test/note-visibility.test.ts` "(a)", "(b) never shows a note stored without the visibility route…", "(o) the member route answers at most 30 notes…"；E2E `cuf1-start-and-stamp`, `cuf3-cohort-cheer` |
| 見せたひとこと（#17）: 書き換え・消す・印の取り消しで「自分だけ」に戻る、`{}` の再送と同じ文面は残す、戻したあとの古い再送で戻らない、古い同意は昔の文面に書き戻しても戻らない。端末の送信待ちも同じ決まりで、違う文面の書き換えはまとめない（書き換えて元に戻しても、サーバは間の文面を受け取る）。送信待ちのあいだは「前のひとことが見えています」と出し（送信待ちの進捗公開のオンが先に送られるときも。つながっていれば「オフにすると、すぐ見えなくなります。」も）、スイッチはオンのままで、オフにするとすぐ戻る。送信待ちのあいだにもう一度書き換えても、見せているひとことの書き換えとして扱う。印の取り消しは、つながっていれば送信待ちを待たずにすぐ戻し、戻せなかったときだけ通知で伝える。「戻しました」はサーバが受け付けてから。「見せる」の返事はその日の状態だけを取り込み、先に届いた書き換えの返事を古い文面で上書きしない | `apps/api/test/note-visibility.test.ts` "(e)", "(f)", "(p)"；`apps/web/test/outbox.test.ts` "keeps two different texts of one day's note as two writes…", "applyOp and a note shown in 「みんな」 (#17)"；`apps/web/test/appStore.test.ts` "an edit and an edit back made offline…", "after an edit of a shown note, says whether the server has it…", "counts 「みんなに表示」 turned on in the queue…"；`apps/web/test/today.test.tsx` "saving another text offline…", "while an edit of a shown note cannot be sent yet…", "on %s, editing again while the first edit of a shown note waits…", "on %s, undoing the stamp of a shown note offline…", "on %s, undoing the stamp of a shown note online takes the note back at once…", "undoing the stamp of a shown note online says nothing more…"；`apps/web/test/appStore.test.ts` "takes only the day's choice from a visibility answer…" |
| 見せたひとこと: 1人1日30回（戻すのは数えず断らない。本当に変わったときだけ数え、途中で文面が変われば戻す）、見せる書き込みは `updatedAt`・一覧の並び・ニックネーム・`imported` を変えない | `apps/api/test/note-visibility.test.ts` "(g)", "(h) the visibility write leaves updatedAt…"；`apps/web/test/appStore.test.ts` "explains the server's refusals: 400, 409, the daily limit (429)…" |
| 見せたひとこと: 非表示・自動非表示ですぐ 404、復元で同じものが戻る、削除は戻らない。管理画面の member の表示は見せたものだけ。アカウント削除で残らない。ほかの人は見せる・戻すができない（404、本文に文面なし） | `apps/api/test/note-visibility.test.ts` "(j)", "(l)", "(m)", "(n)"；`apps/api/test/admin.test.ts` "a member's preview carries the day notes the owner shows…"；`apps/api/test/challenges.test.ts` "answers 404 on the visibility route too (#17)…" |
| 見せたひとこと: 書き出しは `shown: true`（version 1 のまま）、読み込みは選択を引き継がない（自分の ID・別の ID・`shownNote` を書き足したファイルでも）。ログに `shownNote` を出さない | `apps/api/test/note-visibility.test.ts` "(k) an import never carries a choice…"；`apps/api/test/me.test.ts` "exports `shown: true`…"；`apps/api/test/config.test.ts` "drops a shown note's stored consent (shownNote)…"；`apps/web/test/settings.test.tsx` "#17: says imported day notes all go back to 「自分だけ」" |
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
| メニューと画面の並び（#20、ADR 0008）: メニューは2つ（タブバーと上のナビ）とも「きょう / えらぶ / みんな / 記録」。選択中のタブは `activeTab`（`/recipes`・`/recipes/*`・`/gacha` は えらぶ、振り返り済みの `/c/:id`・`/c/:id/reflect` は 記録、ほかの `/c/` は きょう、設定などは無し）。ヘッダーのリンクの名前はちょうど「設定」で、歯車は飾り。「えらびかた」は今のページに `aria-current`。チャレンジの戻るリンクは状態で決まる（振り返り済み →「記録」`/log`、ほか →「きょう」`/`）。記録は「きょう」への1行（未完があるときだけ）→ 終わった30日 → まとめ → メモ。きょうは 次の1日組 →「もうひとつ試す？」（Link・Link・button）の順、ヒーローは レシピ だけが主ボタン、終わったカードに「振り返り待ち」。設定は 表示 が先頭（アカウントあり・なしの両方、ジャンプのリンクも同じ順）とテーマの補足 | `apps/web/test/layout.test.tsx`；`apps/web/test/today.test.tsx` "#20: …"（6件）；`apps/web/test/settings.test.tsx` "SettingsPage — order (#20…)"；`apps/web/test/recipes.test.tsx`・`apps/web/test/gacha.test.tsx`（えらびかた）；E2E `smoke`・`tap-targets` |
| フォント（#20）: 一度だけ読み込む、Save-Data と `prefers-reduced-data` のときは読まない、シェアカードを描くとき（`force`）は読む、`FONT_STACKS` が tokens.css と同じ。シェアカードの「形を変える」の色は `#52637a` | `apps/web/test/fonts.test.ts`；`apps/web/test/share-card.test.tsx` |
| えらぶ の行き先（#20）: `/gacha` にいるときは 2つのメニューとも `/gacha`（押しても同じページのままで、結果が残る）、ほかでは `/recipes`。`tabTarget` | `apps/web/test/layout.test.tsx` "on ガチャ, えらぶ links to /gacha itself…", "tabTarget"；E2E `smoke` |
| フォントのキャッシュ（#20）: SW は `fonts-v2`（160 件まで。Klee One 600 は 124 ファイル）を使い、有効になるときに前の `fonts` と古いレシピのキャッシュを消す（Cache Storage が断っても有効化は止めない） | `apps/web/test/swCaches.test.ts`；E2E `pwa-font-cache` |
| 手動のテーマを最初の描画の前に（#20）: `/theme-boot.js` は `<head>` の中で theme-color の後・モジュールより前に読む（ブロックする古典的なスクリプト。CSP は `script-src 'self'` のまま）。保存された「ダーク」「ライト」を `data-theme` と2つの `theme-color` に入れ、色は `THEME_COLORS` と同じ。何も無い・「端末に合わせる」・保存が使えないときは何もしない | `apps/web/test/indexHtml.test.ts` "index.html: a manual theme before the first paint…"；E2E `smoke`・`csp` |
| デザインの決まり（#20、docs/design.md）: (a) ダークの2ブロックが同じ (b) コントラストの表（両方のテーマ、tokens.css の値から計算）(c) 使うトークンはどこかで宣言 (d) 前のフォントの名前が残っていない (e) 硬い影なし (f) 傾けるのは印（-4deg）と CSS で描いた ✓（45deg）だけ (g) tokens.css の外に生の #hex なし (h) components.css の ::before / ::after に文字なし (i) `prefers-contrast: more` で `--line` と `--rule` が墨・`--muted` が濃い（3つのブロック）(j) 入力欄のフォーカスの輪を消さない、強制カラーで選択の outline の後にフォーカスの規則がある (k) 手書きの指定は 17px 以上（印を除く） | `apps/web/test/design-guard.test.ts` |
| 規約・プライバシーポリシーの改定のお知らせ（#17、ADR 0007）: 両方のページに制定日・改定日・適用日と「改定のお知らせ」、変わる文はどれも「（適用日）から」で、適用日の前も後も正しい。ほかの画面の上の「お知らせ」の帯は閉じられ、閉じたことは適用日ごとに保存（保存できなくても表示は壊れない）、適用日の14日後から出ない、規約とプライバシーポリシーのページには出ない。ページの上の「改定のお知らせ」も適用日の14日後から出ない（日付の欄は残る） | `apps/web/test/notice.test.tsx`；`apps/web/test/static.test.tsx`（利用規約・プライバシーポリシーの #17 の文と日付、14日後のお知らせ）；`tap-targets.spec.ts`（360px の帯） |

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
- [ ] 見た目（#20。デプロイの前にも）: 明るさを約 30% にして、ライト・ダーク・端末に合わせる の3つで、きょう（予約中のカード・押したカード）・シート・みんなのタブ・記録・設定・`/s/:id` を見る。ダークに明るい大きな塗りが無く、見出しが手書き（Klee One）で出る。メニューが4つで、えらぶ からレシピとガチャを行き来できる
- [ ] CUF-1 E: 機内モードで押す →「オフライン・あとで同期」と上部の帯 → 機内モード解除で「同期済み」
- [ ] PWA: ホーム画面に追加 → 機内モードでアイコンから開き、「きょう」と公式レシピが見える
- [ ] CUF-2: 30日前に始めたチャレンジを用意する（設定 → バックアップの読み込みで、開始日を30日前にしたバックアップ JSON を読み込む。形は `tests/e2e/fixtures.ts` の `pastChallenge`）→ 振り返る → 続ける → カード → リンクを作って共有 → 別のブラウザ（シークレット）で `/s/<id>` を開く
- [ ] OGP: `/s/<id>` を LINE（自分だけのトーク）と X の投稿画面に貼り、画像つきのカードが出る。`og:image` が `https://<CloudFront ドメイン>/media/share/<id>.png`。トップの URL を貼っても画像が出る
- [ ] 通報: `/s/<id>` の「このカードを通報する」→ お問い合わせ画面の通報フォーム → 送ると管理画面の通報一覧に出る。管理画面で「非表示」→（キャッシュの5分以内に）`/s/<id>` は 404、`/media/share/<id>.png` は 403（S3 は無いキーに 403 を返す。CloudFront には一覧の権限を与えていないため。404 でもよい）。「復元」で両方戻る。`/s/<id>` の下にフッター（このサービスについて・利用規約・プライバシーポリシー・お問い合わせ）
- [ ] CUF-3: 端末 A で今月開始、端末 B（別アカウント）の「みんな」に A が出る →「詳しく見る」で A の30マスが出る（見せていないひとこと・写真は出ない）→ 応援 → 応援済み → A が設定で公開 OFF → B の再読み込みで消える
- [ ] CUF-3 のひとこと（#17。参加者ではなく専用のテストアカウントで）: A がある日のひとことを「みんなに見せる」→ アカウントなしの `GET <SiteUrl>/api/members/<chId>/notes` にその日だけが出て、応答ヘッダが `Cache-Control: no-store` → A が「みんなに見せる」をオフ → 次の要求で `notes: []` → 見せ直してからひとことを書き換える → `notes: []`。dynalite と本物の DynamoDB で違いうる入れ子の条件（`attribute_not_exists(stamps.N.shownNote)`、無い入れ子の属性の REMOVE）と `Cache-Control: no-store` を、これで本物で確かめる（強い整合の読み込みは手作業でも見分けられない。API のテストで固定している）。リリース前後で管理画面の統計の人数が変わらない。最後にテストアカウントを「すべてのデータを削除」で消す

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
- **見せたひとこと（#17）の DynamoDB の差**: 入れ子の属性の条件（`attribute_not_exists(stamps.N.shownNote)`、`stamps.N.note = :note`）と、無い入れ子の属性の REMOVE は dynalite と本物で違いうるので、リリース後の Live smoke（専用のテストアカウント）で確かめる。`GET /api/members/:id/notes` と `PUT .../visibility` の強い整合の読み込み（ConsistentRead。見せられなかった理由を返す読み直しも）は、dynalite でも手作業の smoke でも違いが見えないので、API のテストが送る GetCommand を見て固定している（`apps/api/test/note-visibility.test.ts` "(q)", "(r)"）
- **古いタブ・古い PWA**: 古い版は見せる・戻すのルートを呼ばない。古い版でひとことを書き換えると API が「自分だけ」に戻すので、公開は増えない（API のテストで固定）。ただし古い版の画面は、見せたひとことについて事実と違う説明を出し続ける: ひとことの欄の「（自分だけに見えます）」（別の端末で見せたひとことにも出る）、「みんな」の「詳しく見る」の「ひとことメモと写真は、本人だけが見られます。」、「みんな」の説明の「ひとことは表示されません。」、設定の「表示されないもの：ひとことメモ…」。タブやアプリを読み込み直すまで続く（Service Worker の登録はページを読み込み直さず、古いハッシュ付きファイルも消さないので、古い版はそのまま動く）。データは出ない。和らげるのは「お知らせ」の帯（閉じなければ 2026-10-24 まで、適用日から見せられるようになると書いている）で、1段目より前の版には帯も無い。自動テストはしていない
- **持ち主の画面は、チャレンジが「みんな」に出ているかを知らない**（#17。既知の制約、コードは変えない）: 本人向けの応答に「1日組に出ているか」が無いので、読み込んだままのチャレンジや、管理・通報で1日組から外したチャレンジでも「みんなに見せる」をオンにできてしまい、API が 409（「この記録は「みんな」に表示されていないため、見せられません。」）で断る。見せたあとに管理・通報で外されたチャレンジのひとことは、誰にも見えていないのに「（みんなに見せています）」「「みんな」で誰でも見られます。」のまま。どちらも公開を実際より多く言う側で、何も漏れない（公開するかは API が読むたびに決める）。直すなら、本人向けの応答に `unlisted` を足してスイッチの説明を変える

## Not tested（意図的）

- 課金される外部 API（存在しない。AI は使わない）
- 負荷・性能（API p95 < 500ms、初回 JS < 250KB gzip）: 自動テストなし。ビルド出力の gzip サイズ（`npm run build -w apps/web`）と CloudWatch のレイテンシで目視確認する
- 見た目の回帰（スクリーンショット比較）: デザイン変更が続く MVP の間はしない。横スクロールだけ E2E で見る。#20 では 360px のライトとダークのスクリーンショットを PR に付ける（証拠であって、テストの代わりではない）
- アクセシビリティの自動監査（axe など）: しない。E2E を role / label で書くことで、名前のないボタンなどは間接的に見つかる
- 管理画面・引き継ぎコード・バックアップ・データ削除・写真メモ（IndexedDB）・レシピ / 体験談の投稿の E2E: CUF ではないので Unit / Integration のみ（データ削除は Live smoke で確認）
- タイムゾーンが日本以外の E2E: Unit / Integration（`packages/shared/test/`, `apps/api/test/`）で扱う
