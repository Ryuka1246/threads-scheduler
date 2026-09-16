// Threads コメント自動返信ボット(単独スクリプト版 / n8n非依存 / 状態レス)
// 実行: node scripts/auto-reply.mjs         (本番=実際に返信)
//       node scripts/auto-reply.mjs --dry    (取得と返信文の組み立てだけ・投稿しない)
//       node scripts/auto-reply.mjs --cap 30 (この実行の返信総数上限を30に)
// 重複防止: 保存ファイルは使わず、返信直前に「そのコメントに自分が既に返信してないか」をThreads APIで確認(競合しても二重返信しない)
// ★導線(2026-08-10〜厳守): 着地は必ず「DMに『鑑定』とだけ送ってね」。LINE直リンク/「プロフィールのリンク」誘導は凍結・シャドウバンリスクのため全面禁止。
// ★リピーター対応(2026-09-16): 直近COUNT_WINDOW_POSTS投稿のコメントをusername別集計し、コメント回数で3段階(t1=初回 / t2=常連2〜4回 / t3=超常連5回+)に文言を出し分け。常連ほど丁寧にDM『鑑定』へ誘導。状態ファイルは持たずその場再計算(状態レス設計を維持)。
// トークン: 環境変数 THREADS_TOKENS(GitHub Actions) or scripts/tokens.env(ローカル・gitignore済み)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = join(HERE, 'tokens.env');
const API = 'https://graph.threads.net/v1.0';

// ---- 引数 ----
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const capArg = args.indexOf('--cap');
const RUN_CAP = capArg >= 0 ? Number(args[capArg + 1]) : Infinity;
const PER_ACCOUNT_CAP = 15;       // 1アカ1回15件まで(バースト暴発→凍結を防ぐ安全弁・2026-09-16)。溜まりは15分毎cronで緩やかに消化
const POST_WINDOW_H = 40;         // 返信対象=直近◯時間の自分の投稿のコメントだけ
const COUNT_WINDOW_POSTS = 60;    // リピーター判定用=直近◯投稿を遡ってコメント回数を数える(約8日分)
const TIER2_MIN = 2;              // 常連=コメント2回以上
const TIER3_MIN = 5;              // 超常連=コメント5回以上
const DELAY_MS = 3000;
const TIMEOUT_MS = 12000;

