// Threads 端末ローカル投稿スクリプト（1端末 = 複数アカ対応 / 推奨: 1端末=2アカ）
// 構成: 12端末 × 2アカ = 24アカ（本家N + 2アカ目N を同じ端末に）。
//
// 目的: GitHub Actions（共有データセンターIP・全アカ同時発火）をやめ、
//       各端末の自前のモバイルIPから、その端末に割り当てたアカウントだけを投稿する。
//       → リーチ抑制（IP指紋 / 同時発火指紋）への構造対策。
//       12端末に分けると投稿IPが12個に分散し、各IPは2アカだけ＝自然な見え方になる。
//
// ★超重要: 端末は「モバイルデータ（4G/5G）」で動かすこと。
//           自宅wifiだと全端末が同じ自宅IPになり分散にならない（＝意味がない）。
//
// セットアップ（Android / Termux）:
//   1) Termux を F-Droid から導入
//   2) pkg update && pkg install nodejs git
//   3) git clone <このリポジトリ> && cd threads-scheduler/scripts
//   4) cp device.example.json device.json   # その端末の2アカ分の account と access_token を記入
//   5) termux-wake-lock                      # スリープで止まらないように（termux-api 導入時）
//   6) node device-poster.mjs                # 常駐ループ開始（Ctrl+Cで停止）
//   ※自動起動は Termux:Boot アドオンで ~/.termux/boot/ に起動スクリプトを置く
//   ※端末ごとに手順4のdevice.jsonの中身（担当2アカ）を変える。他は全端末共通。
//
// device.json 形式（複数アカ）:
//   {
//     "device_id": "D01",
//     "posts_url": "https://raw.githubusercontent.com/<user>/<repo>/main/posts/{date}.json",
//     "accounts": [
//       { "account": "千鶴",   "access_token": "THxxxx..." },
//       { "account": "ちづる", "access_token": "THyyyy..." }
//     ]
//   }
//   - accounts に、その端末が担当するアカ（通常2つ）を並べる。account名は posts.json の account と完全一致（日本語名）。
//   - posts_url を入れると、毎日その日のURLから全アカ分を1回取得し、各アカ分だけに振り分けてキャッシュ。
//     posts_url が無ければ scripts/posts/{日付}.json をローカルから読む。
//   - 旧形式（単一 account / access_token）も後方互換で動く。
//
// 実行フラグ: --dry（投稿せず判定だけ） / --once（1サイクルだけ実行して終了。cron運用向け）

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const A = 'https://graph.threads.net/v1.0';
const DRY = process.argv.includes('--dry');
const ONCE = process.argv.includes('--once');
const GRACE_MIN = 110;                 // 予定時刻から◯分以内なら投稿（取りこぼし吸収・最短枠間隔を割らない）
const CHECK_EVERY_MS = 5 * 60 * 1000;  // 常駐ループの点検間隔（5分）
const DELAY_MS = 3000;                 // container作成→publish の間
const BETWEEN_ACCOUNTS_MS = 4000;      // 端末内でアカを順番に処理する際の小休止（同時発火の足跡を避ける）
const MAX_PER_CYCLE = 1;               // 1アカにつき1サイクル1本だけ投稿（取りこぼしの一括投稿＝同時発火バーストを防ぐ・残りは次サイクルへ）
const PRE_POST_JITTER_MS = 180 * 1000; // 投稿直前に 0〜この範囲でランダム待機（全端末が同じ頃に再起動しても発火時刻をばらす＝同期バースト防止）
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- device.json 読み込み ---
// device.json は次のどちらでもよい:
//   (A) 遠隔設定方式【推奨・スマホ操作ゼロ】: { "device_id":"D01", "config_url":"https://.../raw/devices.json" }
//       → config_url から毎サイクル「担当アカ(account+access_token)と posts_url」を取得する。
//         アカ追加・トークン更新は config_url 先(秘密gist)を書き換えるだけで反映され、スマホは一切触らない。
//   (B) ローカル直書き方式【後方互換】: { "device_id":"D01", "posts_url":"...", "accounts":[{account,access_token},...] }
const cfg = JSON.parse(readFileSync(join(HERE, 'device.json'), 'utf8'));
const DEVICE_ID = cfg.device_id || '(no-id)';

const jstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const todayStr = () => jstNow().toISOString().slice(0, 10);

