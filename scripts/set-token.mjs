// クリップボードのThreadsトークンを、tokens.env の指定アカに登録する(画面にトークンは出さない)
// 実行: node --use-system-ca scripts/set-token.mjs N03_Marina
//  ① そのアカのプロキシ経由で /me を確認 → OKなら @ユーザー名 を表示して保存
//  ② クリップボードは最後に消す
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { api } from './threads-api.mjs';

const TOKENS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'tokens.env');
const name = process.argv[2];
const list = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
const acc = list.find(a => a.account === name);
if (!acc) { console.log(`アカ名が見つかりません。候補: ${list.map(a => a.account).join(' / ')}`); process.exit(1); }

// 空白・改行が混ざっていても取り除く
const token = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).replace(/\s+/g, '');
if (token.length < 100) { console.log(`クリップボードの文字が短すぎます(${token.length}字)。トークン全体をコピーし直してください。`); process.exit(1); }

const r = await api({ ...acc, access_token: token }, 'GET', '/me', { fields: 'username,name' });
if (!r.ok) { console.log(`❌ トークンが使えません: ${JSON.stringify(r.data.error?.message || r.data).slice(0, 100)}`); process.exit(1); }

acc.access_token = token;
writeFileSync(TOKENS_PATH, '[\n' + list.map(a => '  ' + JSON.stringify(a)).join(',\n') + '\n]\n');
execFileSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value " "']);
console.log(`✅ ${name} に保存しました → @${r.data.username}${r.data.name ? ` (${r.data.name})` : ''}(${token.length}字)。クリップボードは消しました。`);