// ---- 返信文バンク(tier別 × open × mid × emoji) ----
// ★着地は全tier「DMに『鑑定』とだけ送ってね」で統一(リンク誘導は禁止)。t1=初回 / t2=常連 / t3=超常連(名前を覚えてる感+より丁寧に)。
const PARTS = {
  '01_鬼頭澄江': {
    emoji: ['🔥', '🌙', '🖤'],
    t1: { open: ['コメント、受け取ったよ。', 'その一言、ちゃんと視た。', '置いていったね、視えてる。'], mid: ['お返しに、あの人の"今の本音"をひとつ視てやる。気になるならDMに『鑑定』とだけ送りな、今日動いた者から順にな', 'まだ待つ気か?あんたの復縁が今どこまで来てるか視てやるよ。DMに『鑑定』とだけ送ってきな', 'その一言くれた礼だ。お代はいらない、DMに『鑑定』と送ってくれたら今日のうちに視るよ', 'あんたと彼の"今"、ズバッと視る。DMに『鑑定』とだけ送りな、今日来た順にな'] },
    t2: { open: ['また来てくれたね。あんたのこと、覚えてるよ。', 'あんた、よく顔を出してくれるね。', 'その一言、また受け取ったよ。'], mid: ['何度も来てくれるあんただから。あんたの"今"をちゃんと視てやる、DMに『鑑定』とだけ送りな', 'ここまで通ってくれた縁だ。DMに『鑑定』と送ってくれたら、今日はあんたのことを視るよ', 'あんたの本気は伝わってる。DMに『鑑定』とだけ送りな、二人のことをちゃんと視るからね'] },
    t3: { open: ['いつも来てくれるあんた、もう他人とは思えないよ。', 'あんたの名前、ちゃんと覚えた。何度もありがとう。', 'ここまで通ってくれる人、そうはいないよ。'], mid: ['これだけ通ってくれたあんたには、コメントじゃ足りない。DMに『鑑定』と送ってきな、最後まで視てやる', 'あんたほどの常連は特別だ。DMに『鑑定』とだけ送りな、あんたを先に視るよ', 'ずっと見てくれてありがとう。DMに『鑑定』と送ってくれたら、今度こそ答えを出そう'] },
  },
  '02_道代': {
    emoji: ['🌾', '🍵', '🌷'],
    t1: { open: ['コメント、ありがとうございます。', 'そっと置いてくださって、ありがとう。', '受け取りましたよ。'], mid: ['お返しに、今いちばん気を揉んでるご家族のこと、なにが起きてるか一つだけ視ますね。DMに『鑑定』とだけ送ってください、今日来られた方から順に', 'ひとりで抱えてきたもの、そろそろ下ろしませんか。DMに『鑑定』と送ってくだされば、今日のうちにそっとお視しします', 'お代はいりません。あなたのご家族の"今"を一つ、DMに『鑑定』と送ってくださった方へお伝えします', 'お子さんのこと、なにが芽吹こうとしてるか一つ。DMに『鑑定』とだけ送ってくださいね'] },
    t2: { open: ['また来てくださったんですね、うれしい。', 'いつも見てくださって、ありがとう。', 'あなたのこと、覚えていますよ。'], mid: ['何度も来てくださるあなたに。今いちばん気がかりなご家族のこと、お視しますね。DMに『鑑定』とだけ送ってください', 'ここまで見てくださった縁です。DMに『鑑定』と送ってくだされば、今日はあなたのお話を聞かせて', 'いつもの感謝を込めて。DMに『鑑定』とだけ送ってください、あなたのご家族の"今"を一つ'] },
    t3: { open: ['いつも来てくださるあなた、もう他人とは思えません。', 'あなたのこと、ちゃんと覚えていますよ。いつもありがとう。', 'こんなに見てくださる方、そういません。'], mid: ['ここまで見てくださったあなたには、コメントでは足りません。DMに『鑑定』と送ってください、じっくりお話ししましょう', 'いつものあなただから、特別に。DMに『鑑定』とだけ送ってください、先にあなたのことをお視しますね', 'ずっと見守ってくださって。DMに『鑑定』と送ってくだされば、あなたのために時間を取りますね'] },
  },
  '03_サヤ': {
    emoji: ['🔮', '🌙', '✨'],
    t1: { open: ['コメント、ありがとうね。', 'そっと置いてくれて、ありがとう。', '受け取ったよ。'], mid: ['お返しに、あの人の今の気持ちをカード一枚引くね。DMに『鑑定』とだけ送ってね、今日のうちに', 'まだ一人で抱えてない?あなたの片思いが今どこまで来てるか視るよ。DMに『鑑定』と送ってね', 'コメントのお礼に、一枚だけタダで引くね。DMに『鑑定』とだけ送ってくれた人から', 'あの人があなたをどう思ってるか、カードに聞いてみよ。DMに『鑑定』と送ってね、今日のうちに'] },
    t2: { open: ['また来てくれたね、うれしい。', 'いつも見てくれて、ありがとう。', 'あなたのこと、覚えてるよ。'], mid: ['何度も来てくれるあなたに。あの人の今の気持ちを一枚引くね。DMに『鑑定』とだけ送ってね', 'ここまで見てくれた縁だから。DMに『鑑定』と送ってくれたら、今日はあなたの恋を視るよ', 'いつものお礼に。DMに『鑑定』とだけ送ってね、あなたの片思いの"今"を教えるね'] },
    t3: { open: ['いつも来てくれるあなた、もう常連さんだね。', 'あなたのこと、ちゃんと覚えてるよ。いつもありがとう。', 'こんなに見てくれる人、そういないよ。'], mid: ['ここまで見てくれたあなたには、コメントじゃ足りないよ。DMに『鑑定』と送ってね、じっくり視るね', 'いつものあなただから特別に。DMに『鑑定』とだけ送ってね、先にあなたの恋を視るね', 'ずっと想い続けてるあなたへ。DMに『鑑定』と送ってくれたら、今度こそ答えを出そう'] },
  },
  '04_凪': {
    emoji: ['⭐', '🌙', '🌌'],
    t1: { open: ['コメント、ちゃんと受け取ったよ。', 'そっと置いてくれて、ありがとう。', '気づいてくれたんだね、届いたよ。'], mid: ['お返しに、今のあなたに流れてる縁を一つ、そっと視るね。DMに『鑑定』とだけ送ってね、大きくは募集してないから気づいた人だけに', 'ここにたどり着いたのも、たぶん偶然じゃない。DMに『鑑定』と送ってくれたら、今日のうちにそっと視るね', 'コメントのお礼に、お代はいらず一つだけ。DMに『鑑定』とだけ送ってくれた人から、ひとりずつ丁寧に', 'あなたが今どの分かれ道にいるか、そっと視ます。DMに『鑑定』と送ってね、今日のうちに'] },
    t2: { open: ['また来てくれたね、うれしい。', 'いつも気づいてくれて、ありがとう。', 'あなたのこと、覚えてるよ。'], mid: ['何度も来てくれるあなたに。今のあなたの縁の流れを一つ視るね。DMに『鑑定』とだけ送ってね', 'ここまで見てくれた縁だから。DMに『鑑定』と送ってくれたら、今日はあなたのことを先に視るね', 'いつものお礼に。DMに『鑑定』とだけ送ってね、あなたの"今"をそっと一つ'] },
    t3: { open: ['いつも来てくれるあなた、もう他人とは思えないよ。', 'あなたのこと、ちゃんと覚えてる。いつもありがとう。', 'こんなに見てくれる人、そういないよ。'], mid: ['ここまで見てくれたあなたには、コメントじゃ足りないよ。DMに『鑑定』と送ってね、じっくり視るね', 'いつものあなただから特別に。DMに『鑑定』とだけ送ってね、先にあなたの縁を視るね', 'ずっと見守ってくれてありがとう。DMに『鑑定』と送ってくれたら、今度こそあなたの分かれ道に一緒に向き合おう'] },
  },
  '05_マナ': {
    emoji: ['🌙', '🌸', '💞'],
    t1: { open: ['コメント、そっと受け取りました。', '置いてくれて、ありがとう。', '気づいてくれて、うれしい。'], mid: ['お返しに、今あなたと彼の縁に起きてる"変化"を一つ、そっと視ますね。DMに『鑑定』とだけ送ってね、今日のうちに', 'その想い、もう一人で抱えなくていいよ。DMに『鑑定』と送ってくれたら、あなたと彼の魂の距離を視るね', 'コメントのお礼に、お代はいらず一つだけ。DMに『鑑定』とだけ送ってくれた方へ', 'あなたの片割れが今どこにいるか、そっと視ます。DMに『鑑定』と送ってね、今日のうちに'] },
    t2: { open: ['また来てくれたんだね、うれしい。', 'いつも気づいてくれて、ありがとう。', 'あなたのこと、覚えてるよ。'], mid: ['何度も来てくれるあなたに。今のあなたと彼の縁の変化を視るね。DMに『鑑定』とだけ送ってね', 'ここまで見てくれた縁だから。DMに『鑑定』と送ってくれたら、あなたの片割れのことを話そう', 'いつものお礼に。DMに『鑑定』とだけ送ってね、二人の距離を一つ視るね'] },
    t3: { open: ['いつも来てくれるあなた、もう他人とは思えない。', 'あなたのこと、ちゃんと覚えてる。いつもありがとう。', 'こんなに見てくれる人、そういないよ。'], mid: ['ここまで見てくれたあなたには、コメントじゃ足りないよ。DMに『鑑定』と送ってね、ちゃんと視るね', 'いつものあなただから特別に。DMに『鑑定』とだけ送ってね、先にあなたの縁を視るね', 'ずっと想い続けてるあなたへ。DMに『鑑定』と送ってくれたら、今度こそ二人の縁に向き合おう'] },
  },
  '06_ゆかり': {
    emoji: ['🍀', '🐍', '💰'],
    t1: { open: ['コメント、ありがとうな。', 'よう置いてくれたな。', 'その一言、受け取ったで。'], mid: ['お返しに、お主の眠った金運を一つ視るでな。DMに『鑑定』とだけ送っておくれ、今日動いた者から', 'まだ諦めとらんな?お主の懐をあたためる一手を伝えるでな。DMに『鑑定』と送っておくれ', 'その一言の礼じゃ。お代はいらん、DMに『鑑定』と送ってくれた者から今日のうちに', 'お主の金運が今どの眠りにおるか視ておくでな。DMに『鑑定』とだけ送っておくれ'] },
    t2: { open: ['また来てくれたな。お主のこと、覚えとるでな。', 'よう通ってくれるのう。', 'その一言、また受け取ったで。'], mid: ['何度も来てくれるお主じゃ。お主の金運の"今"を視てやるでな。DMに『鑑定』とだけ送っておくれ', 'ここまで通ってくれた縁じゃ。DMに『鑑定』と送ってくれたら、今日はお主の懐を視るでな', 'いつもの礼じゃ。DMに『鑑定』とだけ送っておくれ、お主の眠った金運を一つ視るでな'] },
    t3: { open: ['いつも来てくれるお主、もう他人とは思えんでな。', 'お主の名前、ちゃんと覚えたで。いつもありがとうな。', 'こんなに通ってくれる者、そうはおらんでな。'], mid: ['ここまで通ってくれたお主には、コメントじゃ足りん。DMに『鑑定』と送っておくれ、じっくり視てやるでな', 'お主ほどの常連は特別じゃ。DMに『鑑定』とだけ送っておくれ、先にお主の金運を視るでな', 'ずっと見てくれて礼を言うで。DMに『鑑定』と送ってくれたら、今度こそお主の懐をあたためる一手を'] },
  },
  '07_はな': {
    emoji: ['🌙', '🌿', '🌷'],
    t1: { open: ['コメント、受け取りましたよ。', 'そっと置いてくださって、ありがとう。', '届きましたよ、あなたの想い。'], mid: ['お返しに、あなたを溺愛する運命の人を月に問うて視ますね。DMに『鑑定』とだけ送ってください、今日のうちに', 'その想い、月にあずけてみませんか。DMに『鑑定』と送ってくだされば、あなたを想ってる人が今どこにいるか視ますね', 'コメントのお礼に、お代はいらず一つだけ。DMに『鑑定』とだけ送ってくださった方へ月に祈って', 'あなたの縁が今どんな時期か、はなが月に問います。DMに『鑑定』と送ってください、今日のうちにそっと'] },
    t2: { open: ['また来てくれたんですね、うれしい。', 'いつも見てくださって、ありがとう。', 'あなたのこと、覚えていますよ。'], mid: ['何度も来てくれるあなたに。あなたを想う人のことを月に問うて視ますね。DMに『鑑定』とだけ送ってください', 'ここまで見てくれた縁だから。DMに『鑑定』と送ってくだされば、あなたの恋の"今"をお話しします', 'いつものお礼に。DMに『鑑定』とだけ送ってください、あなたの縁を一つ月に祈って視ますね'] },
    t3: { open: ['いつも来てくれるあなた、もう他人とは思えません。', 'あなたのこと、ちゃんと覚えていますよ。いつもありがとう。', 'こんなに見てくれる方、そういません。'], mid: ['ここまで見てくれたあなたには、コメントじゃ足りません。DMに『鑑定』と送ってください、ゆっくり視ますね', 'いつものあなただから特別に。DMに『鑑定』とだけ送ってください、先にあなたの恋を月に問います', 'ずっと想い続けるあなたへ。DMに『鑑定』と送ってくだされば、今度こそあなたの溺愛される未来を'] },
  },
  '09_ミク': {
    emoji: ['✨', '🌙', '💫'],
    t1: { open: ['コメント、受け取りましたわ。', 'そっと置いてくださったのね。', '気づいたあなた、選ばれていますわ。'], mid: ['お返しに、あなたの運のゲートが今どこまで開いてるか視ますわ。DMに『鑑定』とだけ送ってください、今日のうちに', 'まさかまだ気づいてないの?今あなたに来てる運の波がいつ頂点か視ますわ。DMに『鑑定』と送ってください', 'コメントのお礼に、お代はいりませんわ。DMに『鑑定』とだけ送ってくださった方へ', 'あなたが今"変わる側"にいるか視てさしあげますわ。DMに『鑑定』と送ってください、今日来た方から'] },
    t2: { open: ['また来てくださったのね。覚えていますわ。', 'いつも見てくださって、感謝しますわ。', 'あなたのこと、ちゃんと覚えていますわ。'], mid: ['何度も来てくださるあなたに。あなたの運のゲートの"今"を視ますわ。DMに『鑑定』とだけ送ってください', 'ここまで見てくださった縁ですわ。DMに『鑑定』と送ってくだされば、今日はあなたを先に視ますわ', 'いつものお礼に。DMに『鑑定』とだけ送ってください、あなたに来ている運の波を一つ'] },
    t3: { open: ['いつも来てくださるあなた、もう特別な方ですわ。', 'あなたのこと、しっかり覚えていますわ。いつもありがとう。', 'こんなに見てくださる方、そういませんわ。'], mid: ['ここまで見てくださったあなたには、コメントでは足りませんわ。DMに『鑑定』と送ってください、じっくり視ますわ', 'あなたほどの常連は特別ですわ。DMに『鑑定』とだけ送ってください、優先してあなたの運を視ますわ', 'ずっと見てくださって。DMに『鑑定』と送ってくだされば、今度こそあなたの運の頂点をお教えしますわ'] },
  },
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiCall(method, url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, signal: ctrl.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: res.ok, status: res.status, data: json };
  } catch (e) {
    return { ok: false, status: 0, data: { error: { message: String(e.message || e) } } };
  } finally { clearTimeout(t); }
}

