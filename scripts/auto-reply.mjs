// Threads コメント自動返信ボット(単独スクリプト版 / n8n非依存 / 状態レス)
// 実行: node scripts/auto-reply.mjs         (本番=実際に返信)
//       node scripts/auto-reply.mjs --dry    (取得と返信文の組み立てだけ・投稿しない)
//       node scripts/auto-reply.mjs --cap 30 (この実行の返信総数上限を30に)
// 重複防止: 保存ファイルは使わず、返信直前に「そのコメントに自分が既に返信してないか」をThreads APIで確認(競合しても二重返信しない)
// ★リピーター対応(2026-09-15追加): 返信直前に直近COUNT_WINDOW_POSTS投稿のコメントをusername別集計し、
//   コメント回数で3段階(t1=初回 / t2=常連2〜4回 / t3=超常連5回+)に文言を出し分ける。常連ほどLINE誘導を強める。
//   状態ファイルは持たず、その場でThreads APIから再計算する(現行の状態レス設計を維持)。
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
const RUN_CAP = capArg >= 0 ? Number(args[capArg + 1]) : Infinity; // 既定=上限なし(全件返信)。--cap で任意に制限可
const PER_ACCOUNT_CAP = Infinity; // 1アカ上限なし(溜まった分を一掃)。ブレーキは DELAY_MS の1件3秒ペーシングが担う
const POST_WINDOW_H = 40;         // 返信対象=直近◯時間の自分の投稿のコメントだけ
const COUNT_WINDOW_POSTS = 60;    // ★リピーター判定用=直近◯投稿を遡ってコメント回数を数える(約8日分)
const TIER2_MIN = 2;              // 常連=コメント2回以上
const TIER3_MIN = 5;              // 超常連=コメント5回以上
const DELAY_MS = 3000;            // 返信ごとの間隔(スパム判定回避=これが本当のブレーキ)
const TIMEOUT_MS = 12000;

