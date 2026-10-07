# 0005. PILOT を始める（友人・同僚に URL を配る）。返信先と運営者表示は今のまま

- Status: Accepted
- Date: 2026-10-07
- Decider: CEO（Mizuki。2026-10-07 に AI PM とのセッションで「承認します」と回答）

## Context

Gate 5（[#2](https://github.com/mizuki-majima/try_something_new/issues/2)）を通り、修正版を `https://d1zw3n37kpuo7t.cloudfront.net` にデプロイして、本番環境で **Chromium の自動スモーク**（スマホ幅と PC 幅で開始→押す→再読込、振り返り→公開リンク→OGP 画像、1日組→応援、セキュリティヘッダ）を通した。[docs/test-plan.md](../test-plan.md) の **Live smoke（実機の iPhone と Android での確認）はまだ**。

Gate 6（[#4](https://github.com/mizuki-majima/try_something_new/issues/4)）で残っていたのは次の4つ。1と2は PROCESS.md §1 で CEO が決める:

1. **本番公開**: PILOT（URL を友人・同僚 10人前後に配る）を始めてよいか
2. **個人情報**: お問い合わせの「返信先（任意）」を残すか、規約・プライバシーポリシーの運営者表示をどうするか（[#3](https://github.com/mizuki-majima/try_something_new/issues/3)、AI PM 決定 D12）
3. **障害・費用の通知**: `ALERT_EMAIL` を付けて再デプロイする（通知先のメールアドレスが要る）
4. **実機での Live smoke**: 自動テストは Chromium だけなので、iPhone（WebKit）と Android で CUF・PWA・Web Push を確かめる

## Decision

CEO が 2026-10-07 に1と2を承認した。

- **PILOT を始める。** CEO が友人・同僚に URL を配る（AI は連絡しない）。最初の1日組は **2026-11-01** 開始、30日目は 2026-11-30。合格・停止の基準は [validation-plan.md](../validation-plan.md) のまま変えない
- **#3 は案A。** 返信先は任意入力のまま（返信のためだけに使い、内容とともに180日で消す）。運営者表示は「30日だけ 運営事務局（個人運営）」のまま、氏名・住所は請求があれば回答する。D12 の暫定扱いは解除し、PRODUCT.md の Do Not Build の例外として確定する
- **招待を送るのは Gate 6 が終わってから。** 3（[#6](https://github.com/mizuki-majima/try_something_new/issues/6)）と4（[#8](https://github.com/mizuki-majima/try_something_new/issues/8)。実機は CEO が操作し、結果を AI QA が判定）を **2026-10-31 まで**に済ませ、AI QA が Gate 6 を判定する。それまで Phase は TEST のまま

選ばなかった案:

- 返信先の欄をなくす（#3 の案B）: 削除依頼などに返事ができなくなる
- 氏名・連絡先を公開する（#3 の運営者表示の案B）: 公開サイトに個人の氏名・住所を出すことになる。友人・同僚向けの PILOT では要らない
- 実機の確認や通知メールを後回しにして招待する: PILOT は1日組1回（1か月）なので、iPhone だけの不具合や気づかない費用の増加で台無しになると、やり直しに1か月かかる

## Consequences

- コードの変更はない（今の実装が案A）
- `ALERT_EMAIL` が付くまで、予算 `thirty-days-monthly` とアラーム5つは無い。その間の歯止めは、API のステージの上限（20 リクエスト/秒）と DynamoDB のスループットの上限（1時間あたりの速さ）だけ。アカウントにもともとある予算アラート（アカウント全体: 月 $2 と1日 $0.1、メール通知）は、共用アカウントの他の費用で 2026-10-07 時点ですでに超過・通知済みの状態なので、このサービスの費用の増加は見分けられない。最悪の場合、DynamoDB は上限の少し下で使われ続けると 約 $3.1/時（1日 約 $74）、それ以外は月 $170 前後になりうる（[docs/deploy.md](../deploy.md)「費用の目安」）。招待前は URL を参加者に配っていないので露出は小さいが、**#6 が済むまで招待しない**。それまでは AI PM がセッションのたびに Cost Explorer の `Project=thirty-days` と API のログを確認する（AI は呼ばれたときしか動かないので、毎日の保証はない）
- 費用配分タグ `Project` は 2026-10-07 に有効にした（予算は #6 のデプロイでできる）
- 追記（2026-10-07）: CEO が通知先に自分のメールアドレスを使うことを承認し、`ALERT_EMAIL` を付けて再デプロイした（予算とアラーム5つを作成）。メールは CEO が購読を承認してから届く
- **見直す条件**: 一般公開（Gate 7 の後）の前に、運営者表示（個人情報保護法 §32 の読み方）を専門家に確認する。PILOT の参加者以外の利用が目立ったら CEO に報告する（招待した人数と管理画面の開始数を比べる）