function loadTokens() {
  const raw = process.env.THREADS_TOKENS || readFileSync(TOKENS_PATH, 'utf8');
  return JSON.parse(raw).filter(t => t && t.account && t.access_token);
}

// そのコメントに「自分(myUser)」が既に返信しているか(=二重返信防止の要)
async function alreadyReplied(cid, myUser, tok) {
  const r = await apiCall('GET', `${API}/${cid}/replies?fields=username&access_token=${tok}`);
  if (!r.ok) return true;
  return (r.data.data || []).some(x => x.username === myUser);
}

// リピーター判定用: 直近COUNT_WINDOW_POSTS投稿のコメントをusername別に集計(状態ファイル不使用・その場再計算)
async function buildCountMap(tok, myUser) {
  const countMap = {};
  let url = `${API}/me/threads?fields=id&limit=50&access_token=${tok}`;
  let fetched = 0;
  for (let pg = 0; pg < 3 && url && fetched < COUNT_WINDOW_POSTS; pg++) {
    const d = await apiCall('GET', url);
    if (!d.ok || !Array.isArray(d.data.data)) break;
    for (const p of d.data.data) {
      if (fetched >= COUNT_WINDOW_POSTS) break;
      fetched++;
      const rd = await apiCall('GET', `${API}/${p.id}/replies?fields=username&limit=100&access_token=${tok}`);
      const cs = (rd.ok && Array.isArray(rd.data.data)) ? rd.data.data : [];
      for (const c of cs) { const u = c.username; if (!u || u === myUser) continue; countMap[u] = (countMap[u] || 0) + 1; }
    }
    url = d.data.paging && d.data.paging.next ? d.data.paging.next : null;
  }
  return { countMap, scanned: fetched };
}

