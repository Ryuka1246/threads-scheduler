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
  "01_千鶴": {"emoji":["🥂","🌙","✨"],"t1":{"open":["コメント、受け取ったわ。","置いていってくれたんやね、視えてるわ。","ありがとね、ちゃんと届いたわ。"],"mid":["お返しに、あなたの今の運の流れをひとつ視たげる。DMに『鑑定』とだけ送ってな、今日来た人から順にね","格を上げたいなら、まず今の自分を知ることや。DMに『鑑定』と送ってくれたら、今日のうちにそっと視るわ","お代はいらんよ。あなたの\"今\"をひとつ、DMに『鑑定』と送ってくれた人に返すわ"]},"t2":{"open":["また来てくれたんやね。あなたのこと、覚えてるわ。","よう顔を出してくれるね、うれしいわ。"],"mid":["何度も来てくれるあなたやから、ちゃんと視たげる。DMに『鑑定』とだけ送ってな","ここまでの縁やもの。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るわ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えへんわ。","あなたの名前、ちゃんと覚えたわ。いつもありがとね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りひん。DMに『鑑定』と送ってな、じっくり視たげる","あなたは特別やから。DMに『鑑定』とだけ送ってな、先にあなたの運を視るわ"]}},
  "02_小梅": {"emoji":["🍵","🌙","🌸"],"t1":{"open":["コメント、おおきに。","そっと置いてくれたんやね。","受け取ったえ。"],"mid":["お返しに、カードであなたの今をいちまい視たげる。DMに『鑑定』とだけ送ってな、今日来た人から順にね","ひとりで抱えてるん違う?DMに『鑑定』と送ってくれたら、今日のうちにそっと視るえ","お代はいらへんよ。DMに『鑑定』と送ってくれた人に、今をひとつ返すえ"]},"t2":{"open":["また来てくれはったんやね、うれしいわ。","いつも見てくれて、おおきに。"],"mid":["何度も来てくれるあなたに、カードを一枚ひくわ。DMに『鑑定』とだけ送ってな","ここまでの縁どす。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るえ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えへんえ。","あなたのこと、ちゃんと覚えてるえ。いつもおおきに。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りひん。DMに『鑑定』と送ってな、じっくり視るわ","あなたは特別やから。DMに『鑑定』とだけ送ってな、先にあなたを視るえ"]}},
  "03_あんな": {"emoji":["🐙","✨","🌙"],"t1":{"open":["コメントありがとな。","置いてくれたん、ちゃんと見たで。","受け取ったで。"],"mid":["お返しに、あなたの今の運をズバッとひとつ視たるわ。DMに『鑑定』とだけ送ってな、今日動いた人から順にやで","まだ一人で抱えとん?あなたの\"今\"を視たるから、DMに『鑑定』と送ってきいや","お代はいらんで。DMに『鑑定』と送ってくれた人から、今日のうちに視たるわ"]},"t2":{"open":["また来てくれたん、覚えてるで。","よう顔出してくれるな、うれしいわ。"],"mid":["何度も来てくれるあなたやから、ちゃんと視たるで。DMに『鑑定』とだけ送ってな","ここまでの縁やん。DMに『鑑定』と送ってくれたら、今日はあなた先に視たるわ"]},"t3":{"open":["いつも来てくれるあなた、もう他人ちゃうわ。","あなたの名前、ちゃんと覚えたで。いつもありがとな。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りひんわ。DMに『鑑定』送ってきいや、じっくり視たるで","あなたは特別やで。DMに『鑑定』とだけ送ってな、先にあなた視たるわ"]}},
  "04_なな": {"emoji":["❄️","🌙","✨"],"t1":{"open":["コメント、ありがとね。","そっと置いてくれたっしょ、届いたよ。","受け取ったっけ。"],"mid":["お返しに、星であなたの今をひとつ視てみるね。DMに『鑑定』とだけ送ってほしいっしょ、今日来た人から順にね","ひとりで抱えてない?あなたの\"今\"を視るから、DMに『鑑定』と送ってみてね","お代はいらんよ。DMに『鑑定』と送ってくれた人に、今日のうちにそっと返すべさ"]},"t2":{"open":["また来てくれたんだね、うれしいっしょ。","いつも見てくれて、ありがとね。"],"mid":["何度も来てくれるあなたに、星をひとつ視るね。DMに『鑑定』とだけ送ってね","ここまでの縁だべさ。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るよ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんわ。","あなたのこと、ちゃんと覚えたっけ。いつもありがとね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんのさ。DMに『鑑定』送ってね、じっくり視るよ","あなたは特別だべさ。DMに『鑑定』とだけ送ってね、先にあなたを視るっしょ"]}},
  "05_あかり": {"emoji":["🌙","✨","🌿"],"t1":{"open":["コメント、受け取ったよ。","置いてってくれたっちゃね、視えてる。","ありがとね、届いたっちゃ。"],"mid":["お返しに、あなたの運命数の今の流れをひとつ視るね。DMに『鑑定』とだけ送ってほしいっちゃ、今日来た人から順にね","言い訳はもういいから、まず今を知ろ。DMに『鑑定』と送ってくれたら、今日のうちに視るよ","お代はいらんっちゃ。DMに『鑑定』と送ってくれた人に、あなたの\"今\"をひとつ返すよ"]},"t2":{"open":["また来てくれたっちゃね、覚えてるよ。","いつも見てくれて、ありがとね。"],"mid":["何度も来てくれるあなたに、数の流れをひとつ視るね。DMに『鑑定』とだけ送ってね","ここまでの縁だべ。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るよ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんっちゃ。","あなたのこと、ちゃんと覚えた。いつもありがとね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんよ。DMに『鑑定』送ってね、じっくり視るっちゃ","あなたは特別だべ。DMに『鑑定』とだけ送ってね、先にあなたの数を視るよ"]}},
  "06_ゆりあ": {"emoji":["💛","🌙","✨"],"t1":{"open":["コメントありがとね。","よう置いてってくれたがや。","受け取ったで。"],"mid":["お返しに、あなたの今の気の流れをひとつズバッと視たるわ。DMに『鑑定』とだけ送ってちょ、今日動いた人から順にだで","ひとりで抱えとらんで、DMに『鑑定』と送ってみ。今日のうちにあなたの\"今\"を視たるで","お代はいらんがや。DMに『鑑定』と送ってくれた人から、今日のうちに視たるわ"]},"t2":{"open":["また来てくれたがね、覚えとるで。","よう顔出してくれるなも、うれしいわ。"],"mid":["何度も来てくれるあなたに、気の流れを視たるで。DMに『鑑定』とだけ送ってちょ","ここまでの縁だがや。DMに『鑑定』と送ってくれたら、今日はあなた先に視たるわ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんがや。","あなたの名前、ちゃんと覚えたで。いつもありがとね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんわ。DMに『鑑定』送ってちょ、じっくり視たるで","あなたは特別だがや。DMに『鑑定』とだけ送ってちょ、先にあなたの運を視たるわ"]}},
  "07_みお": {"emoji":["🍁","🌙","✨"],"t1":{"open":["コメント、受け取ったよ。","そっと置いてくれたんじゃね、視えとる。","ありがとね、届いとるよ。"],"mid":["お返しに、カードであなたの今をひとつ視ちゃるよ。DMに『鑑定』とだけ送りんさい、今日来た人から順にね","一人で抱えんさんな。DMに『鑑定』と送ってくれたら、今日のうちにあなたの\"今\"を視るけぇ","お代はいらんよ。DMに『鑑定』と送ってくれた人に、ひとつ返すけぇね"]},"t2":{"open":["また来てくれたんじゃね、覚えとるよ。","いつも見てくれて、ありがとね。"],"mid":["何度も来てくれるあなたに、カードを一枚ひくよ。DMに『鑑定』とだけ送りんさい","ここまでの縁じゃけぇ。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るけぇ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんのよ。","あなたのこと、ちゃんと覚えたよ。いつもありがとね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんのよ。DMに『鑑定』送りんさい、じっくり視るけぇ","あなたは特別じゃけぇ。DMに『鑑定』とだけ送りんさい、先にあなたを視るよ"]}},
  "08_レナ": {"emoji":["🔥","🌙","✨"],"t1":{"open":["コメントありがとうっちゃ。","よう置いてくれたね。","受け取ったばい。"],"mid":["お返しに、あなたの命式の今をひとつ視ちゃるき。DMに『鑑定』とだけ送って、今日動いた人から順にっちゃ","まだ一人で抱えよると?DMに『鑑定』と送ってくれたら、今日のうちにあなたの\"今\"を視るき","お代はいらんっちゃ。DMに『鑑定』と送ってくれた人から、今日のうちに視るばい"]},"t2":{"open":["また来てくれたっちゃね、覚えとるよ。","よう顔出してくれるき、うれしいばい。"],"mid":["何度も来てくれるあなたに、命式をひとつ視るき。DMに『鑑定』とだけ送って","ここまでの縁ばい。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るっちゃ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんき。","あなたの名前、ちゃんと覚えたばい。いつもありがとうっちゃ。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんき。DMに『鑑定』送って、じっくり視ちゃるばい","あなたは特別っちゃ。DMに『鑑定』とだけ送って、先にあなたの命式を視るき"]}},
  "09_さくら": {"emoji":["🌸","🌙","✨"],"t1":{"open":["コメントありがとね。","そっと置いてくれたとね、届いとるよ。","受け取ったばい。"],"mid":["お返しに、カードであなたの今をひとつ視るけん。DMに『鑑定』とだけ送ってね、今日来た人から順にとよ","ひとりで抱えんでよか。DMに『鑑定』と送ってくれたら、今日のうちにあなたの\"今\"を視るけん","お代はいらんとよ。DMに『鑑定』と送ってくれた人に、ひとつ返すばい"]},"t2":{"open":["また来てくれたとね、うれしか。","いつも見てくれて、ありがとね。"],"mid":["何度も来てくれるあなたに、カードを一枚ひくけん。DMに『鑑定』とだけ送ってね","ここまでの縁たい。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るけん"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんとよ。","あなたのこと、ちゃんと覚えたばい。いつもありがとね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんとよ。DMに『鑑定』送ってね、じっくり視るけん","あなたは特別たい。DMに『鑑定』とだけ送ってね、先にあなたを視るけん"]}},
  "10_まりな": {"emoji":["🌋","🌙","✨"],"t1":{"open":["コメント、受け取ったとよ。","そっと置いてくれたとね、視えちょる。","ありがとね、届いちょるよ。"],"mid":["お返しに、視えたことをひとつそのまま返すとよ。DMに『鑑定』とだけ送って、今日来た人から順にね","ひとりで抱え込まんでよか。DMに『鑑定』と送ってくれたら、今日のうちにあなたの\"今\"を視るけん","お代はいらんとよ。DMに『鑑定』と送ってくれた人に、ひとつ視ちゃるけん"]},"t2":{"open":["また来てくれたとね、覚えちょるよ。","いつも見てくれて、ありがとね。"],"mid":["何度も来てくれるあなたに、視えたことをひとつ返すとよ。DMに『鑑定』とだけ送って","ここまでの縁やけん。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るとよ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんとよ。","あなたの名前、ちゃんと覚えたけん。いつもありがとね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんとよ。DMに『鑑定』送って、じっくり視るけん","あなたは特別やけん。DMに『鑑定』とだけ送って、先にあなたを視ちゃるとよ"]}},
  "11_りな": {"emoji":["🌺","🌙","✨"],"t1":{"open":["コメントありがとぉ〜。","そっと置いてくれたさー、届いてるよ〜。","受け取ったはず。"],"mid":["お返しに、霊感であなたの今をひとつ視るさー。DMに『鑑定』とだけ送ってね〜、今日来た人から順によ〜","ひとりで抱えんでいいはず。DMに『鑑定』と送ってくれたら、今日のうちにあなたの\"今\"を視るさー","お代はいらんよ〜。DMに『鑑定』と送ってくれた人に、ひとつ返すさー"]},"t2":{"open":["また来てくれたさー、うれしいよ〜。","いつも見てくれて、ありがとぉ〜。"],"mid":["何度も来てくれるあなたに、ひとつ視るさー。DMに『鑑定』とだけ送ってね〜","ここまでの縁はず。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るさー"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えんさー。","あなたのこと、ちゃんと覚えたよ〜。いつもありがとぉ〜。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りんさー。DMに『鑑定』送ってね〜、じっくり視るよ〜","あなたは特別さー。DMに『鑑定』とだけ送ってね〜、先にあなたを視るはず"]}},
  "12_ゆき": {"emoji":["🍶","🌙","✨"],"t1":{"open":["コメント、受け取ったよ。","そっと置いてくれたんさ、届いてるよ。","ありがとう、ちゃんと視たよ。"],"mid":["お返しに、カードであなたの今をひとつ視るね。DMに『鑑定』とだけ送って、今日来た人から順にね","気休めは言わないすけ、事実だけ返すよ。DMに『鑑定』と送ってくれたら、今日のうちに視るね","お代はいらないよ。DMに『鑑定』と送ってくれた人に、あなたの\"今\"をひとつ返すすけ"]},"t2":{"open":["また来てくれたんさ、覚えてるよ。","いつも見てくれて、ありがとうね。"],"mid":["何度も来てくれるあなたに、カードを一枚ひくね。DMに『鑑定』とだけ送って","ここまでの縁でしょ。DMに『鑑定』と送ってくれたら、今日はあなたを先に視るよ"]},"t3":{"open":["いつも来てくれるあなた、もう他人とは思えないよ。","あなたのこと、ちゃんと覚えたすけ。いつもありがとうね。"],"mid":["ここまで通ってくれたあなたには、コメントじゃ足りないよ。DMに『鑑定』送って、じっくり視るね","あなたは特別すけ。DMに『鑑定』とだけ送って、先にあなたを視るよ"]}},
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
