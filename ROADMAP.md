# Roadmap — 30日だけ

最終更新: 2026-10-07 ／ 現在: **REVIEW**（次: [Gate 5: REVIEW → TEST](https://github.com/mizuki-majima/try_something_new/issues/2)）

直近の学習を最優先にする。細かい長期計画は書かない。Later は約束ではない。

## Done

- [x] BUILD: SPEC v1 の全機能（FR-1〜22）と CUF-1〜3 の E2E（Gate 4: #1）
- [x] AWS へのテスト用デプロイ（`https://d1zw3n37kpuo7t.cloudfront.net`）。**PILOT の参加者にはまだ配っていない**（本番公開は CEO 承認）。レビュー修正前のコードが載っているので、修正版をデプロイするまで URL を広めない

## Now

- [ ] REVIEW（Gate 5）: 独立レビューの指摘を直す（Critical: バックアップ読み込みに上限が無い、High: 公開カードを通報できない、を含む。AI PM 決定 D1〜D13 は SPEC に反映済み）→ 別エージェントで再レビューし、Critical / High 0件
- [ ] 修正版をテスト環境にデプロイ（先に `node scripts/setup-secrets.mjs`、`PUBLIC_ORIGIN` と `ALERT_EMAIL` を付ける。[docs/deploy.md](docs/deploy.md)）。費用配分タグ `Project` の有効化
- [ ] TEST（Gate 6）: 実環境の Live smoke（[docs/test-plan.md](docs/test-plan.md)）、重大バグ 0件

## Next

- PILOT（**CEO の承認後**。本番公開＝URL を人に配ること）: 友人・同僚 10人前後で「1日組」を1回（[docs/validation-plan.md](docs/validation-plan.md)）
- お問い合わせの返信先（任意入力・180日保存）を残すことの CEO 確認（個人情報。D12）
- CEO 本人の体験を公式レシピ・体験談として追加（現在の公式23本は一般的な例）

## Later

- 独自ドメイン
- LINE 公式アカウント（Messaging API）でのリマインド

写真のクラウド保存は PRODUCT.md の Do Not Build にあるので、ここには載せない（必要になったら `status:needs-ceo` の Issue で判断を仰ぐ）。
