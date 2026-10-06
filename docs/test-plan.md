# Test Plan — 30日だけ

> **Gate 3（SPEC → BUILD）通過後に書く。** 最初に書くテストは CUF-1 の E2E。

Owner: AI QA ／ 対象: SPEC v1

方針: MVP では Critical User Flow を最優先。網羅より「CUF が壊れたら必ず CI が赤になる」こと。

## テストレベル

| レベル | 対象 | ツール | 場所 | 実行 |
|---|---|---|---|---|
| Unit | ロジック | | `tests/unit/` | CI |
| Integration | API / DB / 外部サービス（モック） | | `tests/integration/` | CI |
| E2E | Critical User Flow | | `tests/e2e/` | CI |
| Live smoke | 実 API・実データでの CUF | 手動 | 本書 | リリース前・モデル変更時 |

課金される外部 API は CI で呼ばない。

## CUF のトレーサビリティ

| CUF ステップ | Unit | Integration | E2E |
|---|---|---|---|
| | | | |

## Edge cases

## Live smoke（手動）と品質ルーブリック

## Regression

- すべての PR と main への push で CI
- CUF の E2E が赤のときはマージ・リリース禁止
- 不具合を直すときは、再現する自動テストを先に追加する

## 既知のリスク

## Not tested（意図的）
