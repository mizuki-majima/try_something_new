import type { OfficialRecipe } from "./schemas";

/**
 * Official recipes bundled with the app (shown to every visitor, also offline).
 * "after" is written as a possibility, never as a claim about other users — we have no data behind it.
 * Community recipes live in DynamoDB; official ones only get counters (startCount, storyCount) there.
 */
export const OFFICIAL_RECIPES: readonly OfficialRecipe[] = [
  {"id":"photo","seal":"写","title":"毎日1枚、写真を撮る","category":"hands","minutes":5,"place":"any","difficulty":1,"summary":"何でもいいので1日1枚、スマホで撮る。","how":["「撮るもの」を決めない。目に留まったものを撮る","同じ時間帯に撮ると、あとで比べるのがおもしろい","最終日に30枚を並べて眺める時間を取る"],"after":"通勤路の見え方が変わるかもしれません。30枚並べると、自分が何に目を留めるのか、好みが見えてきます。"},
  {"id":"walk","seal":"歩","title":"毎日20分歩く","category":"body","minutes":20,"place":"out","difficulty":1,"summary":"距離や速さは気にせず、20分だけ外を歩く。","how":["時間帯を固定する（出勤前、昼休み、夕食後）","雨の日は駅ひとつ分だけでOK","歩きながら聞くもの（音声、音楽）を決めておくと続く"],"after":"20分歩くことへのハードルが下がり、「歩いて行くか」が選択肢に入るかもしれません。"},
  {"id":"diary","seal":"記","title":"3行日記","category":"mind","minutes":5,"place":"home","difficulty":1,"summary":"寝る前に、今日のことを3行だけ書く。","how":["「よかったこと・困ったこと・明日やること」の型にすると迷わない","長く書かない。3行で止める","紙でもスマホのメモでもいい。場所を固定する"],"after":"1日を「終わらせる」区切りになります。30日後に読み返すと、気分の波のパターンが見えるかもしれません。"},
  {"id":"nosugar","seal":"断","title":"甘いものを断つ","category":"quit","minutes":0,"place":"any","difficulty":3,"summary":"お菓子・甘い飲み物をやめる。果物はOKなど、自分ルールを決める。","how":["初日に自分ルールを文章で決める（例外を先に決める）","代わりに口に入れるものを用意する（ナッツ、炭酸水）","最初の1週間が山。乗り切ると楽になる"],"after":"果物や野菜の甘さを強く感じるようになるかもしれません。「なんとなく食べていた分」がどれくらいあったかが見えてきます。"},
  {"id":"early","seal":"朝","title":"1時間早く起きる","category":"body","minutes":0,"place":"home","difficulty":3,"summary":"いつもより1時間早く起き、その時間を自分のために使う。","how":["早く起きるより「早く寝る」を先に設計する","起きてやることを前夜に1つ決めておく","休日もずらさない（ずらすと振り出しに戻る）"],"after":"朝の1時間をどう感じるかがわかります。合わなければ、それも収穫です。"},
  {"id":"cook","seal":"食","title":"毎日1品、自炊する","category":"hands","minutes":30,"place":"home","difficulty":2,"summary":"1日1品でいい。味噌汁でも卵焼きでも、自分で作る。","how":["「1品」の定義をゆるくする（切って和えるだけもOK）","週末に調味料と定番食材をそろえる","作ったものを写真に残すと30日後が楽しい"],"after":"包丁と火に慣れてきます。30日続けば、作れるものが何品か手元に残ります。"},
  {"id":"meditate","seal":"静","title":"5分の瞑想","category":"mind","minutes":5,"place":"home","difficulty":1,"summary":"座って目を閉じ、5分だけ呼吸に意識を向ける。","how":["タイマーをかけて、鳴るまで座るだけ","雑念が出るのは普通。気づいたら呼吸に戻る","朝一番か寝る前、同じ時間に"],"after":"「いまイライラしているな」と、自分の状態に気づくきっかけになるかもしれません。"},
  {"id":"english","seal":"英","title":"英語で1日1フレーズ","category":"mind","minutes":10,"place":"any","difficulty":2,"summary":"その日に使いたかった英語表現を1つ調べて、声に出す。","how":["「今日言えなかったこと」から探すと身につく","声に出して3回。できれば録音する","フレーズはひとつのメモにためていく"],"after":"30フレーズが手元に残ります。自分がよく言いたくなる言い回しの傾向も見えてきます。"},
  {"id":"sketch","seal":"描","title":"1日1スケッチ","category":"hands","minutes":10,"place":"any","difficulty":1,"summary":"目の前にあるものを1つ、10分で描く。","how":["うまく描こうとしない。線を引くことが目的","ペン1本、ノート1冊に固定する","日付を入れて、ページをめくれるようにする"],"after":"ものの形をじっくり見る時間が増えます。1枚目と30枚目を並べると、変化がわかるはずです。"},
  {"id":"tidy","seal":"整","title":"1日1か所、片付ける","category":"hands","minutes":10,"place":"home","difficulty":1,"summary":"引き出し1段、棚1段など、小さな1か所だけを片付ける。","how":["「1か所」を小さく定義する（机の上ではなく、引き出し1段）","捨てる・残す・迷う、の3つの箱を用意する","片付けた場所の写真を撮っておく"],"after":"30か所が片付きます。「全部やらなきゃ」という重さが軽くなるかもしれません。"},
  {"id":"read","seal":"読","title":"毎日10ページ読む","category":"mind","minutes":15,"place":"any","difficulty":1,"summary":"どんな本でもいい。1日10ページだけ読む。","how":["読む場所と時間を固定する（電車、寝る前）","つまらなければ本を変えていい","読んだページに日付を書く"],"after":"1日10ページで300ページ。1〜2冊を読み終える計算です。"},
  {"id":"nosns","seal":"離","title":"SNSを見ない","category":"quit","minutes":0,"place":"any","difficulty":3,"summary":"30日間、SNSアプリを開かない。投稿も閲覧もしない。","how":["アプリを削除する（ログアウトだけでは弱い）","手持ちぶさたの時に開くものを決めておく（本、メモ）","知人には先に伝えておく"],"after":"空いた時間がどれくらいあったかがわかります。30日後に、戻すかどうかを落ち着いて考えられます。"},
  {"id":"pushup","seal":"筋","title":"腕立て・スクワット各10回","category":"body","minutes":5,"place":"home","difficulty":1,"summary":"毎日、腕立て伏せ10回とスクワット10回。それだけ。","how":["回数を増やさない。10回を30日続けることが目的","歯みがきの前など、既にある習慣にくっつける","つらい日は膝つきでも、5回でもOK"],"after":"「運動した」という感覚が毎日残ります。30日後に回数を増やしたくなるかどうかで、向き不向きがわかります。"},
  {"id":"talk","seal":"話","title":"1日1人、知らない人と話す","category":"people","minutes":5,"place":"out","difficulty":3,"summary":"店員さん、同じ電車の人、誰でもいい。ひとこと会話する。","how":["「ありがとう」に一言足すところから（「それ、いいですね」）","同じ店に通うと、会話が育つ","うまくいかなかった日も、話しかけた時点で成功"],"after":"話しかけるハードルが少し下がるかもしれません。よく行く店に、顔見知りができることもあります。"},
  {"id":"music","seal":"奏","title":"楽器を10分さわる","category":"hands","minutes":10,"place":"home","difficulty":2,"summary":"持っている楽器（なければアプリでも）に毎日10分だけ触れる。","how":["楽器をケースから出して、見える場所に置く","1曲を決めて、その一部だけを繰り返す","10分で止める。やりたい気持ちを残す"],"after":"決めた1曲の一部が弾けるようになるかもしれません。"},
  {"id":"water","seal":"水","title":"水を1日1.5L飲む","category":"body","minutes":0,"place":"any","difficulty":1,"summary":"甘くない水やお茶を、1日1.5Lを目安に飲む。","how":["ボトルを決めて、1日に何本かで数える","朝起きてすぐコップ1杯から始める","トイレが近くなるのは最初だけのことが多い"],"after":"「のどが渇いた」に気づきやすくなるかもしれません。甘い飲み物との付き合い方も見えてきます。"},
  {"id":"bike","seal":"輪","title":"自転車で通勤・移動する","category":"body","minutes":30,"place":"out","difficulty":2,"summary":"普段の移動を、できる日は自転車に替える。","how":["まず週に何日できそうか見積もる（全日でなくていい）","雨の日は休みにする。ルールは最初に","ライトと鍵は最初にそろえる"],"after":"季節や風を感じる移動になります。所要時間や疲れ方を、電車と比べられます。"},
  {"id":"thanks","seal":"謝","title":"寝る前に感謝を3つ書く","category":"mind","minutes":3,"place":"home","difficulty":1,"summary":"今日ありがたかったことを、小さくても3つ書く。","how":["「晴れた」「コーヒーがおいしかった」程度でいい","人のことを書いたら、翌日本人に伝えてみる","同じことが続いても気にしない"],"after":"日中に「これを書こう」と探すようになるかもしれません。"},
  {"id":"novel","seal":"書","title":"毎日1,600字書く","category":"hands","minutes":30,"place":"home","difficulty":3,"summary":"30日で約5万字。小説でもエッセイでも、とにかく毎日1,600字。","how":["うまく書かない。字数だけを見る","書く時間を朝か夜に固定する","翌日すぐ続きから書けるよう、キリの悪いところで止める"],"after":"約5万字のかたまりが手元に残ります。"},
  {"id":"nobuy","seal":"倹","title":"新しいものを買わない","category":"quit","minutes":0,"place":"any","difficulty":2,"summary":"食品・消耗品以外の買い物を30日やめる。","how":["欲しくなったものは「30日後リスト」にメモする","例外（壊れた必需品など）は最初に決める","30日後にリストを見返して、まだ欲しいか確認する"],"after":"30日後リストを見返すと、もう欲しくないものが見つかるかもしれません。自分の買い物の「波」が見えてきます。"},
  {"id":"reach","seal":"連","title":"1日1人、連絡する","category":"people","minutes":5,"place":"any","difficulty":2,"summary":"しばらく連絡していない人に、短いメッセージを送る。","how":["「元気？ふと思い出して」で十分","返事を期待しない。送ることが目的","思い出した順に送る。リストを作らなくていい"],"after":"最大30人とのつながりを思い出せます。久しぶりに会う約束につながることもあります。"},
  {"id":"praise","seal":"褒","title":"1日1回、人をほめる","category":"people","minutes":1,"place":"any","difficulty":1,"summary":"家族・同僚・店員さん、誰かのいいところを1つ、声に出して伝える。","how":["具体的に言う（「その資料、見やすかった」）","照れたら短く。「それ、いいね」で十分","言った相手と内容を一言メモする"],"after":"人のいいところを探す目が育つかもしれません。"},
  {"id":"stretch","seal":"伸","title":"寝る前にストレッチ5分","category":"body","minutes":5,"place":"home","difficulty":1,"summary":"布団に入る前に、5分だけ体を伸ばす。","how":["メニューは3〜4種類に固定する（迷わない）","布団の上でやる。マットを出さない","呼吸をゆっくりに。それだけで効きが違う"],"after":"肩や腰の「いつもの重さ」に気づけるようになるかもしれません。"},
];

export function findOfficialRecipe(id: string): OfficialRecipe | undefined {
  return OFFICIAL_RECIPES.find((r) => r.id === id);
}
