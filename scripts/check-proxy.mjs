// プロキシとトークンの接続確認(読み取りだけ・投稿はしない)
// 実行: node scripts/check-proxy.mjs
//  各アカについて ①プロキシ経由の「外から見えるIP」 ②トークンがあれば @ユーザー名 を表示する。
//  IPがアカごとに違い、Decodo の My IP list のIPと一致していればOK。
import { fetch } from 'undici';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { dispatcherFor, api } from './threads-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// トークン未記入のアカも確認したいので、ここでは access_token が空でも読む
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const raw = process.env.THREADS_TOKENS || readFileSync(join(HERE, 'tokens.env'), 'utf8');
const accounts = JSON.parse(raw).filter(a => a && a.account);

const seen = new Map();
for (const acc of accounts) {
  let ip = '(取得失敗)';
  try {
    const r = await fetch('https://api.ipify.org?format=json', { dispatcher: dispatcherFor(acc), signal: AbortSignal.timeout(15000) });
    ip = (await r.json()).ip;
  } catch (e) { ip = `(取得失敗: ${String(e.cause?.code || e.message).slice(0, 60)})`; }
  let who = '(トークン未記入)';
  if (acc.access_token) {
    const r = await api(acc, 'GET', '/me', { fields: 'username,name' });
    who = r.ok ? '@' + r.data.username + (r.data.name ? ` (${r.data.name})` : '') : `(トークンNG: ${JSON.stringify(r.data.error?.message || r.data).slice(0, 80)})`;
  }
  const dup = seen.has(ip) && !ip.startsWith('(') ? ` ⚠️ ${seen.get(ip)} と同じIP` : '';
  if (!ip.startsWith('(')) seen.set(ip, acc.account);
  console.log(`${acc.account.padEnd(12)} port=${acc.proxy_port ?? '-'}  IP=${ip}  ${who}${dup}`);
}
