// 汎用スケジュール投稿(GitHub Actions / VPS / ローカル対応)。
// POSTS_JSON(gzip+base64の環境変数) or posts/{JST日付}.json を読み、予定時刻(GRACE=90分以内)の未投稿分を
// 本文 → コメント誘導 → ツリー(2投稿目)まで publish する。重複防止はステートレス(直近投稿の実物確認)。
// 実行: node scripts/post-scheduler.mjs [--dry]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const A = 'https://graph.threads.net/v1.0';
const DRY = process.argv.includes('--dry');
const GRACE_MIN = 110;     // 予定時刻から◯分以内なら投稿。GitHub cronの間引き(実測で最大~80分空く)を吸収しつつ、最短の枠間隔(夜1 20:00→夜2 22:00=120分)を割らない上限に設定
const DELAY_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const toks = JSON.parse(process.env.THREADS_TOKENS || readFileSync(join(HERE, 'tokens.env'), 'utf8'));
const tokByAcc = Object.fromEntries(toks.map(t => [t.account, t.access_token]));

const now = Date.now();
const jst = new Date(now + 9 * 3600 * 1000);
const today = jst.toISOString().slice(0, 10);

// 投稿データ: 環境変数 POSTS_JSON(gzip+base64) 優先、無ければローカル posts/{日付}.json
let postsRaw;
if (process.env.POSTS_JSON) {
  postsRaw = zlib.gunzipSync(Buffer.from(process.env.POSTS_JSON, 'base64')).toString('utf8');
} else {
  const postsPath = join(ROOT, 'posts', `${today}.json`);
  if (!existsSync(postsPath)) { console.log(`[post-scheduler] POSTS_JSON も posts/${today}.json も無い → 何もしない`); process.exit(0); }
  postsRaw = readFileSync(postsPath, 'utf8');
}
const parsed = JSON.parse(postsRaw);
// POSTS_JSON は「配列(単日・後方互換)」または「{ 'YYYY-MM-DD': [...] }(複数日)」を許容。複数日なら今日(JST)分を選ぶ
const posts = Array.isArray(parsed) ? parsed : (parsed[today] || []);

// 予定時刻(JST)を過ぎ、かつGRACE以内の投稿を抽出
const due = [];
for (const p of posts) {
  if (p.date && p.date !== today) continue; // 日付ガード: 今日(JST)分だけ投稿。前日夜にPOSTS_JSONを翌日分へ更新しても早出ししない
  const [hh, mm] = String(p.time).split(':').map(Number);
  const schedUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hh - 9, mm, 0);
  const lateMin = Math.floor((now - schedUtc) / 60000);
  if (lateMin >= 0 && lateMin <= GRACE_MIN) due.push({ ...p, lateMin });
}
console.log(`[post-scheduler] JST ${jst.toISOString().slice(0,16).replace('T',' ')} / 全${posts.length}本中 期限内=${due.length}本 ${DRY?'(DRY)':''}`);
if (!due.length) process.exit(0);

async function jsonFetch(url, opt) { const r = await fetch(url, opt); return r.json(); }
async function alreadyPosted(tok, text) {
  const r = await jsonFetch(`${A}/me/threads?fields=id,text,timestamp&limit=25&access_token=${encodeURIComponent(tok)}`);
  const key = text.slice(0, 24);
  const cutoff = Date.now() - 20 * 3600 * 1000; // 20時間以内の投稿だけを重複判定に使う(前日の同一フックへの誤マッチ防止)
  return (r.data || []).some(p => (p.text || '').slice(0, 24) === key && Date.parse(p.timestamp || 0) >= cutoff);
}
async function pub(tok, text, replyTo) {
  const body = { media_type: 'TEXT', text };
  if (replyTo) body.reply_to_id = replyTo;
  let j = await jsonFetch(`${A}/me/threads`, { method:'POST', headers:{ 'Authorization':`Bearer ${tok}`, 'Content-Type':'application/json' }, body: JSON.stringify(body) });
  if (!j.id) throw new Error('container失敗: ' + JSON.stringify(j).slice(0,160));
  const cid = j.id;
  await sleep(DELAY_MS);
  j = await jsonFetch(`${A}/me/threads_publish?creation_id=${cid}`, { method:'POST', headers:{ 'Authorization':`Bearer ${tok}` } });
  if (!j.id) throw new Error('publish失敗: ' + JSON.stringify(j).slice(0,160));
  return j.id;
}

let ok = 0, skip = 0, ng = 0;
for (const p of due) {
  const tok = tokByAcc[p.account];
  if (!tok) { console.log(`  ⚠️ ${p.account} token無し`); continue; }
  try {
    if (await alreadyPosted(tok, p.text)) { console.log(`  ⏭️ ${p.account} ${p.slot} 既投稿スキップ`); skip++; continue; }
    if (DRY) { console.log(`  [DRY] ${p.account} ${p.slot} ${p.time}(${p.lateMin}分経過) ${p.cta_comment?'+コメ':''} ${p.tree_reply?'+ツリー':''}`); continue; }
    const postId = await pub(tok, p.text);
    // コメント誘導: 本文に埋込プロンプト(を置い等)が無い投稿だけ、自分の最初のコメントとして投稿(二重投稿回避)
    const hasBodyPrompt = /を置い|置きな|を落と|落としな|置いて|置いておくれ|コメントして|コメントで/.test(p.text);
    if (p.cta_comment && !hasBodyPrompt) { await sleep(DELAY_MS); try { await pub(tok, p.cta_comment, postId); } catch (e) {} }
    // ツリー(2投稿目): tree_reply があるものだけ(誘導を持たないアカは data 側で null)
    let tinfo = '';
    if (p.tree_reply) { await sleep(DELAY_MS); try { await pub(tok, p.tree_reply, postId); tinfo = '+ツリー'; } catch (e) { tinfo = '(ツリー失敗)'; } }
    console.log(`  ✅ ${p.account} ${p.slot} → ${postId} ${tinfo}`);
    ok++;
    await sleep(4000);
  } catch (e) { console.log(`  ❌ ${p.account} ${p.slot}: ${e.message}`); ng++; }
}
console.log(`完了: 投稿${ok} / スキップ${skip} / 失敗${ng}`);
