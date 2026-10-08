# Design — 白いノート

2026-10-08 CEO 依頼（[#20](https://github.com/mizuki-majima/try_something_new/issues/20)）:「手書きっぽい」「白をベースに」「夜で暗いとみにくい・色がきつい」「サステナブルなデザイン」「ページ構成をわかりやすく」。それまでのネオ・ブルータリズム（2026-10-06）をやめ、白いノートに手書きで書いたような見た目にする。決めたことと理由は [ADR 0008](decisions/0008-paper-notebook-redesign.md)。

**変えないもの**: 30マスのカード、朱の印、言葉づかい、URL、データ、API、公開する範囲。

## 原則

1. **白い紙と墨の文字** — ページは生成りの紙（`--bg`）、カードは白（`--surface`）、文字は墨色（`--ink`。真っ黒にしない）
2. **細い線と余白で区切る** — 区切りは 1px の `--rule`。部品の枠だけ 3:1 の `--line`。太い黒枠・ずらした影・方眼・斜線は使わない
3. **手書きは見出しだけ** — 見出し・ブランド・印・大きな数字は Klee One 600。本文・ボタン・入力・メモは端末のフォント（ダウンロード 0 バイト）
4. **色は2つだけ、淡く** — セージの緑（主ボタン・リンク・選択・きょう）と、印の朱。大きな面は淡い色だけ
5. **夜にまぶしくない** — ダークは「夜のノート」: 暗い灰色の紙（真っ黒ではない）、温かい白の文字。明るい大きな塗りはどこにもない
6. **状態は色だけで伝えない** — 太い枠・CSS で描いた ✓・文字・`aria-current` を添える
7. **動きは静かに** — 120〜240ms のフェードか小さな縮小だけ。繰り返す動きは無い。`prefers-reduced-motion` で全部止める
8. **傾けるのは印だけ**（-4deg）

## トークン（`apps/web/src/styles/tokens.css`）

ダークは同じ値を2か所に書く: `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`（端末がダークで、手動でライトを選んでいない）と `:root[data-theme="dark"]`（手動でダーク）。2つは必ず同じにする。`prefers-contrast: more` はその後ろで両方のテーマに効く（`--line` と `--rule` を墨に、`--border-ctl` を 2px、`--muted` をライト `#4F4A43`・ダーク `#CFC9BE`）。`--rule` も墨にするのは、カード全体のリンク（レシピ・記録のカード、メモの行、設定のリンク）の縁を見えるようにするため。

| トークン | ライト | ダーク | 用途 |
|---|---|---|---|
| `--bg` | `#FAF8F4` | `#1C1B19` | 紙。ページとヘッダー（`theme-color` と同じ） |
| `--bg-2` | `#F3F0EA` | `#211F1D` | 沈んだ面、hover |
| `--surface` | `#FFFFFF` | `#262522` | カード、シート、タブバー |
| `--ink` | `#34312C` | `#E6E1D8` | 文字 |
| `--muted` | `#6B655C` | `#A9A398` | 補足の文字 |
| `--line` | `#8C8579` | `#827C72` | **部品の枠だけ**（3:1）。ダークの `--accent-soft` の上では 2.84 なので、選択状態の枠には `--accent-ink` |
| `--rule` | `#E2DDD3` | `#3A3834` | **飾りの線とカードの縁**（1.28 / 1.47）。ボタン・チップ・入力の境界をこれだけで示さない。カード全体のリンクや一覧の行のボタン（自分の文字で何か分かるもの）は `--rule` の縁だけのことがあるので、`prefers-contrast: more` では墨にする |
| `--accent` | `#4A6B4E` | `#3E5A44` | 主ボタンの塗り（文字は `--on-primary`） |
| `--accent-hover` | `#3F5E43` | `#46654C` | 主ボタンの hover |
| `--accent-ink` | `#3F6B4A` | `#9CC3A0` | 緑の文字・リンク・選択の枠・フォーカス・タブの印 |
| `--accent-soft` | `#E6EEE3` | `#2F3B30` | 選択中・きょう・お知らせ |
| `--on-primary` | `#FFFFFF` | `#E6E1D8` | 主ボタンの文字 |
| `--primary-border` | = `--accent` | = `--accent-ink` | 主ボタンの枠（ダークは塗りと面の差が小さいので緑の文字色で縁取る） |
| `--shu` | `#B9553D` | `#D4866F` | 印の輪と字（図形）。**文字には使わない** |
| `--shu-ink` | `#A8452F` | `#E5A08C` | 赤の文字（警告・削除） |
| `--shu-soft` | `#F6E3DC` | `#3D2B26` | 淡い朱（押した日、エラーの面） |
| `--mist` / `--slate` | `#E3E9F0` / `#52637A` | `#2B333C` / `#A9B8CB` | 「形を変える」の面と文字 |
| `--sand` / `--amber-ink` | `#F2EAD9` / `#7A5A1E` | `#3A3427` / `#D8B878` | 注意の面と文字（429 の帯、「振り返り待ち」） |
| `--lavender` | `#ECE6F0` | `#35303C` | 淡い藤（ジャンル「やめる」） |
| `--gray-soft` | `#ECE8E1` | `#33312D` | 淡い灰（オフラインの帯、無効、「やめる」の判定） |
| `--overlay` | `rgba(52,49,44,.45)` | `rgba(0,0,0,.6)` | シートの覆い |
| `--shadow-float` | `0 12px 32px rgba(28,27,25,.16)` | なし | 浮くシート・ダイアログ・トーストだけ |
| `--float-border` | 透明 | = `--line` | ダークで浮くものに付ける 1px の枠（影の代わり） |
| `--toast-bg` / `--toast-fg` | 墨 / 紙 | `#2E2C29` / `--ink` | トースト |
| `--rule-faint` | 墨 6% | 白 5% | 罫線の模様（ヒーローと空の状態だけ） |
| `--photo-filter` | なし | `brightness(.92)` | 写真とカード画像を夜に少し暗く |

形と動き:

| トークン | 値 | 用途 |
|---|---|---|
| `--border` / `--border-thin` | `1px` | カード・区切り |
| `--border-ctl` | `1.5px` | ボタン・チップ・入力 |
| `--border-strong` | `2px` | きょう・選択中 |
| `--shadow` `--shadow-sm` `--shadow-lg` `--shadow-hover` `--shadow-press` | `0 0 #0000` | 影なし（`none` はカンマ区切りの中で無効になるので、この値） |
| `--radius` / `--radius-sm` / `--radius-lg` / `--radius-pill` | `12px` / `8px` / `16px` / `999px` | 角丸 |
| `--radius-hand` / `--radius-hand-sm` | 少しずつ違う4つの角 | 手で描いた箱（カード・シート・空の状態・ボタン） |
| `--press` | `120ms` | 押したときの変化 |
| `--tap` `--header-h` `--tabbar-h` | `44px` `56px` `64px` | タップ領域・固定バーの高さ（`--safe-top` `--safe-bottom` はノッチ） |

古い名前は別名として残している（ページの CSS は名前を変えずに動く）。新しいコードでは使わない: `--yellow` `--mint`→`--accent-soft`、`--blue`→`--mist`、`--pink`→`--shu-soft`、`--lilac`→`--lavender`、`--gray`→`--gray-soft`、`--on-accent`→`--ink`、`--link` `--mint-ink` `--ai` `--wakaba`→`--accent-ink`、`--amber`→`--amber-ink`、`--danger`→`--shu-ink`、`--shu-fill`→`--shu-soft`、`--on-shu`→`--shu-ink`、`--paper` `--soft`→`--bg`、`--r`→`--radius`。`--grid` と `--hatch` は透明。

**予備値は付けない**（`var(--x, #hex)` と書かない。前は「必ず付ける」決まりだったが、値が二重になり古い色が残るのでやめた）。代わりに、使うトークンがどこかで宣言されていること、`tokens.css` の外に生の `#hex` を書かないことを `apps/web/test/design-guard.test.ts` で確かめる（ほかに、ダークの2ブロックが同じこと、下のコントラストの表、硬い影・傾き・`::before` の文字が無いこと、`prefers-contrast: more`、フォーカスの輪、手書きの大きさ）。

ジャンル（`.cat-*`）: からだ=`--accent-soft`、あたま=`--mist`、手しごと=`--sand`、人と=`--shu-soft`、やめる=`--lavender`。ジャンル名の文字は必ず出す。
判定: 続ける=`--accent-soft` に `--accent-ink`、形を変える=`--mist` に `--slate`、やめる=`--gray-soft` に墨（枠は `--line`）。どれも傾けない。

### コントラスト（WCAG 2.x の計算値。文字 4.5、部品の枠と図形 3.0）

| 組み合わせ | ライト | ダーク |
|---|---|---|
| `--ink` on `--bg` / `--surface` / `--bg-2` | 12.21 / 12.95 / 11.38 | 13.22 / 11.77 / 12.61 |
| `--ink` on 淡い面（`--accent-soft` `--shu-soft` `--mist` `--sand` `--lavender` `--gray-soft`） | 10.45〜10.92 | 9.01〜10.26 |
| `--muted` on `--bg` / `--surface` / `--bg-2` | 5.44 / 5.77 / 5.07 | 6.87 / 6.12 / 6.55 |
| `--muted` on `--accent-soft` / `--shu-soft` / `--gray-soft` | 4.86 / 4.65 / 4.72 | 4.68 / 5.33 / 5.18 |
| `--on-primary` on `--accent` / `--accent-hover` | 5.99 / 7.26 | 5.86 / 5.00 |
| `--accent-ink` on `--bg` / `--surface` / `--accent-soft` | 5.80 / 6.15 / 5.19 | 8.79 / 7.83 / 6.00 |
| `--shu-ink` on `--bg` / `--surface` / `--shu-soft` | 5.57 / 5.90 / 4.76 | 7.98 / 7.11 / 6.20 |
| `--slate` on `--surface` / `--mist` | 6.13 / 5.02 | 7.59 / 6.34 |
| `--amber-ink` on `--surface` / `--sand` | 6.35 / 5.30 | 8.06 / 6.50 |
| `--toast-fg` on `--toast-bg` | 12.21 | 10.69 |
| 枠: `--line` on `--surface` / `--bg` / `--bg-2` | 3.65 / 3.45 / 3.21 | 3.70 / 4.16 / 3.97 |
| 図形: `--shu` on `--surface` / `--bg` / `--shu-soft` | 4.74 / 4.47 / 3.82 | 5.43 / 6.10 / 4.73 |

ダークの主ボタンは塗りと面の差が 2.01 しかないので、`--primary-border`（`--accent-ink`。面に対して 7.83）で縁取る。

## 書体

- **手書き**: Klee One 600（`@fontsource/klee-one` の `600.css` だけ。OFL-1.1。自前で配信し、CSP の `font-src 'self'` のまま）。`--font-hand`
- **本文**: 端末のフォント（`-apple-system`、Hiragino Sans、Noto Sans JP、Yu Gothic UI、Meiryo、`system-ui`）。`--font-body`。強調のラベルと数字（`--font-display` `--font-num`）も端末のフォントの 700
- 手書きを使うのは 17px 以上で表示するもの: h1〜h3、`.h1` `.h2` `.h3`、ブランド、ページの大きな見出しと数字（きょうの日付・カードの題名・N/30、記録の合計、404 の数字など）、手順の番号（17px）。**例外は印の字だけ**で、輪の大きさに合わせてどの大きさでも手書き（小さい印 `.seal.sm` は 13px、記録のメモの印は 12px、30マスの印は `min(28px, 5.2vw)` で 320px 幅では約 16.6px）
- 使わないもの: ボタン、チップ、タブ、タグ、入力欄、同期の表示、セルの日付（12px）、設定の小見出し（`.set-sub`、15px の端末のフォントの 700）、管理画面、引き継ぎコード（読み間違えないように）、メモの本文。h1〜h3 は手書きになるので、17px より小さくする見出しは `font-family: var(--font-body)` に戻す（E2E の `smoke` が画面ごとに確かめる）
- 本文 16px・行間 1.75・字間 .02em。見出しは字間 .04em。h1 26 / 30px、h2 20 / 22px、h3 17 / 18px（スマホ / 760px 以上）。ヒーローの h1 は 30 / 38px。小さい文字 14px、タブのラベルとセルの日付 12px
- Klee は 600 の1ウェイトだけ。`font-synthesis: style` のまま（疑似太字は出ない）
- 日本語の見出しは `word-break: auto-phrase`（文節で折り返す。Chromium のみ）と `text-wrap: balance`
- 読み込みは `lib/fonts.ts` の `loadFonts()`。`navigator.connection.saveData` か `(prefers-reduced-data: reduce)` のときは woff2 を読み込まない（見出しは端末の丸ゴシックなどで出る）。ただし2つ例外がある: (1) シェアカードを描くときは `loadFonts({ force: true })` で Klee One を読む（カードの画像に手書きを使うため）。読んだあとは、再読み込みするまでページの見出しも手書きになる。(2) `@font-face` を並べた CSS（`assets/fonts-*.css`、gzip 約 31KB）は Service Worker が最初に入るときに先読みのキャッシュに入れる（woff2 は入れない）。canvas の指定は `FONT_STACKS`（`'600 56px "Klee One"'`）

## ナビゲーションと画面の並び

| | 中身 |
|---|---|
| メニュー | スマホは下のタブバー、760px 以上は上のナビ。どちらも `aria-label="メニュー"` で、同じ4つ: **きょう**（`/`）／**えらぶ**（`/recipes`。レシピとガチャ）／**みんな**（`/together`）／**記録**（`/log`）。`/gacha` にいるときは えらぶ の行き先も `/gacha` のまま（`tabTarget`。今のタブを押しても同じページで、ガチャの結果とひらめき提案が消えない） |
| 選択中のタブ | `Layout.tsx` の `activeTab(pathname, challenges)`。`/recipes`・`/recipes/*`・`/gacha` は えらぶ。`/c/:id` と `/c/:id/reflect` は、そのチャレンジが振り返り済み（`done`）なら 記録、ほかは きょう（再読み込みしても、カレンダーの予定から開いても同じ） |
| 設定 | ヘッダーの右に、歯車と「設定」の文字の 44px の丸い形（名前はちょうど「設定」）。400px 未満は歯車の下に 12px の文字を置く 44×44。設定のページでは `aria-current="page"` |
| えらびかた | `/recipes` と `/gacha` の h1 の上に `<nav aria-label="えらびかた">`（`ChooseNav.tsx`）: 「レシピ」「ガチャ」の2つで1つの形、各 44px 以上、今のページに `aria-current="page"`。`/recipes/:id` と `/recipes/new` には置かない（「レシピ一覧」の戻るリンク） |
| フッター | すべての画面の下に「このサービスについて・利用規約・プライバシーポリシー・お問い合わせ」（並びは変えない） |
| きょう | 初めての人: ヒーロー（「レシピから選ぶ」＝緑の主ボタン、「ガチャで決める」＝枠だけのボタン、「自分で決める」＝文字のボタン）。続けている人: カード（印・題名・状態のタグ・N/30 → 30マス → 主な操作1つ → 「詳細・メモ」「ここで区切る」）、次の1日組、「もうひとつ試す？」（控えめなリンクの列）、「振り返りを終えた30日」 |
| 記録 | 続けている30日があるときだけ「続けている30日は「きょう」にあります。きょうを開く」→ 終わった30日 → まとめ（試した数・押した印の合計・判定の内訳）→ メモ |
| チャレンジ | 戻るリンクは状態で決める: 振り返り済みなら「記録」（`/log`）、ほかは「きょう」（`/`） |
| 設定 | 表示（テーマ）を一番上に。アカウントあり: 表示 → プロフィール → リマインド → 引き継ぎ → バックアップ → データ削除 → リンクと版。なし: 案内 → 表示 → 引き継ぎ → リンクと版。ジャンプのリンクも同じ順 |
| みんな | 並びは変えない（h1・説明 → 公開される範囲の説明 → 今月の組 / 次の1日組 / 先月の組）。公開の説明は目立ち方を下げない |

URL は変えていない。将来パスを変えるときは `<Navigate replace>` で search と hash を引き継ぐ。

## 部品

| 部品 | 見た目 |
|---|---|
| ヘッダー | 紙の色（`--bg`）、下に 1px の `--rule`、56px。ブランドは輪の印（28px）と Klee の「30日だけ」。同期の表示は枠なしで、8px の点と 12px の文字（同期済み＝緑、同期中・送信待ち＝`--amber-ink`、オフライン・この端末＝中抜き、エラー＝`--shu-ink` の文字と下線） |
| タブバー（スマホ） | `--surface`、上に 1px の `--rule`、64px＋セーフエリア、4つを等分。選択中はアイコンの上に 24×3px の緑の線、緑の 700 の文字 |
| 上のナビ（PC） | 15px の文字のリンク。選択中は緑で 2px の下線（offset 6px） |
| 帯 | 画面の流れの中（`position: static`）、下に 1px の `--rule`。オフライン＝`--gray-soft`、429＝`--sand` に `--amber-ink`、壊れたセッション＝`--shu-soft` に `--shu-ink` のリンク、お知らせ＝`--accent-soft`（閉じるは 44×44） |
| ボタン `.btn` | 48px 以上（`.sm` 44・`.lg` 56）、`--radius-hand-sm`、`--border-ctl` の `--line`、白。hover は `--bg-2`、押すと `--gray-soft` で 1px 下がる。`.primary` は緑の塗り（ボタンの塗りに朱は使わない）、`.danger` は `--shu-ink` の文字と枠、無効は点線と `--gray-soft` |
| チップ `.chip` | 44px 以上の丸い形。選択中は `--accent-soft`、2px の `--accent-ink`、CSS で描いた ✓（`content: ""` と枠線。文字の ✓ はアクセシブルな名前に入るので使わない） |
| 入力 | 48px 以上、`--border-ctl` の `--line`、角丸 10。フォーカスはほかの部品と同じ 2px の `--accent-ink` の輪（2px 外）に、枠の `--accent-ink` と `0 0 0 3px var(--accent-soft)` の光を添える（色の変化だけにしない）。`aria-invalid` は 2px の `--shu-ink` |
| カード `.card` | 白、1px の `--rule`、`--radius-hand`、影なし。`.box` は `--bg-2` の面。`.h3` の前に 12×3px の緑の線 |
| 印（Seal） | 中は透明、1.75px の `--shu` の輪（sm は 1.5px）、Klee の朱の字、-4deg。26 / 40 / 52 / 64px。`.inv` は主ボタンの上で輪と字を `--on-primary` に |
| 30マス | 6列、間隔 6px（400px 以下は 4px）。セルは 1px の `--line`、角丸 8、左上に 12px の日付。きょう＝2px の `--accent-ink` と `--accent-soft`、押した日＝`--shu-soft` の上に朱の輪の印、未来＝点線、選択中（チャレンジの画面で下に出している日）＝枠の内側に 2px の墨の輪（`box-shadow: inset`。きょうの緑の枠も残り、outline はフォーカスの輪に使う）。360px でセル一辺 46.3px |
| MiniGrid30 | 1px の `--line` の四角。押した日＝朱の塗り、きょう＝2px の緑の枠 |
| シート・ダイアログ | 白。スマホは上の角丸 20 と 36×4 の取っ手、PC と中央のダイアログは角丸 16 で、ライトは `--shadow-float`、ダークは 1px の `--line`。200ms のフェードと 8px の上昇 |
| トースト | `--toast-bg` に `--toast-fg`。ダークは 1px の枠。エラーは左に 4px の `--shu-ink` |
| 状態 | 読み込み中は文字だけ。空の状態は罫線の上の点線の手描きの箱と Klee の一言とボタン1つ。エラーは `--shu-soft` に `--shu-ink` の見出し |
| その他 | `.hl` とヒーローの `<mark>` は下側に淡い緑のマーカー。`.person.me` は左に 3px の緑の線。長い注意（`.set-warn` など）は白い箱に 3px の `--amber-ink` の線 |
| フォーカス | `:focus-visible` で 2px の `--accent-ink` の輪を 2px 外に（紙・カード・淡い面の上で、両方のテーマで 3:1 以上）。選択中の見た目に outline を使わない（使うとフォーカスの輪が消える）。えらびかた は外側が切れるので輪を内側に（4px 内） |
| forced-colors | 塗りと影が消えるので、選択中のチップ・ラジオ・判定・きょうのセルに `outline: 2px solid Highlight`（1px 外）、選択中の日は 4px の二重線の枠、えらびかたの今のページは太字と下線。そのあとに、フォーカスは `outline: 3px solid CanvasText`（3px 外）の規則を置いて、選択中の要素でもフォーカスが分かるようにする |

## シェア用カード（1200×630。canvas、いつもライト）

紙の地（`#FAF8F4`）に白いカード（枠 2px の `--rule`、影なし）。左に朱の輪の印、右に Klee の題名、判定のラベル（続ける `#4A6B4E`・形を変える `#52637A`・やめる `#6B655C` の塗りに白い字。5.99 / 6.13 / 5.77）、押せた日数「23 / 30」、30マス（押した日は淡い朱に輪の印）、ひとこと（端末のフォント）。右下に「30日だけ」。すでに作ったカードの画像は古い見た目のまま。

`/s/:id`（サーバで作る HTML）は Web フォントを読まない。インラインの CSS にライトと OS のダークの色を持ち、`.display` は端末の丸ゴシックの 700。`theme-color` は `#FAF8F4` と、media 付きのダーク用 `#1C1B19`。

## アイコン・OGP

アイコンは紙色（`#FAF8F4`）のタイルに朱（`#B9553D`）の丸と紙色の「卅」（16〜48px でも読めるよう、字に紙色の細い縁）。favicon.svg はダークで タイル `#1C1B19`・丸 `#D4866F`・字 `#1C1B19`。`og-default.png` は紙の地に白いカード、輪の印、Klee の「30日だけ」。

生成は `PLAYWRIGHT_BROWSERS_PATH=<ブラウザの場所> node apps/web/scripts/gen-icons.mjs`。「卅」は `klee-one-japanese-600-normal.woff`（glyf の表がある）の字形をパスにしている。枚数と寸法は変えない。ホーム画面に追加済みのアイコンは古いまま。

## Classes（ページを作る人向け）

実装は `apps/web/src/styles/{tokens,base,components}.css`。ページ固有の CSS はページの隣に置き、ここのトークンとクラスを組み合わせる。

| クラス | 内容 |
|---|---|
| `.stack`（`.sm` / `.lg`） | 縦並び（grid）。間隔 14px（8px / 24px） |
| `.row` `.gap` `.gap-lg` `.wrap`（= `.fw`） `.between` `.grow` `.center` `.mt` `.mt-lg` | 横並びと余白。ページの列は `main.wrap`（Layout）なので、`.wrap` を列のつもりで使わない |
| `.pagehead` | ページ見出しと操作の行（狭いと折り返す） |
| `.h1` `.h2` `.h3` | 見出し（Klee）。`.h3` は前に短い緑の線 |
| `.note` / `.muted` / `.note.err` | 補足 / 補足の色 / エラーの文 |
| `.display` / `.num` | 端末のフォントの 700 / 数字 |
| `.hl` | 淡い緑のマーカー（数語だけ） |
| `.card` `.box` | 白いカード / 沈んだ面 |
| `.fill-*` `.cat-*` | 淡い面（古い名前）/ ジャンルの色（`--cat`） |
| `.btn`（`.primary` `.ghost` `.danger` `.danger.solid` `.lg` `.sm`）`.stampbtn` `.linkbtn` `.iconbtn` `.backlink` `.top-settings` | ボタンとリンク |
| `.chips` > `.chip`、`.form` `.field` `.radio` `.check` | チップとフォーム |
| `<Seal>` `<Grid30>` `<MiniGrid30>` | 印（`.seal` `.sm` `.lg` `.xl` `.inv`）、30マス（`.grid30` `.cell` `.today` `.future` `.locked` `.selected` `.st` `.st.new`）、ミニ30マス（`.mini`） |
| `.badge`（`.continue` `.modify` `.stop`）`.tag` `.pill` | 判定・タグ |
| `<Loading>` `<EmptyState>` `<ErrorState>` `<Sheet>` `<ConfirmDialog>` `useToast()` `.band` | 状態・シート・トースト・帯 |
| `<ChooseNav current>` | えらびかた（レシピ / ガチャ） |

単体テストがクラス名を使っているので変えない: `.cell` `.today` `.future` `.st` `.st.new` `.td-count` `.lp-stat-tried` `.lp-stat-stamps` `.badge` `.mn-item` `.who` `.me` `.rp-title` `.consent-note`。記録のメモの `li` の className は `lp-note` だけ（完全一致で比べている）。

## 動き

- 押せるもの: 背景色の変化（120ms）と、押したときの 1px の沈み。hover は `(hover: hover)` の端末だけで、浮き上がらない
- 30マスの印: `stampIn`（200ms。少し大きいところから薄く現れて落ち着く）。跳ねる・揺れる動きは無い
- シートは 200ms のフェードと 8px の上昇。トーストは 200ms
- `prefers-reduced-motion: reduce` で animation / transition をすべて止める（base.css）。ページごとのブロックも残す

## ブラウザの色（4か所を同時に変える）

- `index.html` の `theme-color`: ライト `#FAF8F4`、ダーク `#1C1B19`（ヘッダーの `--bg` と同じ）
- `lib/theme.ts` の `THEME_COLORS = { light: "#faf8f4", dark: "#1c1b19" }`
- `vite.config.ts` の manifest: `theme_color` と `background_color` は `#FAF8F4`
- `apps/api/src/share-page.ts`: `theme-color` `#FAF8F4` と media 付きのダーク用 `#1C1B19`
- `color-scheme: light dark` と apple の status bar `default` はそのまま。`light-dark()` は使わない（iOS 17.5 未満で効かない）

テーマの選び方（FR-21）は変えていない: 端末に合わせる（初期値）／ライト／ダーク。`localStorage` の `thirty-days.theme`、`<html>` の `data-theme`。設定の「表示」に「ダークは、暗い部屋でもまぶしくない落ち着いた色です。」。

手動の選択は最初の描画の前に入れる: `index.html` の `<head>` で `/theme-boot.js`（`apps/web/public/`。ブロックする小さな古典的なスクリプト。CSP は `script-src 'self'` のまま、SW の先読みのキャッシュに入る）が `data-theme` と2つの `theme-color` を選んだテーマにする。これが無いと、端末がライトで「ダーク」を選んだ人に、毎回の読み込みで白い画面が一瞬出る。アプリの `applyTheme()`（`main.tsx`）はそのまま残り、選び直したときもこれが動く。ホーム画面から開くときのスプラッシュ（manifest の `background_color`）はライトのまま。

## サステナビリティ

- フォントは2ファミリー・4ウェイト（Dela Gothic One・Zen Kaku Gothic New 400/700/900）から、1ファミリー・1ウェイト・見出しだけ（Klee One 600）に。本文は端末のフォント
- 配る woff2: 486 ファイル（5,740,556 B）→ 124 ファイル（3,488,988 B）。フォントの CSS: gzip 122,516 B → 31,546 B。`apps/web/dist`: 7,064,270 B → 4,464,092 B（#20 の3つのコミットのあとのビルドで実測）
- Save-Data と `prefers-reduced-data` のときは woff2 を読まない（例外: シェアカードを描くときは読み、その後はページの見出しも手書きになる。`@font-face` の CSS は SW が先読みする。上の「書体」）
- Service Worker のフォントのキャッシュは `fonts-v2`（160 件まで。Klee One 600 は 124 ファイル）。新しい SW が有効になるとき、前のフォントの部分ファイルが入った `fonts`（400 件まで）とその期限の記録を消す（`sw.ts`、`lib/swCaches.ts`）
- 画像・SVG の飾り・data: URI を足さない（紙の罫線は CSS のグラデーションだけ）。アイコンと OG は同じ枚数と寸法
- ダークは暗い灰で、真っ黒ではない。目的は夜の見やすさ（OLED の省電力は明るさ 30〜50% で 3〜9% と小さい）
