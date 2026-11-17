// 1日分の投稿データを「予約投稿で使える形」にするローカル用スクリプト。
//   入力: posts/{日付}.local.json … images にPC上の画像パスが入った投稿データ(Claude Codeが毎朝作る)
//   処理: ①中身チェック(500字以内・画像は20枚/8MBまで・ファイルがあるか)
//         ②画像を Cloudflare R2 に上げる(推測されにくいランダム名)→ images を公開URLに置き換え
//         ③posts/{日付}.json に保存
//         ④今日以降の posts/*.json をまとめて gzip+base64 → GitHub Secret POSTS_JSON に登録
// 実行: node scripts/build-day.mjs 2026-11-17 [--dry]
//   --dry … チェックと変換内容の表示だけ(R2へのアップロードとSecret登録はしない)
// 設定(.env / threads-scheduler直下・gitignore済み):
//   R2_BUCKET=threads-images
//   R2_PUBLIC_BASE=https://pub-xxxxxxxx.r2.dev
//   GH_REPO=Ryuka1246/threads-scheduler
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const POSTS_DIR = join(ROOT, 'posts');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!date) { console.error('使い方: node scripts/build-day.mjs YYYY-MM-DD [--dry]'); process.exit(1); }

// .env を読む(値はログに出さない)
const env = {};
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const need = ['R2_BUCKET', 'R2_PUBLIC_BASE', 'GH_REPO'];
if (!DRY) for (const k of need) if (!env[k]) { console.error(`.env に ${k} がありません`); process.exit(1); }

// ---- ① 入力を読んでチェック ----
const inPath = join(POSTS_DIR, `${date}.local.json`);
if (!existsSync(inPath)) { console.error(`入力がありません: posts/${date}.local.json`); process.exit(1); }
const posts = JSON.parse(readFileSync(inPath, 'utf8'));
if (!Array.isArray(posts)) { console.error('入力は投稿の配列にしてください'); process.exit(1); }

const errors = [];
const seenKeys = new Set();
for (const [i, p] of posts.entries()) {
  const tag = `#${i + 1} ${p.account || '?'} ${p.time || '?'}`;
  for (const k of ['account', 'slot', 'time', 'text']) if (!p[k]) errors.push(`${tag}: ${k} が空`);
  if (!/^\d{1,2}:\d{2}$/.test(String(p.time || ''))) errors.push(`${tag}: time は HH:MM`);
  if ([...String(p.text || '')].length > 500) errors.push(`${tag}: 本文が500字を超えている`);
  if (p.tree_reply && [...String(p.tree_reply)].length > 500) errors.push(`${tag}: ツリーが500字を超えている`);
  const key = `${p.account}|${p.slot}`;
  if (seenKeys.has(key)) errors.push(`${tag}: account+slot が重複(${key})`); seenKeys.add(key);
  const imgs = Array.isArray(p.images) ? p.images : [];
  if (imgs.length > 20) errors.push(`${tag}: 画像は20枚まで`);
  for (const f of imgs) {
    if (/^https?:\/\//.test(f)) continue; // 既にURLならそのまま
    if (!existsSync(f)) { errors.push(`${tag}: 画像が見つからない ${f}`); continue; }
    if (statSync(f).size > 8 * 1024 * 1024) errors.push(`${tag}: 画像が8MB超 ${f}`);
    if (!['.png', '.jpg', '.jpeg'].includes(extname(f).toLowerCase())) errors.push(`${tag}: 画像はpng/jpgのみ ${f}`);
  }
}
if (errors.length) { console.error('入力エラー:\n  ' + errors.join('\n  ')); process.exit(1); }

// ---- ② 画像を R2 へ(同じファイルは1回だけ上げる。対応表 posts/{日付}.uploads.json に記録)----
const upPath = join(POSTS_DIR, `${date}.uploads.json`);
const uploaded = existsSync(upPath) ? JSON.parse(readFileSync(upPath, 'utf8')) : {};
function upload(localPath) {
  if (uploaded[localPath]) return uploaded[localPath];
  const ext = extname(localPath).toLowerCase() === '.png' ? '.png' : '.jpg';
  const key = `${date}/${randomBytes(12).toString('hex')}${ext}`;
  const url = `${(env.R2_PUBLIC_BASE || 'https://(R2公開URL)').replace(/\/$/, '')}/${key}`;
  if (DRY) return url;
  // wrangler で R2 に置く(ログインは wrangler login 済みの前提)
  execFileSync('npx', ['--yes', 'wrangler', 'r2', 'object', 'put', `${env.R2_BUCKET}/${key}`, '--file', localPath,
    '--content-type', ext === '.png' ? 'image/png' : 'image/jpeg', '--remote'], { stdio: 'inherit', shell: process.platform === 'win32' });
  uploaded[localPath] = url;
  writeFileSync(upPath, JSON.stringify(uploaded, null, 2)); // 1枚ごとに記録(途中で止まってもやり直しで二重に上げない)
  return url;
}

const out = posts.map(p => ({ ...p, date, images: (Array.isArray(p.images) ? p.images : []).map(f => /^https?:\/\//.test(f) ? f : upload(f)) }));
for (const p of out) {
  const n = p.images.length;
  console.log(`  ${p.time.padStart(5, '0')} ${p.account} ${p.slot} ${n === 0 ? '文字' : n === 1 ? '画像1枚' : `カルーセル${n}枚`}${p.tree_reply ? ' +ツリー' : ''}`);
}

if (DRY) { console.log(`[DRY] チェックOK ${out.length}本(R2アップロードとSecret登録はしていない)`); process.exit(0); }

// ---- ③ 保存 ----
writeFileSync(join(POSTS_DIR, `${date}.json`), JSON.stringify(out, null, 2));

// ---- ④ 今日以降の分をまとめて Secret に ----
const todayJst = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const bundle = {};
for (const f of readdirSync(POSTS_DIR)) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
  if (m && m[1] >= todayJst) bundle[m[1]] = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
}
const b64 = zlib.gzipSync(Buffer.from(JSON.stringify(bundle))).toString('base64');
execFileSync('gh', ['secret', 'set', 'POSTS_JSON', '--repo', env.GH_REPO], { input: b64, stdio: ['pipe', 'inherit', 'inherit'] });
console.log(`✅ ${date} の${out.length}本を保存し、POSTS_JSON を更新(含む日付: ${Object.keys(bundle).sort().join(', ')})`);
