# Roadmap — 30日だけ

最終更新: 2026-10-07 ／ 現在: **PILOT**（次: [Gate 7: PILOT → LIVE](https://github.com/mizuki-majima/try_something_new/issues/5)）

直近の学習を最優先にする。細かい長期計画は書かない。Later は約束ではない。

## Done

- [x] BUILD: SPEC v1 の全機能（FR-1〜22）と CUF-1〜3 の E2E（Gate 4: #1）
- [x] REVIEW: 独立レビュー3回。1・2回目の Critical / High は D1〜D13・R1〜R10 で直し、3回目で Critical / High 0件（Gate 5: #2、[ADR 0004](docs/decisions/0004-gate5-review-fixes.md)。D1〜D13・R1〜R16 は SPEC v1.3）
- [x] 修正版を AWS にデプロイ（`https://d1zw3n37kpuo7t.cloudfront.net`）し、本番環境で Chromium の自動スモークを通過
- [x] CEO が PILOT 開始と #3（返信先・運営者表示）の案A を承認（[ADR 0005](docs/decisions/0005-pilot-approval.md)）
- [x] 費用配分タグ `Project` の有効化（2026-10-07）
- [x] 障害・費用の通知メール（予算とアラーム5つ。アラームが SNS に送れない不具合を直し、テストのメールの到着を確認。[#6](https://github.com/mizuki-majima/try_something_new/issues/6)）
- [x] TEST（Gate 6: [#4](https://github.com/mizuki-majima/try_something_new/issues/4)）: 実機の Live smoke は本番のログで裏付けが取れず、AI QA の判定は「未達」。CEO がリスクを受け入れて通過（[ADR 0006](docs/decisions/0006-gate6-ceo-risk-acceptance.md)）

## Now

PILOT:

- [ ] CEO が友人・同僚 10人前後に URL を配り（10月末まで）、**2026-11-01 開始の1日組**に誘う（AI は連絡しない）
- [ ] 招待の日と 2026-11-01: AI PM が本番のログで参加者の操作（アカウント作成・チャレンジ作成・印・通知の購読）と 4xx / 5xx を確かめる。最初の1週間はリマインドの送信数も（[#8](https://github.com/mizuki-majima/try_something_new/issues/8)）
- [ ] PILOT 中: 機能は足さない。バグと運用だけ直す。週次レビューで管理画面の指標・AWS の請求・ログを見る

## Next

- Gate 7（2026-11-30 の後）: 管理画面の PILOT の指標と参加者の感想で判定（[docs/validation-plan.md](docs/validation-plan.md)）。CONTINUE なら一般公開（**CEO の承認**）、そうでなければ PAUSE / PIVOT を提案
- 一般公開の前に、運営者表示（個人情報保護法 §32 の読み方）を専門家に確認
- CEO 本人の体験を公式レシピ・体験談として追加（現在の公式23本は一般的な例）

## Later

- 独自ドメイン
- LINE 公式アカウント（Messaging API）でのリマインド

写真のクラウド保存は PRODUCT.md の Do Not Build にあるので、ここには載せない（必要になったら `status:needs-ceo` の Issue で判断を仰ぐ）。
