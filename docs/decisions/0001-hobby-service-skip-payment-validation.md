# 0001. 趣味のサービスとして作り、支払意思の検証（Gate 2）を省く

- Status: Accepted
- Date: 2026-10-06
- Decider: CEO（Mizuki）

## Context

PROCESS.md の標準では、VALIDATE で「支払意思」を確かめてから SPEC・BUILD に進む。
「30日だけ」は、CEO が TED「Try something new for 30 days」に触発されて続けてきた体験を、ほかの人にも伝えて試してもらうためのサービスで、CEO 自身が「収益は難しいと思うけど、これは趣味で」「MVP じゃなくてフルサービスを作れないか」と判断した（2026-10-06 の会話）。

## Decision

- 収益化を目的にしない。料金・広告・決済は作らない（PRODUCT.md の Do Not Build）
- Gate 2（支払意思）は **CEO 判断で免除** し、Gate 1 → SPEC → BUILD に進む
- 代わりに「使われるか」を PILOT（友人・同僚 10人前後で1か月）で測る。基準は docs/validation-plan.md に事前に書く
- AWS 費用は月 $5 程度を目標に、安い構成にする（CEO 指示「安くね」）

## Consequences

- 需要の証拠なしに作るので、PILOT で使われなければ機能を足すのではなく PAUSE / KILL を検討する（Kill Criteria）
- 趣味でも外部の人が使う以上、PROCESS.md §6 の PILOT 列の品質（セキュリティ、規約・プライバシーポリシー、バックアップ）は守る
- 費用が月 $10 を超えそうなときは CEO に報告する
