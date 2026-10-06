# 30日だけ — AI エージェント向けルール

このリポジトリは「AI Product Organization」の開発管理プロセス（IDEA → VALIDATE → SPEC → BUILD → REVIEW → TEST → PILOT → LIVE と Gate 制）で運用している。プロセス全体は ai-product-org の PROCESS.md。作業前に必ず次を確認すること。

| 知りたいこと | 正とする場所 |
|---|---|
| 今どの Phase か、何を目指しているか、作ってはいけないもの | [PRODUCT.md](PRODUCT.md)（Current Phase / Current Goal / Do Not Build） |
| コードが満たすべき仕様、Critical User Flow、Definition of Done | [SPEC.md](SPEC.md)（Gate 2 以降） |
| 作業単位 | GitHub Issues（`phase:*` `priority:*` `type:*` `status:*` ラベル） |

## 作業ルール

1. **Phase を守る。** IDEA / VALIDATE ではコードを書かない（検証に必要な LP・手作業・最小限の道具を除く）。Gate を満たすまで次の Phase に進まない。
2. **Do Not Build に当たる作業は実装しない。** 必要だと思ったら `status:needs-ceo` の Issue を作って止まる。
3. **Issue 単位で作業する。** Issue には Purpose / Acceptance Criteria / Priority / Phase / Dependencies。ブランチ → PR（`Closes #番号`）。main へ直接 push しない。
4. **Developer と Reviewer は別のエージェント。** 実装したエージェントが自分のレビューを完了扱いにしてはいけない。`.claude/agents/reviewer.md` などで別エージェントがレビューし、Critical / High が残っていたら次へ進まない。
5. **完了の定義は SPEC.md の Definition of Done。** CI が緑で、Critical User Flow の E2E が通ること。
6. **AI 出力を信用しない。** モデル出力は実行時に検証してから使う。
7. **コストを意識する。** 課金 API をテストや CI で呼ばない。
8. **ユーザーデータを不必要に保存しない。** 見込み顧客や問い合わせ相手の情報はサービスリポジトリに置かない（ai-product-org/services/try-something-new/ で非公開管理）。

## CEO へのエスカレーション

次の場合だけ CEO に判断を求める（Issue に `status:needs-ceo`）: 本番公開、料金、大きな API コスト、新しい有料契約、法的リスク、個人情報、決済、顧客への重要な連絡、重大なセキュリティ問題、Pivot、停止、大幅な仕様変更。それ以外は AI が判断して進める。

## コマンド

<!-- BUILD から記入（check / test:e2e / dev） -->
