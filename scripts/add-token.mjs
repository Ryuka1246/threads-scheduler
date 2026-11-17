// トークンを tokens.env に追加する(標準入力から1個以上・空白/改行区切り)。トークンは画面に出さない。
// 実行: echo <トークン> | node --use-system-ca scripts/add-token.mjs
//  - 既に登録済みのトークン → そのまま(IPも変えない)
//  - 新しいトークン → 空いているIP(ポート)の枠に入れ、そのIP経由で /me を確認してアカ名を付ける
//    (アカを確かめるための通信も、最初から割り当てたIPだけで行う)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { api } from './threads-api.mjs';

const TOKENS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'tokens.env');
const ALL_PORTS = [10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008, 10009, 10010];
const input = readFileSync(0, 'utf8').split(/\s+/).filter(t => t.length >= 100);
const list = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
const save = () => writeFileSync(TOKENS_PATH, '[\n' + list.map(a => '  ' + JSON.stringify(a)).join(',\n') + '\n]\n');

for (const token of input) {
  if (list.some(a => a.access_token === token)) { console.log(`・登録済み → ${list.find(a => a.access_token === token).account}`); continue; }
  // 空き枠(トークン未記入)を先頭から使う。無ければ未使用ポートで新しい枠を作る
  let slot = list.find(a => !a.access_token);
  if (!slot) {
    const used = new Set(list.map(a => a.proxy_port));
    const port = ALL_PORTS.find(p => !used.has(p));
    if (!port) { console.log('❌ 空いているIPがありません'); break; }
    slot = { account: `未定${port}`, proxy_port: port, access_token: '' };
    list.push(slot);
  }
  const r = await api({ ...slot, access_token: token }, 'GET', '/me', { fields: 'username,name' });
  if (!r.ok) { console.log(`❌ 使えないトークン(${token.length}字): ${JSON.stringify(r.data.error?.message || r.data).slice(0, 90)}`); continue; }
  slot.access_token = token;
  slot.account = r.data.username;
  slot.name = r.data.name || '';
  save();
  console.log(`✅ port=${slot.proxy_port} → @${r.data.username} (${r.data.name || ''})`);
}
