# Design — ネオ・ブルータリズム

2026-10-06 CEO 指定「ネオ・ブルータリズムなデザインがいい」。前回のアーティファクトの **構造と言葉づかい**（30マスのカード、朱色の印、方眼、タブ構成）は引き継ぎ、**見た目** をネオ・ブルータリズムにする。

## 原則

1. **太い黒線** — 枠線は 3px のインク色。カード・ボタン・入力・タブ・チップすべて
2. **ずらし影** — ぼかしゼロの影 `5px 5px 0 var(--ink)`。押すと影がつぶれて沈む
3. **フラットな原色** — グラデーション・半透明・ぼかし（backdrop-filter）を使わない
4. **大きく太い文字** — 見出し・数字・印は Dela Gothic One。本文は Zen Kaku Gothic New（400 / 700 / 900）
5. **ステッカー感** — バッジ・印・判定は少し傾ける（-2〜-8deg）
6. **読みやすさは譲らない** — 本文コントラスト AA、タップ領域 44px、`prefers-reduced-motion` で動きを止める

## トークン

| トークン | ライト | ダーク | 用途 |
|---|---|---|---|
| `--bg` | `#FFF4D6` | `#141414` | ページ背景（方眼はインク 8% の 1px 線、24px 間隔） |
| `--surface` | `#FFFFFF` | `#1F1F1F` | カード・入力 |
| `--ink` | `#111111` | `#F7F3E8` | 文字・枠線・影 |
| `--muted` | `#4A4A4A` | `#C9C4B8` | 補足文字（AA を満たす） |
| `--shu` | `#FF4B2B` | `#FF5A3C` | 朱。印・主ボタン。**上に載せる文字は `--on-accent`（#111）** |
| `--yellow` | `#FFD43B` | `#FFD43B` | 今日・選択中・強調 |
| `--mint` | `#3DDC97` | `#3DDC97` | 続ける・成功・からだ |
| `--blue` | `#6C8CFF` | `#7C98FF` | 形を変える・リンク・あたま |
| `--pink` | `#FF9EC7` | `#FF9EC7` | 人と・応援 |
| `--lilac` | `#B9A2FF` | `#B9A2FF` | やめる（ジャンル） |
| `--gray` | `#E6E1D3` | `#3A3A3A` | やめる（判定）・無効 |
| `--on-accent` | `#111111` | `#111111` | 色付きの面の上の文字（ダークでも黒） |
| `--border` | `3px` | | 枠線の太さ（細部は 2px） |
| `--shadow` | `5px 5px 0 var(--ink)` | | 大きいカードは `6px 6px 0` |
| `--radius` | `12px` | | ボタン・カード。チップは 999px、30マスのセルは 8px |

ジャンルの色: からだ=mint、あたま=blue、手しごと=yellow、人と=pink、やめる=lilac。
判定の色: 続ける=mint、やめる=gray、形を変える=blue。

## 部品

| 部品 | 見た目 |
|---|---|
| ボタン | 枠 3px・影 5px。hover で `translate(-2px,-2px)` と影 7px、active で `translate(3px,3px)` と影 2px（100ms）。主ボタンは朱、副ボタンは白、危険は白地に朱の文字と枠 |
| カード | 白・枠 3px・影 6px・角丸 12px。見出しは Dela Gothic One |
| チップ | 枠 2px のピル。選択中は黄色の面 |
| 入力 | 枠 3px。フォーカスで黄色の影 `4px 4px 0 var(--yellow)` ＋ 枠はインク |
| ヘッダー | 白、下に枠 3px。ロゴは印「卅」＋「30日だけ」（Dela Gothic One） |
| タブバー（スマホ） | 上に枠 3px。選択中のタブは黄色のブロック（枠つき） |
| 30マス | 6列。セルは枠 2px・角丸 8px。今日は黄色の面＋枠 3px。未来は斜線のハッチ。押した日は朱の丸（枠 2.5px）に印の漢字（インク色）、-8deg。押した瞬間に「ドン」と縮んで戻る |
| 印（Seal） | 朱の丸・枠 3px・影 3px・漢字はインク色・-6deg |
| バッジ | 色の面＋枠 2px、-2deg |
| トースト | インクの面にクリーム色の文字、枠 3px |
| シート | 枠 3px、上の角丸 16px、影なし（オーバーレイは不透明度 60% のインク） |

