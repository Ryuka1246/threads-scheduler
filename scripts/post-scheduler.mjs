// 汎用スケジュール投稿(GitHub Actions / VPS / ローカル対応)。
// POSTS_JSON(gzip+base64の環境変数) or posts/{JST日付}.json を読み、予定時刻(GRACE以内)の未投稿分を publish する。
// ★画像対応(2026-11-16): 投稿データの images(公開URL配列) が 0枚=文字 / 1枚=画像 / 2枚以上=カルーセル。
// ★アカ別プロキシ(2026-11-16): THREADS_TOKENS の各アカに proxy があれば、そのアカの通信は全部そのプロキシ経由(threads-api.mjs)。
// ★二重投稿防止は2段構え:
//   (1) 投稿済み記録 posted/{JST日付}.json(= date+account+slot のキー配列)を永続化し、記録済みの枠は二度と投げない。
//       → Metaにスパム削除されても /me/threads から消えて"未投稿"に見える問題(再投稿ループ)を根絶する。
//   (2) 保険として直近投稿の実物確認(alreadyPosted)。取得失敗時は安全側=投稿済み扱いで見送る(fail-closed)。
// 実行: node scripts/post-scheduler.mjs [--dry] [--no-jitter]
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import zlib from 'node:zlib';
import { loadAccounts, publishPost, publishText, recentPosts, sleep } from './threads-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DRY = process.argv.includes('--dry');
const NO_JITTER = process.argv.includes('--no-jitter');
const GRACE_MIN = 110;     // 予定時刻から◯分以内なら投稿。GitHub cronの間引きを吸収しつつ最短の枠間隔(90分)を割らない上限
const DELAY_MS = 3000;
const MAX_PER_ACCOUNT = 1;          // 1回の実行で1アカ1本まで(取りこぼしの一括投稿=バーストを防ぐ。残りは次の実行で)
const PRE_POST_JITTER_MS = 90 * 1000; // 投稿直前に0〜90秒ランダムに待つ(アカ同士の投稿時刻が秒単位で揃わないように)
const BETWEEN_POSTS_MS = 4000;

const accByName = Object.fromEntries(loadAccounts(HERE).map(a => [a.account, a]));

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
due.sort((a, b) => String(a.time).localeCompare(String(b.time)));
console.log(`[post-scheduler] JST ${jst.toISOString().slice(0,16).replace('T',' ')} / 全${posts.length}本中 期限内=${due.length}本 / 記録済み=${postedSet.size} ${DRY?'(DRY)':''}`);
if (!due.length) process.exit(0);

async function alreadyPosted(acc, text) {
  const data = await recentPosts(acc);
  if (data === null) return null; // 取得失敗→判定不能(呼び出し側で見送り、記録はしない)
  const key = text.slice(0, 24);
  const cutoff = Date.now() - 20 * 3600 * 1000;
  return data.some(p => (p.text || '').slice(0, 24) === key && Date.parse(p.timestamp || 0) >= cutoff);
}

let ok = 0, skip = 0, ng = 0;
const doneThisRun = {}; // アカ別: この実行で投稿した本数
for (const p of due) {
  const acc = accByName[p.account];
  if (!acc) { console.log(`  ⚠️ ${p.account} token無し`); continue; }
  const key = keyOf(p);
  if (postedSet.has(key)) { console.log(`  ⏭️ ${p.account} ${p.slot} 記録済み(再投稿しない)`); skip++; continue; } // ★削除されても再投稿しない
  try {
    if ((doneThisRun[p.account] || 0) >= MAX_PER_ACCOUNT) { console.log(`  ⏸️ ${p.account} ${p.slot} 次の実行へ回す(1回1本まで)`); continue; }
    const dup = await alreadyPosted(acc, p.text);
    // 取得失敗(判定不能)は記録せず見送るだけ→次の実行で確かめ直す
    if (dup === null) { console.log(`  ⏸️ ${p.account} ${p.slot} 判定不能→次の実行で再確認`); skip++; continue; }
    if (dup) { console.log(`  ⏭️ ${p.account} ${p.slot} 既投稿スキップ`); skip++; postedSet.add(key); savePosted(); continue; }
    const imgs = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
    const kind = imgs.length === 0 ? '文字' : imgs.length === 1 ? '画像1枚' : `カルーセル${imgs.length}枚`;
    if (DRY) { console.log(`  [DRY] ${p.account} ${p.slot} ${p.time}(${p.lateMin}分経過) ${kind}`); continue; }
    if (!NO_JITTER) { const w = Math.floor(Math.random() * PRE_POST_JITTER_MS); if (w) await sleep(w); }
    const postId = await publishPost(acc, { text: p.text, images: imgs });
    doneThisRun[p.account] = (doneThisRun[p.account] || 0) + 1;
    postedSet.add(key); savePosted(); // ★投稿できたら即記録(途中でジョブが落ちても残る)
    const hasBodyPrompt = /を置い|置きな|を落と|落としな|置いて|置いておくれ|コメントして|コメントで/.test(p.text);
    if (p.cta_comment && !hasBodyPrompt) { await sleep(DELAY_MS); try { await publishText(acc, p.cta_comment, postId); } catch (e) {} }
    let tinfo = '';
    if (p.tree_reply) { await sleep(DELAY_MS); try { await publishText(acc, p.tree_reply, postId); tinfo = '+ツリー'; } catch (e) { tinfo = '(ツリー失敗)'; } }
    console.log(`  ✅ ${p.account} ${p.slot} ${kind} → ${postId} ${tinfo}`);
    ok++;
    await sleep(BETWEEN_POSTS_MS);
  } catch (e) { console.log(`  ❌ ${p.account} ${p.slot}: ${e.message}`); ng++; }
}
savePosted();
console.log(`完了: 投稿${ok} / スキップ${skip} / 失敗${ng} / 記録済み計${postedSet.size}`);
