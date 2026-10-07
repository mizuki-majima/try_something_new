# Roadmap — 30日だけ

最終更新: 2026-10-07 ／ 現在: **PILOT**（次: [Gate 7: PILOT → LIVE](https://github.com/mizuki-majima/try_something_new/issues/5)）

直近の学習を最優先にする。細かい長期計画は書かない。Later は約束ではない。

## Done

- [x] BUILD: SPEC v1 の全機能（FR-1〜22）と CUF-1〜3 の E2E（Gate 4: #1）
- [x] REVIEW: 独立レビュー3回、Critical / High 0件（Gate 5: #2、[ADR 0004](docs/decisions/0004-gate5-review-fixes.md)。D1〜D13・R1〜R16 は SPEC v1.3）
- [x] TEST: 修正版を AWS にデプロイ（`https://d1zw3n37kpuo7t.cloudfront.net`）し Live smoke を通過。CEO が PILOT 開始と #3（返信先・運営者表示）の案A を承認（Gate 6: #4、[ADR 0005](docs/decisions/0005-pilot-approval.md)）
- [x] 費用配分タグ `Project` の有効化（2026-10-07）

## Now

- [ ] 障害・費用の通知メール（`ALERT_EMAIL`）を付けて再デプロイ（[#6](https://github.com/mizuki-majima/try_something_new/issues/6)。通知先のメールアドレス待ち）
- [ ] CEO が友人・同僚 10人前後に URL を配り、**2026-11-01 開始の1日組**に誘う（AI は連絡しない）
- [ ] PILOT 中: 機能は足さない。バグと運用だけ直す。週次レビューで管理画面の指標・AWS の請求・ログを見る

## Next

- Gate 7（2026-11-30 の後）: 管理画面の PILOT の指標と参加者の感想で判定（[docs/validation-plan.md](docs/validation-plan.md)）。CONTINUE なら一般公開（**CEO の承認**）、そうでなければ PAUSE / PIVOT を提案
- 一般公開の前に、運営者表示（個人情報保護法 §32 の読み方）を専門家に確認
- CEO 本人の体験を公式レシピ・体験談として追加（現在の公式23本は一般的な例）

## Later

- 独自ドメイン
- LINE 公式アカウント（Messaging API）でのリマインド

写真のクラウド保存は PRODUCT.md の Do Not Build にあるので、ここには載せない（必要になったら `status:needs-ceo` の Issue で判断を仰ぐ）。