## シェア用カード（1200×630）

クリーム色の背景に方眼、中央に白いカード（枠 6px・影 12px）。左に大きな印、右にタイトル（Dela Gothic One）、判定ステッカー（色の面・傾き）、押せた日数「23 / 30」、30マス、ひとこと。右下に「30日だけ」のロゴ。

## アイコン・OGP

アイコンは朱の丸に「卅」、枠と影はインク。maskable はセーフゾーン内に収める。`og-default.png` も同じ世界観。

生成は `PLAYWRIGHT_BROWSERS_PATH=<ブラウザの場所> node apps/web/scripts/gen-icons.mjs`。「卅」は Dela Gothic One の字形をそのままパスにしている（favicon.svg はフォント不要。ダークのタブでは枠と影がクリーム色になる）。

## Classes（ページを作る人向け）

実装は `apps/web/src/styles/{tokens,base,components}.css`。基盤のクラス名はそのままで、見た目だけをネオ・ブルータリズムにした。ページ固有の CSS はページの隣に置き、ここにあるトークンとクラスを組み合わせる。トークンには必ずフォールバックを付ける（例: `var(--yellow, #ffd43b)`）。

### 追加のトークン

| トークン | ライト | ダーク | 用途 |
|---|---|---|---|
| `--shu-ink` | `#C42B0E` | `#FF6A4F` | 朱色の**文字**。小さい文字に `--shu` を使わない |
| `--link` | `#2F4FD6` | `#8FA6FF` | リンクの文字（下線 2px） |
| `--mint-ink` | `#0B7343` | `#3DDC97` | 成功の文字（`.ok`） |
| `--amber-ink` | `#855600` | `#FFD43B` | 注意の文字 |
| `--border-thin` | `2px` | | 細部の枠（チップ・バッジ・マス） |
| `--shadow-sm` / `--shadow-lg` / `--shadow-hover` / `--shadow-press` | `3px` / `6px` / `7px` / `2px` のずらし影 | | 小さい部品 / カード / hover / 押した瞬間 |
| `--radius-sm` / `--radius-lg` / `--radius-pill` | `8px` / `16px` / `999px` | | マス / シート / チップ |
| `--grid` | インク 8% | クリーム 8% | 方眼の線 |
| `--hatch` | インク 22% | | 斜線のハッチ（未来のマス、`.hatch`） |
| `--overlay` | `rgba(17,17,17,.6)` | `rgba(0,0,0,.7)` | シートの背景。ダークでクリームを重ねると明るくなるので黒 |
| `--muted-base` | = `--muted` | | 色の面が `--muted` を上書きしたとき、中の白いカードで元に戻すため |
| `--font-display` / `--font-body` / `--font-num` | Dela Gothic One / Zen Kaku Gothic New / = display | | |
| `--press` | `100ms` | | 押して沈む時間 |
| `--tap` `--header-h` `--tabbar-h` `--safe-top` `--safe-bottom` | `44px` `60px` `68px` | | タップ領域・固定バーの高さ・ノッチ |

基盤の古い名前も動くが、新しいコードでは使わない: `--paper`→`--bg`、`--soft`→`--bg`、`--line`→`--ink`、`--shu-fill`→`--shu`、`--on-shu`→`--on-accent`、`--ai`→`--link`、`--wakaba`→`--mint-ink`、`--amber`→`--amber-ink`、`--danger`→`--shu-ink`、`--r`→`--radius`。

### コントラスト（WCAG 2.x の計算値）

