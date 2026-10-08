/**
 * プライバシーポリシー (SPEC FR-22, "Data Model"). Lists exactly what the API stores and for how
 * long; keep it in sync with SPEC.md when the data model changes.
 *
 * Revised for #17 (ADR 0007): from EFFECTIVE, a day note its owner chose to show in 「みんな」 is
 * public, and the choice is stored as a copy of the chosen text. Every changed sentence says from
 * when, so the page is true before that day too (the notes are not public yet) and after it.
 * The 改定のお知らせ at the top goes away with the notice band (noticeShowsOn); the dates stay.
 */
import { Link } from "react-router";
import { TRANSFER_CODE_TTL_MINUTES } from "@thirty/shared";
import { usePageTitle } from "../lib/hooks";
import { noticeShowsOn } from "../lib/legal";
import { useToday } from "../lib/store";
import { EFFECTIVE, ENACTED, InfoDoc, OPERATOR, REVISED, type DocSection } from "./InfoDoc";

const SECTIONS: readonly DocSection[] = [
  {
    id: "operator",
    title: "運営者",
    body: (
      <>
        <p>
          「30日だけ」（以下「本サービス」）は、{OPERATOR}（以下「運営者」）が運営しています。ご連絡は
          <Link to="/contact">お問い合わせフォーム</Link>からお願いします。
        </p>
        <p>運営者の氏名・住所など、法令でお知らせすることになっている事項は、お問い合わせいただければ遅滞なくお答えします。</p>
      </>
    ),
  },
  {
    id: "collect",
    title: "保存する情報",
    body: (
      <>
        <p>本サービスは匿名で使えます。サーバーには、次の情報を保存します。</p>
        <div className="info-table-wrap">
          <table className="info-table">
            <caption className="sr-only">サーバーに保存する情報</caption>
            <thead>
              <tr>
                <th scope="col">情報</th>
                <th scope="col">内容</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">アカウント</th>
                <td>ランダムに作る ID、ログイン用の合言葉（トークン。サーバーには元に戻せない形に変換した値だけを保存）、タイムゾーン</td>
              </tr>
              <tr>
                <th scope="row">ニックネーム</th>
                <td>入力した場合。「みんな」や投稿に表示されます</td>
              </tr>
              <tr>
                <th scope="row">設定</th>
                <td>進捗を表示するかどうか、リマインドのオン・オフと時刻</td>
              </tr>
              <tr>
                <th scope="row">チャレンジ</th>
                <td>タイトル、印、開始日、印を押した日と時刻、振り返りの判定とひとこと</td>
              </tr>
              <tr>
                <th scope="row">ひとことメモ</th>
                <td>
                  毎日の印に添えたメモ。ふだんは本人だけが見られます。{EFFECTIVE}からは、本人が「みんなに見せる」を選んだメモは、進捗の表示がオンで1日組に表示されているあいだ、誰でも見られます（選んだことの記録として、選んだときのメモの写しも保存します）
                </td>
              </tr>
              <tr>
                <th scope="row">投稿</th>
                <td>レシピ、体験談</td>
              </tr>
              <tr>
                <th scope="row">振り返りカード</th>
                <td>公開リンクを作った場合の、カードの画像と内容</td>
              </tr>
              <tr>
                <th scope="row">応援・通報</th>
                <td>
                  応援した記録（1日1回の判定用。2日で消えます）、通報した記録と理由。自動で非表示にするかの判定のため、通報したネットワークを見分ける値（IP
                  アドレスから作った秘密鍵つきのハッシュ値）も、通報の記録と一緒に保存します
                </td>
              </tr>
              <tr>
                <th scope="row">通知の登録</th>
                <td>リマインド通知をオンにした端末の、ブラウザが発行する通知の宛先と暗号鍵</td>
              </tr>
              <tr>
                <th scope="row">お問い合わせ</th>
                <td>送られた内容と、任意で入力された返信先（メールアドレスなど）。返信先は返信のためだけに使い、内容とともに180日で削除します。アカウントとは結びつけません</td>
              </tr>
              <tr>
                <th scope="row">荒らし対策の記録</th>
                <td>
                  回数制限のため、IP アドレスから作った値（秘密鍵つきのハッシュ（HMAC）。IPv6 は上位56ビット）と回数。アカウントの作成は、ネットワーク（IPv4 は上位16ビット、IPv6 は上位48ビット）ごとにも数えます（同じ種類のハッシュ値）。IP アドレスそのものは保存しません。2日で消えます
                </td>
              </tr>
              <tr>
                <th scope="row">引き継ぎコード</th>
                <td>発行したコード。{TRANSFER_CODE_TTL_MINUTES}分で消えます</td>
              </tr>
              <tr>
                <th scope="row">全体の集計</th>
                <td>利用者数、チャレンジ数、共有ボタンが使われた回数など。個人とは結びつかない数だけです</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          <b>この端末の中だけに保存するもの：</b>写真、ログイン用のトークン、表示の設定（テーマ）、送信待ちの記録。これらはお使いのブラウザに保存され、写真はサーバーに送りません。
        </p>
        <p>
          <b>保存しないもの：</b>アカウントのためのメールアドレスや電話番号、本名、住所、位置情報、写真、IP アドレスそのもの（お問い合わせに任意で書かれた返信先だけは、上のとおり180日保存します）。ひらめき提案に入力したひとことは、案を選ぶためだけに使い、保存しません。Cookie は使っていません。
        </p>
        <p>ひとことメモや投稿に、病歴など特に慎重な扱いが必要な情報や、他の人の個人情報を書き込まないでください。</p>
      </>
    ),
  },
  {
    id: "purpose",
    title: "使う目的",
    body: (
      <ul>
        <li>記録の保存と表示、別の端末への引き継ぎなど、本サービスを提供するため</li>
        <li>1日組・レシピ・体験談・振り返りカードを表示するため</li>
        <li>リマインド通知を送るため</li>
        <li>回数制限や通報への対応など、荒らしや不正な利用を防ぐため</li>
        <li>お問い合わせに答えるため（返信先は返信のためだけに使い、180日で削除します）</li>
        <li>個人と結びつかない集計で、使われ方を知り、本サービスを良くするため</li>
      </ul>
    ),
  },
  {
    id: "public",
    title: "公開される情報",
    body: (
      <>
        <p>次の情報は、誰でも見られる状態で表示されます。</p>
        <ul>
          <li>投稿したレシピと体験談（ニックネームつき）</li>
          <li>公開リンクを作った振り返りカード：ニックネーム、カードの画像、タイトル、印、判定、ひとこと（リンクを知っている人が見られます）</li>
          <li>
            「みんなに進捗を表示する」がオンのときの1日組の表示：ニックネーム、チャレンジのタイトルと印、印を押した日、振り返りの判定、応援の数。{EFFECTIVE}からは、本人が「みんなに見せる」を選んだひとことメモ（何日目のメモか、見せている数）も
          </li>
        </ul>
        <p>
          「みんなに見せる」を選んでいないひとことメモ、写真、設定、通知の登録は公開しません（{EFFECTIVE}より前は、ひとことメモはすべて公開しません）。
        </p>
        <ul>
          <li>
            見せたひとことメモは、書き換えると非公開に戻ります。進捗の表示をオフにすると、見せたひとことメモも表示されなくなり、オンに戻すとまた表示されます。書き換え・オフ・オンは、変更がサーバーに届いた時点で反映されます（通信できないあいだは、前の状態のままです）。
          </li>
          <li>バックアップから読み込んだひとことメモは、すべて非公開になります。</li>
          <li>進捗の表示は設定で、見せたひとことメモはその日のひとことの欄で、いつでも非公開に戻せます（振り返りのあとも。通信できるときに行えます）。</li>
        </ul>
      </>
    ),
  },
  {
    id: "third",
    title: "第三者への提供と外部のサービス",
    body: (
      <>
        <p>法令に基づく場合を除き、保存した情報を第三者に提供しません。本サービスを動かすために、次の外部のサービスを使っています。</p>
        <ul>
          <li>
            <b>Amazon Web Services（AWS）</b>：データの保管と処理の基盤として、AWS の東京リージョンを使っています（クラウドサービスの利用として、保管と処理を委託しています）。
          </li>
          <li>
            <b>ブラウザのプッシュ通知サービス</b>：リマインド通知をオンにした場合、通知の文面は、お使いのブラウザの通知サービス（Google、Apple、Mozilla、Microsoft のいずれか）を通って端末に届きます。文面は暗号化して送ります。
          </li>
        </ul>
        <p>
          アクセス解析、広告、外部のフォント、SNS の埋め込みなど、第三者に情報を送る仕組みは使っていません。文字のフォントも本サービスから配信しています。X や LINE で共有するボタン、「Google カレンダーに追加」のリンク、TED へのリンクを押したときは、それぞれのサービスの画面が開き、そのサービスのプライバシーポリシーが適用されます。X・LINE には共有する文面とリンクが、Google カレンダーにはチャレンジのタイトル・日時・本サービスへのリンクが、そのリンクを通して送られます。
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "保存する期間",
    body: (
      <ul>
        <li>引き継ぎコード：{TRANSFER_CODE_TTL_MINUTES}分</li>
        <li>荒らし対策の記録（IP アドレスから作った秘密鍵つきのハッシュ値など）、応援した記録：2日</li>
        <li>お問い合わせ（内容と返信先）：180日</li>
        <li>通報した記録（通報したネットワークを見分ける値を含む）：アカウントを削除するまで</li>
        <li>サーバーの動作記録（ログ）：14日。ログには IP アドレス、トークン、メモや投稿の本文を記録しません</li>
        <li>通知の登録：通知をやめるか、ブラウザ側で宛先が無効になるまで</li>
        <li>アカウント、チャレンジ、ひとことメモ、投稿、振り返りカード：ご本人が削除するまで</li>
        <li>障害に備えたバックアップ：削除したデータも、最大35日間はバックアップに残り、その後に消えます</li>
      </ul>
    ),
  },
  {
    id: "delete",
    title: "削除と、開示などのご請求",
    body: (
      <>
        <ul>
          <li>
            <Link to="/settings#danger">設定 →「すべてのデータを削除」</Link>
            で、アカウント、チャレンジ、ひとことメモ、投稿、振り返りカード、通知の登録をすぐに削除できます。この端末の写真も消します。
          </li>
          <li>投稿や公開リンクは、それぞれの画面からいつでも削除できます。</li>
          <li>
            進捗の表示とリマインドは、設定からいつでもオフにできます。「みんなに見せる」を選んだひとことメモは、その日のひとことの欄から、いつでも自分だけに戻せます（振り返りのあとも。通信できるときに行えます）。
          </li>
          <li>
            保存している情報の開示、訂正、利用の停止などのご請求は、<Link to="/contact">お問い合わせ</Link>
            からお送りください。匿名のサービスのため、ご本人の確認として、設定で発行する引き継ぎコードなどをお願いすることがあります。手数料はかかりません。
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "security",
    title: "安全のための取り組み",
    body: (
      <ul>
        <li>通信はすべて暗号化（HTTPS）しています。</li>
        <li>ログイン用のトークンは、サーバーでは元に戻せない形に変換した値だけを保存しています。</li>
        <li>管理用の鍵などの秘密の情報は暗号化して保管し、管理の画面は運営者だけが使えます。</li>
        <li>ログには、IP アドレス、トークン、メモや投稿の本文、通知の宛先を残しません。</li>
      </ul>
    ),
  },
  {
    id: "minors",
    title: "未成年の方へ",
    body: <p>未成年の方は、保護者の方の同意を得てから使ってください。</p>,
  },
  {
    id: "revise",
    title: "このポリシーの変更",
    body: <p>内容を変えるときは、このページでお知らせします。大事な変更のときは、本サービスの画面でもお知らせします。</p>,
  },
  {
    id: "contact",
    title: "お問い合わせ・苦情の窓口",
    body: (
      <p>
        個人情報の扱いについてのお問い合わせや苦情は、<Link to="/contact">お問い合わせフォーム</Link>
        からお送りください。返信が必要な場合は、返信先を書いてください。
      </p>
    ),
  },
];

export default function PrivacyPage() {
  usePageTitle("プライバシーポリシー");
  // Until the band goes away too (NoticeBanner); the dates above and below stay.
  const showNotice = noticeShowsOn(useToday());
  return (
    <InfoDoc
      title="プライバシーポリシー"
      meta={`制定日 ${ENACTED} ／ 改定日 ${REVISED}（${EFFECTIVE}から適用） ／ 運営者 ${OPERATOR}`}
      notice={
        showNotice && (
          <p>
            {EFFECTIVE}から、本人が「みんなに見せる」を選んだひとことメモを公開する内容に改めます（<a href="#collect">保存する情報</a>・<a href="#public">公開される情報</a>・<a href="#delete">削除と、開示などのご請求</a>）。選ばないひとことメモは、これまでどおり公開しません。それまでは、ひとことメモは公開されません。同じ日に<Link to="/terms">利用規約</Link>も改めます。
          </p>
        )
      }
      lead={
        <p>
          「30日だけ」は匿名で使えます。アカウントにメールアドレスは使わず、写真はお使いの端末の中だけに保存します。何を保存し、何に使い、どう消せるのかをまとめました。
        </p>
      }
      sections={SECTIONS}
      footer={
        <p>
          {ENACTED} 制定 ／ {REVISED} 改定（{EFFECTIVE}から適用）
        </p>
      }
    />
  );
}
