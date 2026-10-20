// Threads 長期トークン取得ツール（端末で実行）
// 使い方:  node settoken.mjs [アカウント名]
//   例)    node settoken.mjs 千鶴
//
// 流れ:
//   1) 初回だけ app_id / app_secret / redirect_uri を聞いて oauth.local.json に保存（gitignore済）
//   2) 認可URLを表示（可能なら自動で端末ブラウザを開く）
//      → そのアカでThreadsにログイン中のブラウザで開き「許可」をタップ
//      → コード表示ページ(redirect_uri)に出た code をコピー
//   3) code を貼る → 短期トークン → 長期トークン(60日) → /me で持ち主@を検証
//   4) device.json の accounts[] に {account, access_token} を追記/更新して保存
//
// ★ app_secret は oauth.local.json にのみ保存し、リポジトリには絶対コミットしない。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const G = 'https://graph.threads.com';           // Graph APIホスト（.net も可だが公式表記に合わせる）
const AUTH = 'https://threads.com/oauth/authorize';
const SCOPES = ['threads_basic','threads_content_publish','threads_manage_replies','threads_read_replies'].join(',');
const OAUTH_PATH = join(HERE, 'oauth.local.json');
const DEVICE_PATH = join(HERE, 'device.json');
const DEFAULT_REDIRECT = 'https://ryuka1246.github.io/threads-scheduler/';

const rl = readline.createInterface({ input, output });
const ask = async (q, def) => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def || '';
};

// --- 1) OAuth設定（初回のみ対話取得） ---
async function loadOauth() {
  let cfg = {};
  if (existsSync(OAUTH_PATH)) { try { cfg = JSON.parse(readFileSync(OAUTH_PATH, 'utf8')); } catch {} }
  if (!cfg.client_id || !cfg.client_secret || !cfg.redirect_uri) {
    console.log('\n--- 初回設定（この端末に1回だけ・oauth.local.jsonに保存） ---');
    cfg.client_id   = cfg.client_id   || await ask('Threads app ID', '28623411133984002');
    cfg.client_secret = cfg.client_secret || await ask('Threads app secret（貼り付け）');
    cfg.redirect_uri = cfg.redirect_uri || await ask('redirect_uri', DEFAULT_REDIRECT);
    writeFileSync(OAUTH_PATH, JSON.stringify(cfg, null, 2));
    console.log('→ oauth.local.json に保存しました\n');
  }
  return cfg;
}

// 貼られた入力から code を取り出す（コードそのもの / URL全体 どちらでもOK・末尾#_除去）
function extractCode(s) {
  s = s.trim();
  const m = s.match(/[?#&]code=([^&#\s]+)/) || s.match(/^code=([^&#\s]+)/);
  const code = m ? m[1] : s;
  return decodeURIComponent(code).replace(/#_.*$/, '').trim();
}

async function jget(url) { const r = await fetch(url); return r.json(); }

async function main() {
  const cfg = await loadOauth();
  let account = (process.argv[2] || '').trim();
  if (!account) account = await ask('このトークンはどのアカウント用？（posts.jsonのaccount名・例 千鶴）');
  if (!account) { console.error('アカウント名が必要です'); process.exit(1); }

  const authUrl = `${AUTH}?client_id=${encodeURIComponent(cfg.client_id)}`
    + `&redirect_uri=${encodeURIComponent(cfg.redirect_uri)}`
    + `&scope=${encodeURIComponent(SCOPES)}&response_type=code`;

  console.log('\n==============================================');
  console.log(`▼ 「${account}」のトークンを取得します`);
  console.log('下のURLを、そのアカでThreadsにログイン中のブラウザで開き「許可」をタップ:');
  console.log('\n' + authUrl + '\n');
  console.log('==============================================\n');
  // Termuxなら自動でブラウザを開く（無ければ無視）
  try { spawn('termux-open-url', [authUrl], { stdio: 'ignore' }).on('error', () => {}); } catch {}

  const raw = await ask('コード表示ページに出た code を貼り付け（URL全体でもOK）');
  const code = extractCode(raw);
  if (!code) { console.error('codeが読み取れませんでした'); process.exit(1); }

  // --- 3) code → 短期トークン ---
  const shortRes = await fetch(`${G}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id, client_secret: cfg.client_secret,
      code, grant_type: 'authorization_code', redirect_uri: cfg.redirect_uri,
    }),
  }).then(r => r.json());
  if (!shortRes.access_token) {
    console.error('短期トークン取得に失敗:', JSON.stringify(shortRes));
    console.error('→ codeは1時間/1回限り。認可からやり直してください。');
    process.exit(1);
  }

  // --- 短期 → 長期トークン(60日) ---
  const longRes = await jget(`${G}/access_token?grant_type=th_exchange_token`
    + `&access_token=${encodeURIComponent(shortRes.access_token)}`
    + `&client_secret=${encodeURIComponent(cfg.client_secret)}`);
  if (!longRes.access_token) { console.error('長期トークン化に失敗:', JSON.stringify(longRes)); process.exit(1); }
  const token = longRes.access_token;

  // --- /me で持ち主を検証 ---
  const me = await jget(`${G}/v1.0/me?fields=username,id&access_token=${encodeURIComponent(token)}`);
  if (!me.username) { console.error('トークン検証(/me)に失敗:', JSON.stringify(me)); process.exit(1); }
  console.log(`\n✅ トークン取得成功: @${me.username}（id=${me.id}） を「${account}」として保存します`);
  console.log(`   有効期限: 約${Math.round((longRes.expires_in || 0) / 86400)}日`);

  // --- 4) device.json に追記/更新 ---
  let dev = { device_id: '', posts_url: '', accounts: [] };
  if (existsSync(DEVICE_PATH)) { try { dev = JSON.parse(readFileSync(DEVICE_PATH, 'utf8')); } catch {} }
  if (!Array.isArray(dev.accounts)) dev.accounts = [];
  const i = dev.accounts.findIndex(a => a && a.account === account);
  if (i >= 0) { dev.accounts[i].access_token = token; console.log(`   （既存の「${account}」を更新）`); }
  else { dev.accounts.push({ account, access_token: token }); }
  writeFileSync(DEVICE_PATH, JSON.stringify(dev, null, 2));
  console.log(`→ device.json に保存完了（現在 ${dev.accounts.length} アカ）\n`);
}

main().catch(e => { console.error('エラー:', e); process.exit(1); }).finally(() => rl.close());