上のトークン表の色は変更なしで AA を満たした。

| 組み合わせ | ライト | ダーク |
|---|---|---|
| `--on-accent` on `--shu` / `--yellow` / `--mint` / `--blue` / `--pink` / `--lilac` | 5.66 / 13.25 / 10.68 / 6.14 / 9.86 / 8.70 | 6.10 / 13.25 / 10.68 / 7.01 / 9.86 / 8.70 |
| `--ink` on `--bg` / `--surface` / `--gray` | 17.23 / 18.88 / 14.45 | 16.62 / 14.87 / 10.26 |
| `--muted` on `--bg` / `--surface` / `--gray` | 8.09 / 8.86 / 6.78 | 10.59 / 9.48 / 6.54 |
| `--shu-ink` on `--bg` / `--surface` | 5.18 / 5.68 | 6.52 / 5.83 |
| `--link` on `--bg` / `--surface` | 5.97 / 6.54 | 7.95 / 7.12 |
| `--mint-ink` / `--amber-ink` on `--surface` | 5.92 / 6.31 | 9.33 / 11.56 |

`--shu` を白に載せた文字は 3.34（大きい文字 24px 以上か 18.7px 以上の太字だけ可）、`--blue` は 3.07（文字に使わない）。ダークの `--gray` の上の文字は `--on-accent` ではなく `--ink`。

### 書体

- 見出し（h1〜h4、`.h1` `.h2` `.display` `.num`）・数字・印は Dela Gothic One。1 ウェイトしかないので合成の太字は `font-synthesis: style` で止めている。`font-weight: 900` はフォント読み込み前の代替フォントを太くするだけ
- 本文は Zen Kaku Gothic New 400 / 700 / 900。500 は読み込まない（400 で表示される）。強調は 700
- 日本語の見出しは `word-break: auto-phrase`（文節で折り返す。Chromium のみ、ほかは無視）
- canvas に描くときは `lib/fonts.ts` の `loadFonts()` と `FONT_STACKS`。Dela は `'400 48px "Dela Gothic One"'` で指定する（bold にしない）

### レイアウト・ユーティリティ

| クラス | 内容 |
|---|---|
| `.stack`（`.sm` / `.lg`） | 縦並び（grid）。間隔 14px（8px / 24px） |
| `.row` | 横並び（flex）、縦は中央 |
| `.gap` / `.gap-lg` | 間隔 8px / 16px |
| `.wrap`（= `.fw`） | 折り返し（flex-wrap）。ページの列は `main.wrap`（Layout）なので、`.wrap` を列のつもりで使わない |
| `.between` / `.grow` / `.center` | 両端揃え / 残りを埋める / 中央寄せ |
| `.mt` / `.mt-lg` | 上の余白 18px / 32px |
| `.pagehead` | ページ見出しとボタンの行（狭いと折り返す） |
| `.h1` `.h2` `.h3` | 見出し。`.h3` は朱の四角が付く小見出し |
| `.note` / `.muted` / `.note.err` | 補足 13px / 補足の色 / エラーの文 |
| `.display` / `.num` | Dela Gothic One / 数字（Dela・等幅） |
| `.sticker`（`.r`） | ステッカーの傾き -3deg（逆向き 2.5deg） |
| `.hatch` | 斜線のハッチ |
| `.hl` | 黄色のマーカー（数語だけ） |
| `.card`（`.flat`） | 白・枠 3px・影 6px・角丸 12px（`.flat` は影なし） |
| `.box` | 枠 2px・クリームの面・影なし（カードの中の囲み） |
| `.fill-yellow` `.fill-mint` `.fill-blue` `.fill-pink` `.fill-lilac` `.fill-shu` `.fill-gray` `.fill-cat` | 色の面。文字と中の `.muted` は `--on-accent` になる。中で `color: var(--ink)` を直接書かない（ダークで読めなくなる） |
| `.cat-body` `.cat-mind` `.cat-hands` `.cat-people` `.cat-quit` | `--cat` を mint / blue / yellow / pink / lilac にする。`.badge` `.tag` `.fill-cat` が使う |

