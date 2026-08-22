// Threads 長期トークンの自動更新。THREADS_TOKENS(JSON配列)を読み、各トークンを
// refresh_access_token で更新(有効期限を60日リセット)して、更新後の配列を標準出力に出す。
// ワークフロー側で `> refreshed.json` に受けて gh secret set THREADS_TOKENS に流す。
//
// 重要仕様: refresh_access_token は「発行から24時間以上・かつ未失効」のトークンにしか効かない。
//  - まだ24時間経っていない/既に失効しているトークンはエラーになるので、その場合は既存トークンを維持する
//    (毎週実行しておけば、常に有効期限が50日以上残る状態を保てる)。
// ログは stderr、トークンJSONは stdout（> でファイルに受けても JSON だけになるように分離）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const A = 'https://graph.threads.net';
const HERE = dirname(fileURLToPath(import.meta.url));
const raw = process.env.THREADS_TOKENS || readFileSync(join(HERE, 'tokens.env'), 'utf8');
const toks = JSON.parse(raw);

const out = [];
let refreshed = 0, kept = 0;
for (const t of toks) {
  if (!t || !t.access_token) { out.push(t); kept++; continue; }
  try {
    const r = await fetch(`${A}/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(t.access_token)}`)
      .then(x => x.json());
    if (r && r.access_token) {
      out.push({ ...t, access_token: r.access_token });
      refreshed++;
      process.stderr.write(`✅ refreshed ${t.account} (expires_in=${r.expires_in})\n`);
    } else {
      out.push(t); // 更新できない時は既存を維持(24h未満/失効直後など)
      kept++;
      process.stderr.write(`➖ kept ${t.account}: ${JSON.stringify(r).slice(0, 140)}\n`);
    }
  } catch (e) {
    out.push(t);
    kept++;
    process.stderr.write(`➖ kept ${t.account} (error: ${String(e).slice(0, 100)})\n`);
  }
}
process.stderr.write(`[refresh-tokens] 更新${refreshed} / 維持${kept} / 計${toks.length}\n`);
process.stdout.write(JSON.stringify(out, null, 2));
