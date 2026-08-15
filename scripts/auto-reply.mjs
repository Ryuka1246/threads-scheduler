// Threads コメント自動返信ボット(単独スクリプト版 / n8n非依存 / 状態レス)
// 実行: node scripts/auto-reply.mjs         (本番=実際に返信)
//       node scripts/auto-reply.mjs --dry    (取得と返信文の組み立てだけ・投稿しない)
//       node scripts/auto-reply.mjs --cap 30 (この実行の返信総数上限を30に)
// 重複防止: 保存ファイルは使わず、返信直前に「そのコメントに自分が既に返信してないか」をThreads APIで確認(競合しても二重返信しない)
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
const PER_ACCOUNT_CAP = 15; // 1アカ1回15件まで(返信総数の上限ではなく"連投レート"の凍結ガード)。全コメントは数サイクルで返信される
const POST_WINDOW_H = 40;   // 直近◯時間の自分の投稿のコメントだけ対象
const DELAY_MS = 3000;      // 返信ごとの間隔(スパム判定回避=これが本当のブレーキ)
const TIMEOUT_MS = 12000;

// ---- 返信テンプレは REPLY_PARTS(環境変数) or scripts/reply_parts.json(ローカル・gitignore) から読む ----
const PARTS = JSON.parse(process.env.REPLY_PARTS || readFileSync(join(HERE, 'reply_parts.json'), 'utf8'));
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

async function main() {
  const tokens = loadTokens();
  const now = Date.now();
  let seq = 0, posted = 0;
  const summary = {};
  console.log(`[auto-reply] 開始 ${DRY ? '(DRYモード:投稿しない)' : '(本番)'} / RUN_CAP=${RUN_CAP} / PER_ACCOUNT_CAP=${PER_ACCOUNT_CAP} / 対象=${tokens.length}アカ`);

  for (const acc of tokens) {
    if (posted >= RUN_CAP) break;
    const parts = PARTS[acc.account];
    if (!parts) continue; // 04凪等はテンプレなし=スキップ
    const tok = encodeURIComponent(acc.access_token);
    summary[acc.account] = 0;
    let accPosted = 0;

    // 自分の@username(自分のコメント/既返信の判定に使う)
    const meRes = await apiCall('GET', `${API}/me?fields=username&access_token=${tok}`);
    const myUser = meRes.ok ? meRes.data.username : null;
    if (!myUser) { console.log(`  [${acc.account}] アカ情報取得エラー(トークン失効?): ${JSON.stringify(meRes.data.error||meRes.data).slice(0,140)}`); continue; }

    // 自分の直近投稿
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

        // open/mid/emoji を全要素まんべんなく回す(midは4パターン=near-dup回避のため乗数は各長と互いに素に)
        const reply = parts.open[seq % parts.open.length] + parts.mid[(seq*3) % parts.mid.length] + parts.emoji[(seq*2+1) % parts.emoji.length];
        seq++;

        if (DRY) {
          console.log(`  [DRY][${acc.account}] @${user} "${text.slice(0,20)}" → 「${reply}」`);
          posted++; accPosted++; summary[acc.account]++;
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
        posted++; accPosted++; summary[acc.account]++;
        await sleep(DELAY_MS);
      }
    }
  }
  console.log(`[auto-reply] 完了 / 今回返信=${posted}件 / アカ別=${JSON.stringify(summary)}`);
}

main().catch(e => { console.error('[auto-reply] 致命的エラー:', e); process.exit(1); });