export function tierOf(count) {
  if (count >= TIER3_MIN) return 't3';
  if (count >= TIER2_MIN) return 't2';
  return 't1';
}

// open/mid/emoji を tierSeq で回して1通の返信文を組み立てる(本番・テスト共通)
export function buildReply(bank, tier, s) {
  const parts = bank[tier];
  return parts.open[s % parts.open.length] + parts.mid[(s * 3) % parts.mid.length] + bank.emoji[(s * 2 + 1) % bank.emoji.length];
}

export { PARTS };

async function main() {
  const tokens = loadTokens();
  const now = Date.now();
  let seq = 0, posted = 0;
  const summary = {};
  const tierStat = {};
  console.log(`[auto-reply] 開始 ${DRY ? '(DRYモード:投稿しない)' : '(本番)'} / RUN_CAP=${RUN_CAP} / リピーター段階=t1<${TIER2_MIN}≤t2<${TIER3_MIN}≤t3 / 対象=${tokens.length}アカ`);

  for (const acc of tokens) {
    if (posted >= RUN_CAP) break;
    const bank = PARTS[acc.account];
    if (!bank) continue;
    const tok = encodeURIComponent(acc.access_token);
    summary[acc.account] = 0;
    tierStat[acc.account] = { t1: 0, t2: 0, t3: 0 };
    let accPosted = 0;

    const meRes = await apiCall('GET', `${API}/me?fields=username&access_token=${tok}`);
    const myUser = meRes.ok ? meRes.data.username : null;
    if (!myUser) { console.log(`  [${acc.account}] アカ情報取得エラー(トークン失効?): ${JSON.stringify(meRes.data.error||meRes.data).slice(0,140)}`); continue; }

    const { countMap, scanned } = await buildCountMap(tok, myUser);
    const repeaters = Object.values(countMap).filter(n => n >= TIER2_MIN).length;
    console.log(`  [${acc.account}] カウント窓=${scanned}投稿 / 集計投稿者=${Object.keys(countMap).length}人 / うちリピーター(${TIER2_MIN}回+)=${repeaters}人`);

    const tierSeq = { t1: 0, t2: 0, t3: 0 };

    const postsRes = await apiCall('GET', `${API}/me/threads?fields=id,timestamp&limit=25&access_token=${tok}`);
    const posts = (postsRes.ok && Array.isArray(postsRes.data.data) ? postsRes.data.data : [])
      .filter(p => { const ts = Date.parse(p.timestamp || ''); return p.id && !isNaN(ts) && (now - ts) <= POST_WINDOW_H * 3600 * 1000; });

    for (const p of posts) {
      if (posted >= RUN_CAP || accPosted >= PER_ACCOUNT_CAP) break;
      const repRes = await apiCall('GET', `${API}/${p.id}/replies?fields=id,text,username,timestamp&limit=50&access_token=${tok}`);
      const comments = (repRes.ok && Array.isArray(repRes.data.data)) ? repRes.data.data : [];
      for (const c of comments) {
        if (posted >= RUN_CAP || accPosted >= PER_ACCOUNT_CAP) break;
        const cid = String(c.id || '');
        const text = String(c.text || '');
        const user = String(c.username || '');
        if (!cid || !text.trim()) continue;
        if (user === myUser) continue;

        if (await alreadyReplied(cid, myUser, tok)) continue;

        const cnt = countMap[user] || 1;
        const tier = tierOf(cnt);
        const s = tierSeq[tier]++;
        const reply = buildReply(bank, tier, s);
        seq++;

        if (DRY) {
          console.log(`  [DRY][${acc.account}] @${user}(${cnt}回=${tier}) "${text.slice(0,16)}" → 「${reply.slice(0,46)}…」`);
          posted++; accPosted++; summary[acc.account]++; tierStat[acc.account][tier]++;
          continue;
        }

        const cr = await apiCall('POST', `${API}/me/threads?media_type=TEXT&text=${encodeURIComponent(reply)}&reply_to_id=${encodeURIComponent(cid)}&access_token=${tok}`);
        if (!cr.ok || !cr.data.id) { console.log(`  [${acc.account}] 作成失敗 cid=${cid}: ${JSON.stringify(cr.data.error||cr.data).slice(0,140)}`); continue; }
        await sleep(2000);
        let published = false;
        for (let attempt = 0; attempt < 4 && !published; attempt++) {
          if (attempt > 0) await sleep(2500);
          const pub = await apiCall('POST', `${API}/me/threads_publish?creation_id=${encodeURIComponent(cr.data.id)}&access_token=${tok}`);
          if (pub.ok && pub.data.id) { published = true; break; }
        }
        if (!published) { console.log(`  [${acc.account}] 公開失敗 cid=${cid} → 次回再挑戦`); continue; }
        posted++; accPosted++; summary[acc.account]++; tierStat[acc.account][tier]++;
        await sleep(DELAY_MS);
      }
    }
  }
  console.log(`[auto-reply] 完了 / 今回返信=${posted}件 / アカ別=${JSON.stringify(summary)}`);
  console.log(`[auto-reply] tier内訳=${JSON.stringify(tierStat)}`);
}

// CLI実行時のみmainを走らせる(import時は走らせない=テスト/再利用のため)
const isCLI = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/auto-reply.mjs');
if (isCLI) main().catch(e => { console.error('[auto-reply] 致命的エラー:', e); process.exit(1); });