// ---- 返信文バンク(tier別 × open × mid × emoji の組み合わせ) ----
// t1=初回(現行踏襲) / t2=常連(認識+特別感の入口) / t3=超常連(名前を覚えてる感+踏み込んだLINE誘導)
// 着地は全tier「プロフィールのリンクから」(BIO直リンク1タップ)。「無料」語は言い換え分散。
export const PARTS = {
  '01_鬼頭澄江': {
    emoji: ['🔥', '🌙', '🖤'],
    t1: { open: ['コメント、受け取ったよ。', 'その一言、ちゃんと視た。', '置いていったね、視えてる。'], mid: ['お返しに、あの人の"今の本音"をひとつ視てやる。プロフィールのリンクから、今日動いた者だけな', 'まだ待つ気か?あんたの復縁が今どこまで来てるか、プロフィールのリンクから視てやるよ', 'その一言くれた礼だ。お代はいらない、プロフィールのリンクから今日のうちにおいで', 'あんたと彼の"今"、ズバッと視る。プロフィールのリンクから、今日来た順にな'] },
    t2: { open: ['また来てくれたね。あんたのこと、覚えてるよ。', 'あんた、よく顔を出してくれるね。', 'その一言、また受け取ったよ。'], mid: ['何度も来てくれるあんただから。プロフィールのリンクから、あんたの"今"をちゃんと視てやる', 'ここまで通ってくれた縁だ。プロフィールのリンクから、今日はあんたのことを視せて', 'あんたの本気は伝わってる。プロフィールのリンクから、二人でゆっくり話そう'] },
    t3: { open: ['いつも来てくれるあんた、もう他人とは思えないよ。', 'あんたの名前、ちゃんと覚えた。何度もありがとう。', 'ここまで通ってくれる人、そうはいないよ。'], mid: ['これだけ通ってくれたあんたには、コメントじゃ足りない。プロフィールのリンクから来て、最後まで視させて', 'あんたほどの常連は特別だ。プロフィールのリンクから、あんたを先に視てやる', 'ずっと見てくれてありがとう。プロフィールのリンクから、今度こそ答えを出そう'] },
  },
  '02_道代': {
    emoji: ['🌾', '🍵', '🌷'],
    t1: { open: ['コメント、ありがとうございます。', 'そっと置いてくださって、ありがとう。', '受け取りましたよ。'], mid: ['お返しに、あなたが今いちばん気を揉んでるご家族のこと、なにが起きてるか一つだけ視ますね。プロフィールのリンクから、今日来られた方から順に', 'ひとりで抱えてきたもの、そろそろ下ろしませんか。プロフィールのリンクから、今日のうちにそっとお視しします', 'お代はいりません。あなたのご家族の"今"を一つ、プロフィールのリンクから今日の分としてお伝えします', 'お子さんのこと、なにが芽吹こうとしてるか一つ。プロフィールのリンクから、今日来た方へ'] },
    t2: { open: ['また来てくださったんですね、うれしい。', 'いつも見てくださって、ありがとう。', 'あなたのこと、覚えていますよ。'], mid: ['何度も来てくださるあなたに。プロフィールのリンクから、今いちばん気がかりなご家族のこと、お視しますね', 'ここまで見てくださった縁です。プロフィールのリンクから、今日はあなたのお話を聞かせて', 'いつもの感謝を込めて。プロフィールのリンクから、あなたのご家族の"今"をひとつ'] },
    t3: { open: ['いつも来てくださるあなた、もう他人とは思えません。', 'あなたのこと、ちゃんと覚えていますよ。いつもありがとう。', 'こんなに見てくださる方、そういません。'], mid: ['ここまで見てくださったあなたには、コメントでは足りません。プロフィールのリンクから、じっくりお話ししましょう', 'いつものあなただから、特別に。プロフィールのリンクから、先にあなたのことをお視しますね', 'ずっと見守ってくださって。プロフィールのリンクから、今度はあなたのために時間を取らせて'] },
  },
  '03_サヤ': {
    emoji: ['🔮', '🌙', '✨'],
    t1: { open: ['コメント、ありがとうね。', 'そっと置いてくれて、ありがとう。', '受け取ったよ。'], mid: ['お返しに、あの人の今の気持ちをカード一枚引くね。プロフィールのリンクから、今日のうちに', 'まだ一人で抱えてない?あなたの片思いが今どこまで来てるか、プロフィールのリンクから視るよ', 'コメントのお礼に、一枚だけタダで引くね。プロフィールのリンクから、今日来た人から', 'あの人があなたをどう思ってるか、カードに聞いてみよ。プロフィールのリンクから今日のうちに'] },
    t2: { open: ['また来てくれたね、うれしい。', 'いつも見てくれて、ありがとう。', 'あなたのこと、覚えてるよ。'], mid: ['何度も来てくれるあなたに。プロフィールのリンクから、あの人の今の気持ちを一枚引くね', 'ここまで見てくれた縁だから。プロフィールのリンクから、今日はあなたの恋をちゃんと視るよ', 'いつものお礼に。プロフィールのリンクから、あなたの片思いの"今"を教えるね'] },
    t3: { open: ['いつも来てくれるあなた、もう常連さんだね。', 'あなたのこと、ちゃんと覚えてるよ。いつもありがとう。', 'こんなに見てくれる人、そういないよ。'], mid: ['ここまで見てくれたあなたには、コメントじゃ足りないよ。プロフィールのリンクから来て、じっくり視させて', 'いつものあなただから特別に。プロフィールのリンクから、先にあなたの恋を視るね', 'ずっと想い続けてるあなたへ。プロフィールのリンクから、今度こそ答えを出そう'] },
  },
  '05_マナ': {
    emoji: ['🌙', '🌸', '💞'],
    t1: { open: ['コメント、そっと受け取りました。', '置いてくれて、ありがとう。', '気づいてくれて、うれしい。'], mid: ['お返しに、今あなたと彼の縁に起きてる"変化"を一つ、そっと視ますね。プロフィールのリンクから、今日のうちに', 'その想い、もう一人で抱えなくていいよ。プロフィールのリンクから、あなたと彼の魂の距離を視ますね', 'コメントのお礼に、お代はいらず一つだけ。プロフィールのリンクから、今日来た方へ', 'あなたの片割れが今どこにいるか、そっと視ます。プロフィールのリンクから、今日のうちに'] },
    t2: { open: ['また来てくれたんだね、うれしい。', 'いつも気づいてくれて、ありがとう。', 'あなたのこと、覚えてるよ。'], mid: ['何度も来てくれるあなたに。プロフィールのリンクから、今のあなたと彼の縁の変化を視るね', 'ここまで見てくれた縁だから。プロフィールのリンクから、あなたの魂の片割れのことを話そう', 'いつものお礼に。プロフィールのリンクから、二人の距離を一つ視させて'] },
    t3: { open: ['いつも来てくれるあなた、もう他人とは思えない。', 'あなたのこと、ちゃんと覚えてる。いつもありがとう。', 'こんなに見てくれる人、そういないよ。'], mid: ['ここまで見てくれたあなたには、コメントじゃ足りないよ。プロフィールのリンクから来て、ちゃんと視させて', 'いつものあなただから特別に。プロフィールのリンクから、先にあなたの縁を視るね', 'ずっと想い続けてるあなたへ。プロフィールのリンクから、今度こそ二人の縁に向き合おう'] },
  },
  '06_ゆかり': {
    emoji: ['🍀', '🐍', '💰'],
    t1: { open: ['コメント、ありがとうな。', 'よう置いてくれたな。', 'その一言、受け取ったで。'], mid: ['お返しに、お主の眠った金運を一つ視るでな。プロフィールのリンクから、今日動いた者から', 'まだ諦めとらんな?お主の懐をあたためる一手を、プロフィールのリンクから伝えるでな', 'その一言の礼じゃ。お代はいらん、プロフィールのリンクから今日のうちにおいで', 'お主の金運が今どの眠りにおるか、視ておくでな。プロフィールのリンクから、今日来た者から'] },
    t2: { open: ['また来てくれたな。お主のこと、覚えとるでな。', 'よう通ってくれるのう。', 'その一言、また受け取ったで。'], mid: ['何度も来てくれるお主じゃ。プロフィールのリンクから、お主の金運の"今"を視てやるでな', 'ここまで通ってくれた縁じゃ。プロフィールのリンクから、今日はお主の懐を視せてくれ', 'いつもの礼じゃ。プロフィールのリンクから、お主の眠った金運を一つ視るでな'] },
    t3: { open: ['いつも来てくれるお主、もう他人とは思えんでな。', 'お主の名前、ちゃんと覚えたで。いつもありがとうな。', 'こんなに通ってくれる者、そうはおらんでな。'], mid: ['ここまで通ってくれたお主には、コメントじゃ足りん。プロフィールのリンクから来て、じっくり視てやるでな', 'お主ほどの常連は特別じゃ。プロフィールのリンクから、先にお主の金運を視るでな', 'ずっと見てくれて礼を言うで。プロフィールのリンクから、今度こそお主の懐をあたためる一手を'] },
  },
  '07_はな': {
    emoji: ['🌙', '🌿', '🌷'],
    t1: { open: ['コメント、受け取りましたよ。', 'そっと置いてくださって、ありがとう。', '届きましたよ、あなたの想い。'], mid: ['お返しに、あなたを溺愛する運命の人を月に問うて視ますね。プロフィールのリンクから、今日のうちに', 'その想い、月にあずけてみませんか。プロフィールのリンクから、あなたを想ってる人が今どこにいるか視ますね', 'コメントのお礼に、お代はいらず一つだけ。プロフィールのリンクから、今日来た方へ月に祈って', 'あなたの縁が今どんな時期か、はなが月に問います。プロフィールのリンクから、今日のうちにそっと'] },
    t2: { open: ['また来てくれたんですね、うれしい。', 'いつも見てくださって、ありがとう。', 'あなたのこと、覚えていますよ。'], mid: ['何度も来てくれるあなたに。プロフィールのリンクから、あなたを想う人のことを月に問うて視ますね', 'ここまで見てくれた縁だから。プロフィールのリンクから、あなたの恋の"今"をお話しします', 'いつものお礼に。プロフィールのリンクから、あなたの縁を一つ、月に祈って視ますね'] },
    t3: { open: ['いつも来てくれるあなた、もう他人とは思えません。', 'あなたのこと、ちゃんと覚えていますよ。いつもありがとう。', 'こんなに見てくれる方、そういません。'], mid: ['ここまで見てくれたあなたには、コメントじゃ足りません。プロフィールのリンクから来て、ゆっくり視させて', 'いつものあなただから特別に。プロフィールのリンクから、先にあなたの恋を月に問いますね', 'ずっと想い続けるあなたへ。プロフィールのリンクから、今度こそあなたの溺愛される未来を'] },
  },
  '09_ミク': {
    emoji: ['✨', '🌙', '💫'],
    t1: { open: ['コメント、受け取りましたわ。', 'そっと置いてくださったのね。', '気づいたあなた、選ばれていますわ。'], mid: ['お返しに、あなたの運のゲートが今どこまで開いてるか視ますわ。プロフィールのリンクから、今日のうちに', 'まさかまだ気づいてないの?今あなたに来てる運の波がいつ頂点か、プロフィールのリンクから視ますわ', 'コメントのお礼に、お代はいりませんわ。プロフィールのリンクから、今日の分のうちに', 'あなたが今"変わる側"にいるか、視てさしあげますわ。プロフィールのリンクから、今日来た方から'] },
    t2: { open: ['また来てくださったのね。覚えていますわ。', 'いつも見てくださって、感謝しますわ。', 'あなたのこと、ちゃんと覚えていますわ。'], mid: ['何度も来てくださるあなたに。プロフィールのリンクから、あなたの運のゲートの"今"を視ますわ', 'ここまで見てくださった縁ですわ。プロフィールのリンクから、今日はあなたを先に視てさしあげます', 'いつものお礼に。プロフィールのリンクから、あなたに来ている運の波を一つ'] },
    t3: { open: ['いつも来てくださるあなた、もう特別な方ですわ。', 'あなたのこと、しっかり覚えていますわ。いつもありがとう。', 'こんなに見てくださる方、そういませんわ。'], mid: ['ここまで見てくださったあなたには、コメントでは足りませんわ。プロフィールのリンクから、じっくり視てさしあげます', 'あなたほどの常連は特別ですわ。プロフィールのリンクから、優先してあなたの運を視ますわ', 'ずっと見てくださって。プロフィールのリンクから、今度こそあなたの運の頂点をお教えしますわ'] },
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
  if (!r.ok) return true; // 確認できない時は安全側=スキップ(次回に再確認)
  return (r.data.data || []).some(x => x.username === myUser);
}

// ★リピーター判定用: 直近COUNT_WINDOW_POSTS投稿のコメントをusername別に集計(状態ファイル不使用・その場再計算)
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

async function main() {
  const tokens = loadTokens();
  const now = Date.now();
  let seq = 0, posted = 0;
  const summary = {};
  const tierStat = {}; // アカ別 tier内訳(効果確認用)
  console.log(`[auto-reply] 開始 ${DRY ? '(DRYモード:投稿しない)' : '(本番)'} / RUN_CAP=${RUN_CAP} / リピーター段階=t1<${TIER2_MIN}≤t2<${TIER3_MIN}≤t3 / 対象=${tokens.length}アカ`);

  for (const acc of tokens) {
    if (posted >= RUN_CAP) break;
    const bank = PARTS[acc.account];
    if (!bank) continue; // 04凪等はテンプレなし=スキップ
    const tok = encodeURIComponent(acc.access_token);
    summary[acc.account] = 0;
    tierStat[acc.account] = { t1: 0, t2: 0, t3: 0 };
    let accPosted = 0;

    // 自分の@username(自分のコメント/既返信の判定に使う)
    const meRes = await apiCall('GET', `${API}/me?fields=username&access_token=${tok}`);
    const myUser = meRes.ok ? meRes.data.username : null;
    if (!myUser) { console.log(`  [${acc.account}] アカ情報取得エラー(トークン失効?): ${JSON.stringify(meRes.data.error||meRes.data).slice(0,140)}`); continue; }

    // ★リピーター判定用のカウントマップを先に作る(直近60投稿のコメント集計)
    const { countMap, scanned } = await buildCountMap(tok, myUser);
    const repeaters = Object.values(countMap).filter(n => n >= TIER2_MIN).length;
    console.log(`  [${acc.account}] カウント窓=${scanned}投稿 / 集計投稿者=${Object.keys(countMap).length}人 / うちリピーター(${TIER2_MIN}回+)=${repeaters}人`);

    // tier別のバリエーション回し(near-dup回避)用カウンタ
    const tierSeq = { t1: 0, t2: 0, t3: 0 };

    // 返信対象=自分の直近投稿(POST_WINDOW_H時間内)
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
        if (user === myUser) continue; // 自分のコメント/返信は除外

        // ★返信直前に、このコメントへ自分が既に返信してないか実物確認
        if (await alreadyReplied(cid, myUser, tok)) continue;

        // ★リピーター段階を判定して文言バンクを選ぶ(countMapに無ければ今回の1回=t1)
        const cnt = countMap[user] || 1;
        const tier = tierOf(cnt);
        const s = tierSeq[tier]++;
        // open/mid/emoji を全要素まんべんなく回す(near-dup回避)。組み立ては buildReply に統一
        const reply = buildReply(bank, tier, s);
        seq++;

        if (DRY) {
          console.log(`  [DRY][${acc.account}] @${user}(${cnt}回=${tier}) "${text.slice(0,16)}" → 「${reply.slice(0,42)}…」`);
          posted++; accPosted++; summary[acc.account]++; tierStat[acc.account][tier]++;
          continue;
        }

        const cr = await apiCall('POST', `${API}/me/threads?media_type=TEXT&text=${encodeURIComponent(reply)}&reply_to_id=${encodeURIComponent(cid)}&access_token=${tok}`);
        if (!cr.ok || !cr.data.id) { console.log(`  [${acc.account}] 作成失敗 cid=${cid}: ${JSON.stringify(cr.data.error||cr.data).slice(0,140)}`); continue; }
        await sleep(2000); // コンテナ準備待ち
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
