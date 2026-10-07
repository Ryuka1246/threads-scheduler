// 汎用スケジュール投稿(GitHub Actions / VPS / ローカル対応)。
// POSTS_JSON(gzip+base64の環境変数) or posts/{JST日付}.json を読み、予定時刻(GRACE以内)の未投稿分を publish する。
// ★二重投稿防止は2段構え:
//   (1) 投稿済み記録 posted/{JST日付}.json(= date+account+slot のキー配列)を永続化し、記録済みの枠は二度と投げない。
//       → Metaにスパム削除されても /me/threads から消えて"未投稿"に見える問題(再投稿ループ)を根絶する。
//   (2) 保険として直近投稿の実物確認(alreadyPosted)。取得失敗時は安全側=投稿済み扱いで見送る(fail-closed)。
// 実行: node scripts/post-scheduler.mjs [--dry]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const A = 'https://graph.threads.net/v1.0';
const DRY = process.argv.includes('--dry');
const GRACE_MIN = 110;     // 予定時刻から◯分以内なら投稿。GitHub cronの間引きを吸収しつつ最短の枠間隔(90分)を割らない上限
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
const posts = Array.isArray(parsed) ? parsed : (parsed[today] || []);

// ★投稿済み記録(永続): posted/{今日}.json = ["account|slot", ...]。削除されても"投げた事実"は消えない。
const POSTED_DIR = join(ROOT, 'posted');
const postedPath = join(POSTED_DIR, `${today}.json`);
let postedArr = [];
try { if (existsSync(postedPath)) postedArr = JSON.parse(readFileSync(postedPath, 'utf8')); } catch {}
const postedSet = new Set(postedArr);
const keyOf = p => `${p.account}|${p.slot}`;
const savePosted = () => { try { mkdirSync(POSTED_DIR, { recursive: true }); writeFileSync(postedPath, JSON.stringify([...postedSet])); } catch (e) { console.log('  ⚠️ posted記録の書き込み失敗:', e.message); } };

// 予定時刻(JST)を過ぎ、かつGRACE以内の投稿を抽出
const due = [];
for (const p of posts) {
  if (p.date && p.date !== today) continue; // 日付ガード
  const [hh, mm] = String(p.time).split(':').map(Number);
  const schedUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hh - 9, mm, 0);
  const lateMin = Math.floor((now - schedUtc) / 60000);
  if (lateMin >= 0 && lateMin <= GRACE_MIN) due.push({ ...p, lateMin });
}
console.log(`[post-scheduler] JST ${jst.toISOString().slice(0,16).replace('T',' ')} / 全${posts.length}本中 期限内=${due.length}本 / 記録済み=${postedSet.size} ${DRY?'(DRY)':''}`);
if (!due.length) process.exit(0);

async function jsonFetch(url, opt) { const r = await fetch(url, opt); return r.json(); }
// 直近投稿の取得。3回試して全滅なら null(=判定不能)。
async function recentPosts(tok) {
  for (let i = 0; i < 3; i++) {
    try { const r = await jsonFetch(`${A}/me/threads?fields=id,text,timestamp&limit=25&access_token=${encodeURIComponent(tok)}`); if (r && Array.isArray(r.data)) return r.data; } catch {}
    await sleep(1500);
  }
  return null;
}
async function alreadyPosted(tok, text) {
  const data = await recentPosts(tok);
  if (data === null) return true; // 取得失敗→安全側(投稿済み扱い=この枠は見送り、次の実行で再確認)
  const key = text.slice(0, 24);
  const cutoff = Date.now() - 20 * 3600 * 1000;
  return data.some(p => (p.text || '').slice(0, 24) === key && Date.parse(p.timestamp || 0) >= cutoff);
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
  const key = keyOf(p);
  if (postedSet.has(key)) { console.log(`  ⏭️ ${p.account} ${p.slot} 記録済み(再投稿しない)`); skip++; continue; } // ★削除されても再投稿しない
  try {
    if (await alreadyPosted(tok, p.text)) { console.log(`  ⏭️ ${p.account} ${p.slot} 既投稿/判定不能スキップ`); skip++; postedSet.add(key); savePosted(); continue; }
    if (DRY) { console.log(`  [DRY] ${p.account} ${p.slot} ${p.time}(${p.lateMin}分経過)`); continue; }
    const postId = await pub(tok, p.text);
    postedSet.add(key); savePosted(); // ★投稿できたら即記録(途中でジョブが落ちても残る)
    const hasBodyPrompt = /を置い|置きな|を落と|落としな|置いて|置いておくれ|コメントして|コメントで/.test(p.text);
    if (p.cta_comment && !hasBodyPrompt) { await sleep(DELAY_MS); try { await pub(tok, p.cta_comment, postId); } catch (e) {} }
    let tinfo = '';
    if (p.tree_reply) { await sleep(DELAY_MS); try { await pub(tok, p.tree_reply, postId); tinfo = '+ツリー'; } catch (e) { tinfo = '(ツリー失敗)'; } }
    console.log(`  ✅ ${p.account} ${p.slot} → ${postId} ${tinfo}`);
    ok++;
    await sleep(4000);
  } catch (e) { console.log(`  ❌ ${p.account} ${p.slot}: ${e.message}`); ng++; }
}
savePosted();
console.log(`完了: 投稿${ok} / スキップ${skip} / 失敗${ng} / 記録済み計${postedSet.size}`);
