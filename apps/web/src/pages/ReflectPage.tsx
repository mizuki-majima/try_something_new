/**
 * 振り返り "/c/:id/reflect" (FR-6/FR-7, CUF-2): choose 続ける / やめる / 形を変える and a ひとこと, then
 * the share step (card preview, save / share / public link). A challenge that is already done opens
 * on the share step and can change its verdict and ひとこと (the stamps stay fixed).
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { EARLY_REFLECT_FROM_DAY, LIMITS, VERDICTS, VERDICT_KEYS, jpPeriod, type Challenge, type Verdict } from "@thirty/shared";
import { TextAreaField } from "../components/Field";
import { ChevronLeftIcon } from "../components/Icons";
import { Seal } from "../components/Seal";
import { EmptyState, Loading } from "../components/States";
import { useToast } from "../components/Toast";
import { SharePanel } from "../features/share/SharePanel";
import { VerdictBadge } from "../features/share/VerdictBadge";
import { StartChallengeSheet } from "../features/start/StartChallengeSheet";
import { stampedDays, viewChallenge } from "../lib/challenge";
import { usePageTitle } from "../lib/hooks";
import { useApp, useAppActions } from "../lib/store";
import "./reflect.css";

export default function ReflectPage() {
  const { id } = useParams();
  const { challenges, today, ready } = useApp();
  const c = useMemo(() => challenges.find((x) => x.id === id), [challenges, id]);
  usePageTitle("振り返り");

  if (!c) {
    if (!ready) return <Loading label="読み込んでいます…" />;
    return (
      <section className="rf">
        <h1 className="rf-h1">振り返り</h1>
        <EmptyState
          seal="無"
          title="このチャレンジはありません"
          action={
            <Link to="/" className="btn primary">
              きょうに戻る
            </Link>
          }
        >
          削除したか、別の端末のアカウントのものかもしれません。
        </EmptyState>
      </section>
    );
  }
  return <Reflect key={c.id} c={c} today={today} />;
}

type Step = "decide" | "share";

function Reflect({ c, today }: { c: Challenge; today: string }) {
  const { reflect } = useAppActions();
  const toast = useToast();
  const v = viewChallenge(c, today);
  const done = c.status === "done";
  const [step, setStep] = useState<Step>(done ? "share" : "decide");
  const [verdict, setVerdict] = useState<Verdict | null>(c.verdict);
  const [text, setText] = useState(c.reflection ?? "");
  const [verdictError, setVerdictError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [linkOutdated, setLinkOutdated] = useState(false);
  const [again, setAgain] = useState(false);
  const headRef = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // After switching steps, move focus to the new step's heading (not on first load).
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    headRef.current?.focus();
    headRef.current?.scrollIntoView?.({ block: "start" });
  }, [step]);

  function go(next: Step) {
    moved.current = true;
    setStep(next);
  }

  if (!done && !v.canReflect) {
    return (
      <section className="rf">
        <Header c={c} />
        <div className="rf-wait">
          <p className="rf-wait-h">{v.phase === "waiting" ? "まだ始まっていません" : `振り返りは${EARLY_REFLECT_FROM_DAY}日目からできます`}</p>
          <p>
            {v.phase === "waiting"
              ? "始まってから7日たつと「ここで区切る」で振り返れます。30日目が終わったら、ここで続けるかどうかを決めます。"
              : `いま${v.day}日目です。あと${EARLY_REFLECT_FROM_DAY - v.day}日続けると、ここで区切って振り返れます。`}
          </p>
          <Link to={`/c/${c.id}`} className="btn">
            チャレンジに戻る
          </Link>
        </div>
      </section>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!verdict) {
      setVerdictError("続ける・やめる・形を変える から1つ選んでください");
      document.getElementById("rf-verdict-continue")?.focus();
      return;
    }
    const unchanged = done && verdict === c.verdict && text.trim() === (c.reflection ?? "");
    if (!unchanged) {
      const r = reflect(c.id, verdict, text);
      if (!r.ok) {
        if (r.fields.reflection) setTextError(r.fields.reflection);
        else setFormError(r.message);
        return;
      }
      if (done && c.shareId) setLinkOutdated(true);
      toast(done ? "振り返りを更新しました" : "記録しました。カードを作ります");
    }
    go("share");
  }

  const early = !done && v.phase === "active";
  const next = c.verdict === "continue" ? "同じ内容で、もう30日" : c.verdict === "modify" ? "形を変えて、もう30日" : null;

  return (
    <section className="rf">
      <Link to={`/c/${c.id}`} className="backlink rf-back">
        <ChevronLeftIcon />
        チャレンジ
      </Link>
      <Header c={c} />

      <ol className="rf-steps" aria-label="手順">
        <li aria-current={step === "decide" ? "step" : undefined}>
          <span aria-hidden="true">1</span>決める
        </li>
        <li aria-current={step === "share" ? "step" : undefined}>
          <span aria-hidden="true">2</span>シェアする
        </li>
      </ol>

      {step === "decide" ? (
        <form className="rf-form" onSubmit={submit} noValidate>
          <h2 className="rf-h2" ref={headRef} tabIndex={-1}>
            この30日、どうする？
          </h2>
          {early && (
            <p className="rf-early">
              まだ{v.day}日目ですが、ここで区切ります。途中でやめるのも立派な結果です。区切ったあとは、印は変えられません。
            </p>
          )}
          <fieldset className="rf-verdicts" aria-describedby={verdictError ? "rf-verdict-err" : undefined}>
            <legend className="sr-only">判定</legend>
            {VERDICT_KEYS.map((k) => (
              <label key={k} className={`rf-verdict rf-${k}`}>
                <input
                  id={`rf-verdict-${k}`}
                  type="radio"
                  name="verdict"
                  value={k}
                  checked={verdict === k}
                  onChange={() => {
                    setVerdict(k);
                    setVerdictError(null);
                  }}
                />
                <b>{VERDICTS[k].label}</b>
                <small>{VERDICTS[k].desc}</small>
              </label>
            ))}
            {verdictError && (
              <p className="field-err" id="rf-verdict-err" role="alert">
                {verdictError}
              </p>
            )}
          </fieldset>
          <TextAreaField
            label="ひとこと（任意・シェア用カードに載ります）"
            value={text}
            onChange={(value) => {
              setText(value);
              setTextError(undefined);
            }}
            max={LIMITS.reflection}
            rows={4}
            error={textError}
            placeholder="30日やってみて、どうだった？"
            hint="公開リンクを作ると、リンクを知っている人に見えます。URLは入れられません。"
          />
          {formError && (
            <p className="st-error rf-err" role="alert">
              {formError}
            </p>
          )}
          <div className="rf-submit">
            <button type="submit" className="btn primary lg rf-decide">
              {done ? "この内容で更新する" : "決める"}
            </button>
            {done && (
              <button type="button" className="btn ghost" onClick={() => go("share")}>
                変えずに戻る
              </button>
            )}
          </div>
        </form>
      ) : (
        <div className="rf-share">
          <div className="rf-share-head">
            <h2 className="rf-h2" ref={headRef} tabIndex={-1}>
              シェア用カード
            </h2>
            {c.verdict && <VerdictBadge verdict={c.verdict} size="lg" />}
          </div>
          <SharePanel challenge={c} linkOutdated={linkOutdated} onLinkCreated={() => setLinkOutdated(false)} />
          <div className="rf-next">
            <button type="button" className="btn" onClick={() => go("decide")}>
              判定・ひとことを変える
            </button>
            {next && (
              <button type="button" className="btn" onClick={() => setAgain(true)}>
                {next}
              </button>
            )}
            <Link to="/gacha" className="btn primary lg rf-gacha">
              次の30日を選ぶ
            </Link>
          </div>
          <StartChallengeSheet
            open={again}
            onClose={() => setAgain(false)}
            preset={{ title: c.title, seal: c.seal, recipeId: c.recipeId }}
          />
        </div>
      )}
    </section>
  );
}

function Header({ c }: { c: Challenge }) {
  const days = stampedDays(c).length;
  return (
    <header className="rf-head">
      <Seal char={c.seal} size="xl" label={`印「${c.seal}」`} />
      <div className="rf-headtext">
        <p className="rf-kicker">30日の振り返り</p>
        <h1 className="rf-h1">{c.title}</h1>
        <p className="rf-meta">
          <span>{jpPeriod(c.startDate)}</span>
          <span>
            <b>{days}</b>/30日 押した
          </span>
        </p>
      </div>
    </header>
  );
}