### 部品のクラス

| 部品 | クラス |
|---|---|
| ボタン | `.btn`（副ボタン・白）、`.primary`（朱）、`.ghost`（透明・影なし、hover で黄色）、`.danger`（白地に朱の文字・枠・影）、`.danger.solid`（朱の面）、`.lg`（幅いっぱい・56px）、`.sm`（影 3px）、`.grow`、`.stampbtn`（「今日の印を押す」。Dela 20px・影 6px。印は `<Seal inverse>` で黄色）。`disabled` / `aria-disabled="true"` はグレーの面・影なし |
| 文字のボタン | `.linkbtn`（`.danger`）、`.iconbtn`（44px。hover と `aria-current="page"` で黄色のブロック）、`.backlink` |
| チップ | `.chips` > `.chip`。`.on` / `aria-checked` / `aria-pressed` で黄色の面。`disabled` は点線 |
| フォーム | `.form` `.field` `.field-hint` `.field-err` `.counter` `.radio`（選ぶと黄色）`.check` `.seal-pick` `.two`。`input` / `textarea` / `select` は素のままで枠 3px、フォーカスでインクの縁つきの黄色い影、`aria-invalid` で朱の枠と影 |
| 印・30マス | `<Seal>`（`.seal` `.sm` `.lg` `.xl` `.inv`）、`<Grid30>`（`.grid30` `.cell` `.today` `.future` `.locked` `.selected`＝青 `.st` `.st.new`）、`<MiniGrid30>`（`.mini`：押した日＝朱、今日＝黄） |
| バッジ・タグ | `.badge`（`.continue`＝mint、`.stop`＝gray、`.modify`＝blue、または `.cat-*`。-2deg）、`.tag`（`.story`＝mint、`.cat-*`）、`.pill`（`.today`＝mint、`.same`＝blue、`.first`＝朱） |
| 状態 | `<Loading>` `<EmptyState>` `<ErrorState>`（`.loading`＝跳ねる3色の四角、`.empty`＝点線の枠、`.errorbox`＝朱の影） |
| シート・ダイアログ | `<Sheet>` `<ConfirmDialog>`。下から出るシートは影なし。中央に出るもの（ダイアログと PC のシート）は浮いて見えるようにずらし影 6px |
| トースト・帯 | `useToast()`（インクの面にクリームの文字・黄色の影。エラーは朱の面）、`.band`（オフライン＝黄色、`.band.warn`＝朱） |
| 画面用（基盤から引き継ぎ） | `.chhead` `.daynum` `.actions` `.waitbox` `.endbox` `.teaser`（ピンク）`.hero` `.ctas` `.steps`/`.step`（黄・ミント・ピンク）`.rlist` `.recipe` `.rhead` `.rtitle` `.lead` `.how` `.story` `.gf` `.gl` `.slot`（`.spin` はハッチ）`.people` `.person`（`.me` は朱の影）`.ptop` `.verdicts` `.verdict`（選ぶと判定の色で少し傾く）`.stats` `.notes` `.note-row` `.daynote` `.sharecard` `.cardph` `.quote` `.kv` `.meta` |

### 動き

- 押せるもの: `transform` と影を 100ms。hover の浮き上がりは `(hover: hover)` の端末だけ
- 30マスの印: `stampIn`（420ms。大きく落ちて縮み、戻る）とマスが沈む `stampHit`
- `prefers-reduced-motion: reduce` で animation / transition をすべて止める（base.css）

### ブラウザの色

- `theme-color` はヘッダーの色（ライト `#FFFFFF` / ダーク `#1F1F1F`）。`index.html` と `lib/theme.ts` の `THEME_COLORS` をそろえる
- manifest は `theme_color #FFFFFF`、`background_color #FFF4D6`（起動画面はクリーム）
