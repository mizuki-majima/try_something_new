/** このサービスについて (SPEC FR-22): what it is, how it works, credit to the talk, FAQ. */
import { Link } from "react-router";
import { EARLY_REFLECT_FROM_DAY, TRANSFER_CODE_TTL_MINUTES } from "@thirty/shared";
import { Seal } from "../components/Seal";
import { usePageTitle } from "../lib/hooks";
import "./InfoPages.css";

export const TED_TALK_URL = "https://www.ted.com/talks/matt_cutts_try_something_new_for_30_days";

const STEPS = [
  { seal: "決", title: "やることを決める", text: "レシピやガチャから、30日だけやることを選びます。自分で考えてもかまいません。" },
  { seal: "印", title: "毎日1タップ", text: "やった日は、30マスのカードに印を押します。ひとことメモも残せます。" },
  { seal: "選", title: "30日目に決める", text: "続ける・やめる・形を変えるを選んで、振り返りカードを作ります。" },
] as const;

const FAQ = [
  {
    q: "データはどこに保存されますか？",
    a: (
      <>
        チャレンジ・印・ひとことメモは、この端末とサーバー（AWS の東京リージョン）に保存します。写真はこの端末の中だけです。詳しくは
        <Link to="/privacy">プライバシーポリシー</Link>をご覧ください。
      </>
    ),
  },
  {
    q: "機種変更したら、記録はどうなりますか？",
    a: (
      <>
        前の端末の<Link to="/settings#transfer">設定 →「引き継ぎ」</Link>
        でコードを発行し、新しい端末で入力すると、同じ記録を使えます（コードは{TRANSFER_CODE_TTL_MINUTES}
        分間・1回だけ有効）。念のため、バックアップの書き出しもできます。写真は引き継がれません。
      </>
    ),
  },
  {
    q: "通知が来ません。",
    a: (
      <>
        <Link to="/settings#reminder">設定 →「リマインド」</Link>
        で、通知の許可と時刻を確かめてください。その時刻までに印を押した日は通知しません。iPhone は、Safari の共有ボタンから「ホーム画面に追加」して、ホーム画面から開いたときだけ通知を受け取れます。通知が使えないときは、各チャレンジの画面からカレンダーに毎日の予定を入れられます。
      </>
    ),
  },
  {
    q: "写真はどうなりますか？",
    a: "写真はこの端末の中だけに保存し、サーバーには送りません。公開もされません。保存する前に小さくして、位置情報などは取り除きます。ブラウザのデータを消したり端末を変えたりすると、写真は消えます。",
  },
  {
    q: "途中でやめたら、失敗ですか？",
    a: `いいえ。${EARLY_REFLECT_FROM_DAY}日目からは「ここで区切る」で振り返れます。合わなかったとわかったのも、試したからこその収穫です。`,
  },
  {
    q: "費用はかかりますか？",
    a: "無料です。広告や課金もありません。",
  },
];

export default function AboutPage() {
  usePageTitle("このサービスについて");
  return (
    <article className="info-page about">
      <header className="info-head about-hero">
        <Seal char="卅" size="xl" className="about-seal" />
        <h1 className="info-title">「30日だけ」について</h1>
        <div className="info-lead">
          <p>
            新しいことを、30日だけ試してみるためのサービスです。30日たったら、<b>続ける・やめる・形を変える</b>を自分で決めます。
          </p>
          <p>やめても失敗ではありません。試してみたこと自体が、ちゃんと収穫です。</p>
        </div>
      </header>

      <section className="info-sec" aria-labelledby="how-h">
        <h2 id="how-h" className="info-h">
          使い方
        </h2>
        <ol className="about-steps">
          {STEPS.map((s, i) => (
            <li key={s.seal} className="about-step">
              <span className="about-step-n" aria-hidden="true">
                {i + 1}
              </span>
              <Seal char={s.seal} size="md" />
              <b>{s.title}</b>
              <p>{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="info-sec" aria-labelledby="cohort-h">
        <h2 id="cohort-h" className="info-h">
          1日組
        </h2>
        <div className="info-body">
          <p>
            毎月1日に始めると「1日組」になります。同じ月に始めた人の進み具合が「みんな」に並び、応援を送れます。応援は数だけで、メッセージは送れません。
          </p>
          <p>
            進捗の表示は、<Link to="/settings#profile">設定</Link>でいつでもオフにできます。ひとことメモは、本人が「みんなに見せる」を選んだものだけ表示されます。写真は表示されません。
          </p>
        </div>
      </section>

      <section className="info-sec" aria-labelledby="idea-h">
        <h2 id="idea-h" className="info-h">
          ひらめき提案（AI は使っていません）
        </h2>
        <div className="info-body">
          <p>
            ガチャの画面の「ひらめき提案（お試し）」は、AI を使っていません。あらかじめ用意した案の中から、時間・ジャンル・場所の条件と、入力したひとことに含まれる言葉をもとに選んでいます。入力したひとことは保存しません。
          </p>
        </div>
      </section>

      <section className="info-sec" aria-labelledby="privacy-h">
        <h2 id="privacy-h" className="info-h">
          プライバシー
        </h2>
        <div className="info-body">
          <p>
            アカウントは匿名で、メールアドレスも電話番号もいりません。写真はこの端末の中だけに保存し、サーバーには送りません。アクセス解析や広告も使っていません。詳しくは
            <Link to="/privacy">プライバシーポリシー</Link>をご覧ください。
          </p>
        </div>
      </section>

      <section className="info-sec" aria-labelledby="credit-h">
        <h2 id="credit-h" className="info-h">
          着想
        </h2>
        <div className="info-body about-credit">
          <p>
            着想：
            <a href={TED_TALK_URL} target="_blank" rel="noopener noreferrer">
              Matt Cutts “Try something new for 30 days”（TED2011）
              <span className="sr-only">（外部サイトが新しいタブで開きます）</span>
            </a>
          </p>
          <p>このサイトは TED とは関係のない非公式の個人サービスです。</p>
        </div>
      </section>

      <section className="info-sec" aria-labelledby="faq-h">
        <h2 id="faq-h" className="info-h">
          よくある質問
        </h2>
        <div className="about-faq">
          {FAQ.map((f) => (
            <details key={f.q} className="about-qa">
              <summary>{f.q}</summary>
              <div className="about-a">
                <p>{f.a}</p>
              </div>
            </details>
          ))}
        </div>
      </section>

      <nav className="info-more" aria-label="関連ページ">
        <Link to="/terms">利用規約</Link>
        <Link to="/privacy">プライバシーポリシー</Link>
        <Link to="/contact">お問い合わせ</Link>
        <Link to="/settings">設定</Link>
      </nav>

      <p className="about-cta">
        <Link to="/recipes" className="btn primary lg">
          レシピから選んで始める
        </Link>
      </p>
    </article>
  );
}
