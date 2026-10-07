# 0005. PILOT を始める（友人・同僚に URL を配る）。返信先と運営者表示は今のまま

- Status: Accepted
- Date: 2026-10-07
- Decider: CEO（Mizuki）

## Context

Gate 5（[#2](https://github.com/mizuki-majima/try_something_new/issues/2)）を通り、修正版を `https://d1zw3n37kpuo7t.cloudfront.net` にデプロイして Live smoke を通した。Gate 6（[#4](https://github.com/mizuki-majima/try_something_new/issues/4)）で残っていたのは、PROCESS.md §1 で CEO が決める2つ:

1. **本番公開**: PILOT（URL を友人・同僚 10人前後に配る）を始めてよいか
2. **個人情報**: お問い合わせの「返信先（任意）」を残すか、規約・プライバシーポリシーの運営者表示をどうするか（[#3](https://github.com/mizuki-majima/try_something_new/issues/3)、AI PM 決定 D12）

## Decision

CEO が 2026-10-07 に承認した。

- **PILOT を始める。** CEO が友人・同僚に URL を配る（AI は連絡しない）。最初の1日組は **2026-11-01** 開始、30日目は 2026-11-30。合格・停止の基準は [validation-plan.md](../validation-plan.md) のまま変えない
- **#3 は案A。** 返信先は任意入力のまま（返信のためだけに使い、内容とともに180日で消す）。運営者表示は「30日だけ 運営事務局（個人運営）」のまま、氏名・住所は請求があれば回答する。D12 の暫定扱いは解除し、PRODUCT.md の Do Not Build の例外として確定する

選ばなかった案:

- 返信先の欄をなくす（#3 の案B）: 削除依頼などに返事ができなくなる
- 氏名・連絡先を公開する（#3 の運営者表示の案B）: 公開リポジトリと公開サイトに個人の氏名を出すことになる。友人・同僚向けの PILOT では要らない

## Consequences

- Gate 6 は PASS。Phase は PILOT、次は Gate 7（PILOT → LIVE）
- コードの変更はない（今の実装が案A）
- 障害・費用の通知（`ALERT_EMAIL`）はまだ付けていない。通知先のメールアドレスが決まりしだい付けて再デプロイする。それまでは DynamoDB のスループットの上限（1時間あたりの速さ）だけが費用の歯止めで、障害や費用の増加にメールでは気づけない（週次レビューで AWS の請求とログを見る）
- **見直す条件**: 一般公開（Gate 7 の後）の前に、運営者表示（個人情報保護法 §32 の読み方）を専門家に確認する。PILOT の参加者以外に URL が広まったら CEO に報告する