const DATA_DIR = join(HERE, 'device-data');
mkdirSync(DATA_DIR, { recursive: true });
// ファイル名に使えるようアカ名を無害化（日本語はそのまま、記号だけ除去）
const safe = s => String(s).replace(/[\\/:*?"<>|]/g, '_');

async function jsonFetch(url, opt) { const r = await fetch(url, opt); return r.json(); }

// この端末の「担当アカ＋posts_url」を解決する。
// config_url があれば毎サイクル取得（= アカ追加/トークン更新を遠隔反映）。失敗時は前回成功値→ローカルの順でフォールバック。
let _liveCfg = null;  // 直近で取得できた { accounts, posts_url }
async function resolveConfig() {
  if (cfg.config_url) {
    try {
      const r = await fetch(cfg.config_url);
      if (r.ok) {
        const c = await r.json();
        // 対応2形式: ①全端末1ファイル { devices:{ D01:{accounts,posts_url}, ... } }  ②端末ごと1ファイル { accounts, posts_url }
        const node = (c && c.devices && typeof c.devices === 'object') ? (c.devices[DEVICE_ID] || {}) : (c || {});
        const accounts = (Array.isArray(node.accounts) ? node.accounts : []).filter(a => a && a.account && a.access_token);
        const posts_url = node.posts_url || (c && c.posts_url) || cfg.posts_url || null;
        if (accounts.length) _liveCfg = { accounts, posts_url };
        else console.log('config_url: この端末のaccountsが空');
      } else console.log(`config_url ${r.status}`);
    } catch (e) { console.log('config_url取得失敗:', e.message); }
  }
  if (!_liveCfg) {
    // config_url 未設定 or 取得全滅時: ローカル device.json の直書きを使う（前回成功値があればそれを保持）
    let local = [];
    if (Array.isArray(cfg.accounts) && cfg.accounts.length) local = cfg.accounts;
    else if (cfg.account && cfg.access_token) local = [{ account: cfg.account, access_token: cfg.access_token }];  // 旧単一形式
    local = local.filter(a => a && a.account && a.access_token);
    if (local.length) _liveCfg = { accounts: local, posts_url: cfg.posts_url || null };
  }
  return _liveCfg || { accounts: [], posts_url: cfg.posts_url || null };
}

// その日の全アカJSONを「毎サイクル」取得する（後から追加した枠も最大5分で自動反映）。
// ★以前は当日分を一度だけキャッシュして使い回していたため、昼に取得後にgistへ追加した
//   夕方以降の枠が端末に届かず投稿されなかった。その不具合を防ぐため固定キャッシュを廃止。
// 取得に失敗したときだけ、ローカルファイル→前回取得できた内容 の順でフォールバックする。
let _lastGood = { date: null, all: null };
async function loadDayAll(date, postsUrl) {
  let all = null;
  if (postsUrl) {
    const url = postsUrl.replace('{date}', date);
    try { const r = await fetch(url); if (r.ok) all = await r.json(); else console.log(`posts_url ${r.status}`); }
    catch (e) { console.log('posts_url取得失敗:', e.message); }
  }
  if (!all) {
    const p = join(HERE, 'posts', `${date}.json`);
    if (existsSync(p)) { try { all = JSON.parse(readFileSync(p, 'utf8')); } catch {} }
  }
  if (!all && _lastGood.date === date) all = _lastGood.all;  // 取得全滅時は前回取れた内容で代替
  if (all) _lastGood = { date, all };
  return all;
}

// 指定アカ分の投稿を用意（毎サイクル当日全アカJSONを取得→アカでフィルタ）。
// ★投稿一覧はキャッシュしない＝gistに枠を足せば次サイクルで即反映。二重投稿は posted_*.json で防ぐ。
async function loadPosts(date, accountName, postsUrl) {
  const all = await loadDayAll(date, postsUrl);
  if (!all) return null;
  const arr = Array.isArray(all) ? all : (all[date] || []);
  return arr.filter(p => p.account === accountName);
}

// 二重投稿防止（端末ローカル・アカ×slot単位。Metaに削除されても"投げた事実"は残す）
function loadPosted(date, accountName) {
  const p = join(DATA_DIR, `posted_${date}_${safe(accountName)}.json`);
  try { if (existsSync(p)) return new Set(JSON.parse(readFileSync(p, 'utf8'))); } catch {}
  return new Set();
}
function savePosted(date, accountName, set) {
  try { writeFileSync(join(DATA_DIR, `posted_${date}_${safe(accountName)}.json`), JSON.stringify([...set])); }
  catch (e) { console.log('posted保存失敗:', e.message); }
}

// 直近投稿の実物確認（3回試して全滅なら判定不能→安全側で見送り）
async function recentPosts(token) {
  for (let i = 0; i < 3; i++) {
    try { const r = await jsonFetch(`${A}/me/threads?fields=id,text,timestamp&limit=25&access_token=${encodeURIComponent(token)}`); if (r && Array.isArray(r.data)) return r.data; } catch {}
    await sleep(1500);
  }
  return null;
}
async function alreadyPosted(text, token) {
  const data = await recentPosts(token);
  if (data === null) return true;  // 判定不能なら投稿しない（安全側）
  const key = text.slice(0, 24);
  const cutoff = Date.now() - 20 * 3600 * 1000;
  return data.some(p => (p.text || '').slice(0, 24) === key && Date.parse(p.timestamp || 0) >= cutoff);
}
async function pub(text, token) {
  let j = await jsonFetch(`${A}/me/threads`, { method:'POST', headers:{ 'Authorization':`Bearer ${token}`, 'Content-Type':'application/json' }, body: JSON.stringify({ media_type:'TEXT', text }) });
  if (!j.id) throw new Error('container失敗: ' + JSON.stringify(j).slice(0,160));
  const cid = j.id;
  await sleep(DELAY_MS);
  j = await jsonFetch(`${A}/me/threads_publish?creation_id=${cid}`, { method:'POST', headers:{ 'Authorization':`Bearer ${token}` } });
  if (!j.id) throw new Error('publish失敗: ' + JSON.stringify(j).slice(0,160));
  return j.id;
}

// 1アカ分の「予定時刻が来た投稿」を処理
async function runAccount(acc, date, postsUrl) {
  const posts = await loadPosts(date, acc.account, postsUrl);
  if (!posts || !posts.length) { console.log(`[${jstNow().toISOString().slice(11,16)}JST] ${date} ${acc.account} 分なし`); return; }
  const posted = loadPosted(date, acc.account);
  const now = Date.now();
  const jst = jstNow();
  const due = [];
  for (const p of posts) {
    if (p.date && p.date !== date) continue;
    if (posted.has(p.slot)) continue;
    const [hh, mm] = String(p.time).split(':').map(Number);
    const schedUtc = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), hh - 9, mm, 0);
    const lateMin = Math.floor((now - schedUtc) / 60000);
    if (lateMin >= 0 && lateMin <= GRACE_MIN) due.push({ ...p, lateMin });
  }
  if (!due.length) return;
  // 予定が早い順に並べ、1サイクルで出すのは先頭 MAX_PER_CYCLE 本だけ（残りは次サイクルへ回して自然にばらす）
  due.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  const batch = due.slice(0, MAX_PER_CYCLE);
  console.log(`[${jst.toISOString().slice(11,16)}JST] ${acc.account}: 期限内 ${due.length}本 → 今サイクル ${batch.length}本`);
  for (const p of batch) {
    try {
      if (await alreadyPosted(p.text, acc.access_token)) { console.log(`  ⏭️ ${acc.account} ${p.slot} 既投稿/判定不能`); posted.add(p.slot); savePosted(date, acc.account, posted); continue; }
      if (DRY) { console.log(`  [DRY] ${acc.account} ${p.slot} ${p.time}(${p.lateMin}分経過)`); continue; }
      // 投稿直前にランダム待機（端末同士の発火時刻をばらす＝同期バースト防止）
      const wait = Math.floor(Math.random() * PRE_POST_JITTER_MS);
      if (wait) { console.log(`  ⏳ ${acc.account} ${p.slot} ${Math.round(wait/1000)}秒待機してから投稿`); await sleep(wait); }
      const id = await pub(p.text, acc.access_token);
      posted.add(p.slot); savePosted(date, acc.account, posted);
      console.log(`  ✅ ${acc.account} ${p.slot} ${p.time} → ${id}`);
      await sleep(4000);
    } catch (e) { console.log(`  ❌ ${acc.account} ${p.slot}: ${e.message}`); }
  }
}

// 1サイクル = この端末の全アカを順番に処理（アカ間は小休止で同時発火を避ける）
async function cycle() {
  const date = todayStr();
  const { accounts, posts_url } = await resolveConfig();  // 毎サイクル担当アカを解決（遠隔での追加/更新を反映）
  if (!accounts.length) { console.log(`[${jstNow().toISOString().slice(11,16)}JST] 担当アカ未取得（config_url/device.jsonを確認）`); return; }
  for (const acc of accounts) {
    try { await runAccount(acc, date, posts_url); } catch (e) { console.log(`${acc.account} cycleエラー:`, e.message); }
    await sleep(BETWEEN_ACCOUNTS_MS);
  }
}

console.log(`[device-poster] device=${DEVICE_ID} / ${cfg.config_url ? 'config_url方式(遠隔)' : 'ローカルaccounts方式'} / ${DRY ? 'DRY ' : ''}${ONCE ? '単発' : '常駐(5分間隔)'} 起動`);
if (ONCE) { await cycle(); process.exit(0); }
while (true) {
  try { await cycle(); } catch (e) { console.log('cycleエラー:', e.message); }
  await sleep(CHECK_EVERY_MS);
}
