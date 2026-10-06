# 0002. フルサービスを AWS サーバーレスで作る（Gate 3: SPEC → BUILD）

- Status: Accepted
- Date: 2026-10-06
- Decider: AI PM（CEO 指示「AWS に環境を作ってよい、安く」に基づく）

## Context

前回の会話で作った単一 HTML のアーティファクトは、みんなの一覧（1日組）に載れるのが招待した編集者だけで、広く公開できない。CEO は「フルサービス」を求めている。費用は安く抑えたい。

## Decision

| 論点 | 決定 | 選ばなかった案と理由 |
|---|---|---|
| ホスティング | S3 + CloudFront（静的 PWA）、API Gateway HTTP API + Lambda（Node 22 / arm64）、DynamoDB on-demand | 常時起動のサーバ（EC2・App Runner）は最低でも月数ドル〜 |
| アカウント | メール不要の匿名アカウント＋引き継ぎコード | Cognito＋メールは SES の本番申請が要り、個人情報（メール）を持つことになる |
| 通知 | Web Push（VAPID）＋カレンダー連携 | LINE Notify は終了。メールは SES の本番申請が必要 |
| AI | Claude in Amazon Bedrock（IAM で呼ぶ。API キーを持たない）。既定は Claude Opus 5.5、`-c aiModel` で Haiku 4.5 に切替可。1人1日3回・全体1日50回 | Anthropic API 直は API キーの管理が増える |
| 写真 | 端末内（IndexedDB）だけ | サーバ保存は容量・モデレーション・位置情報の扱いが重い |
| IaC | AWS CDK（TypeScript） | — |
| ローカル・CI | dynalite（純 JS の DynamoDB 互換）で Java / Docker 不要 | DynamoDB Local は Java が必要 |

Gate 3 のチェック: SPEC.md の全節（Goal〜Definition of Done）、Critical User Flow 3本、Do Not Build 更新、WIP（BUILD 0/3）を確認した。

## Consequences

- 公開 URL は `*.cloudfront.net`。独自ドメインは後から追加できる
- 匿名アカウントなので、端末を失くして引き継ぎコードも無いとデータは戻らない（バックアップ書き出しで補う）
- Web Push は iOS ではホーム画面に追加した場合のみ。案内文で補う
- AI は IAM 権限と Bedrock のモデルアクセスが前提。使えないときは AI ボタンだけ無効になり、ほかは動く
