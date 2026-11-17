// Threads API の共通部品(post-scheduler / auto-reply / refresh-tokens で共用)
// - アカ別プロキシ: アカ情報 { account, access_token, proxy_port? / proxy? } で指定。
//   proxy_port … 共通の PROXY_HOST / PROXY_USER / PROXY_PASS(環境変数 or threads-scheduler/.env)と組み合わせて使う(Decodo: isp.decodo.com:10001〜)
//   proxy      … http://user:pass@host:port を丸ごと書く場合(proxy_port より優先)
//   どちらも無いアカは直接通信(従来どおり)。そのアカの通信はすべてそのプロキシ経由で出す。
// - 投稿: 文字 / 画像1枚 / カルーセル(2〜20枚)。画像はコンテナが FINISHED になるのを待ってから公開する。
// - ログにトークンやプロキシの中身を出さない(エラー文からも消してから返す)。
import { fetch, ProxyAgent } from 'undici';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const API = 'https://graph.threads.net/v1.0';

// threads-scheduler/.env を読み込む(環境変数が既にあればそちらを優先。値はログに出さない)
const ENV_PATH = new URL('../.env', import.meta.url);
try {
  for (const line of readFileSync(ENV_PATH, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
const TIMEOUT_MS = 20000;
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// アカ情報を読む: 環境変数 THREADS_TOKENS(GitHub Actions) > scripts/device.json(端末運用) > scripts/tokens.env(ローカル)
export function loadAccounts(scriptsDir) {
  const devPath = join(scriptsDir, 'device.json');
  if (!process.env.THREADS_TOKENS && existsSync(devPath)) {
    try {
      const d = JSON.parse(readFileSync(devPath, 'utf8'));
      if (Array.isArray(d.accounts) && d.accounts.length) return d.accounts.filter(t => t && t.account && t.access_token);
    } catch {}
  }
  const raw = process.env.THREADS_TOKENS || readFileSync(join(scriptsDir, 'tokens.env'), 'utf8');
  return JSON.parse(raw).filter(t => t && t.account && t.access_token);
}

// プロキシの接続口はアカ(=プロキシURL)ごとに1つだけ作って使い回す
function proxyUrlOf(acc) {
  if (!acc) return null;
  if (acc.proxy) return acc.proxy;
  if (acc.proxy_port) {
    const { PROXY_HOST, PROXY_USER, PROXY_PASS } = process.env;
    if (!PROXY_HOST || !PROXY_USER || !PROXY_PASS) throw new Error(`${acc.account}: proxy_port があるのに PROXY_HOST/PROXY_USER/PROXY_PASS が未設定`);
    return `http://${encodeURIComponent(PROXY_USER)}:${encodeURIComponent(PROXY_PASS)}@${PROXY_HOST}:${acc.proxy_port}`;
  }
  return null;
}
const agents = new Map();
export function dispatcherFor(acc) {
  const url = proxyUrlOf(acc);
  if (!url) return undefined;
  if (!agents.has(url)) agents.set(url, new ProxyAgent(url));
  return agents.get(url);
}

// エラー文からトークン・プロキシ情報を消す(ログ漏れ防止)
function scrub(acc, s) {
  let out = String(s);
  if (acc && acc.access_token) out = out.split(acc.access_token).join('***');
  if (acc && acc.proxy) out = out.split(acc.proxy).join('(proxy)');
  for (const k of ['PROXY_PASS', 'PROXY_USER']) if (process.env[k]) out = out.split(process.env[k]).join('***');
  return out.replace(/access_token=[^&\s"]+/g, 'access_token=***');
}

// 1回のAPI呼び出し。成功/失敗にかかわらず { ok, status, data } を返す(例外を投げない)
// path は '/me/threads' のような相対パス、または paging.next の完全URL
export async function api(acc, method, path, params = {}) {
  const url = new URL(path.startsWith('http') ? path : API + path);
  const headers = { Authorization: `Bearer ${acc.access_token}` };
  let body;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  } else {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, String(v));
    body = form;
  }
  try {
    const res = await fetch(url, { method, headers, body, dispatcher: dispatcherFor(acc), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: { message: scrub(acc, e.cause?.message || e.message || e) } } };
  }
}

const errText = (acc, r) => scrub(acc, JSON.stringify(r.data && r.data.error ? r.data.error : r.data)).slice(0, 200);

// コンテナを作る(下書き)。失敗時は例外
async function createContainer(acc, params) {
  const r = await api(acc, 'POST', '/me/threads', params);
  if (!r.ok || !r.data.id) throw new Error('コンテナ作成失敗: ' + errText(acc, r));
  return r.data.id;
}

// 画像の取り込み完了(FINISHED)を待つ。ERROR/EXPIRED/時間切れなら例外
async function waitFinished(acc, containerId, maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const r = await api(acc, 'GET', `/${containerId}`, { fields: 'status,error_message' });
    const st = r.ok ? r.data.status : null;
    if (st === 'FINISHED') return;
    if (st === 'ERROR' || st === 'EXPIRED') throw new Error(`画像の取り込み失敗(${st}): ${scrub(acc, r.data.error_message || '')}`);
    await sleep(3000);
  }
  throw new Error('画像の取り込みが時間内に終わらなかった');
}

// 公開。一時的な失敗に備えて数回やり直す
async function publishContainer(acc, containerId) {
  let last;
  for (let i = 0; i < 4; i++) {
    if (i > 0) await sleep(3000);
    last = await api(acc, 'POST', '/me/threads_publish', { creation_id: containerId });
    if (last.ok && last.data.id) return last.data.id;
  }
  throw new Error('公開失敗: ' + errText(acc, last));
}

// 文字だけの投稿(replyTo を渡すとその投稿/コメントへの返信になる)
export async function publishText(acc, text, replyTo) {
  const id = await createContainer(acc, { media_type: 'TEXT', text, reply_to_id: replyTo });
  await sleep(3000);
  return publishContainer(acc, id);
}

// 画像1枚の投稿
export async function publishImage(acc, text, imageUrl, replyTo) {
  const id = await createContainer(acc, { media_type: 'IMAGE', image_url: imageUrl, text, reply_to_id: replyTo });
  await waitFinished(acc, id);
  return publishContainer(acc, id);
}

// カルーセル(2〜20枚)の投稿。全部の画像が取り込めてからまとめる
export async function publishCarousel(acc, text, imageUrls) {
  if (imageUrls.length < 2 || imageUrls.length > 20) throw new Error(`カルーセルは2〜20枚(今回${imageUrls.length}枚)`);
  const children = [];
  for (const u of imageUrls) {
    children.push(await createContainer(acc, { media_type: 'IMAGE', image_url: u, is_carousel_item: 'true' }));
    await sleep(1500);
  }
  for (const c of children) await waitFinished(acc, c);
  const id = await createContainer(acc, { media_type: 'CAROUSEL', children: children.join(','), text });
  await waitFinished(acc, id);
  return publishContainer(acc, id);
}

// 画像の枚数で自動的に振り分け: 0枚=文字 / 1枚=画像 / 2枚以上=カルーセル
export async function publishPost(acc, { text, images }) {
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (imgs.length === 0) return publishText(acc, text);
  if (imgs.length === 1) return publishImage(acc, text, imgs[0]);
  return publishCarousel(acc, text, imgs);
}

// 直近の自分の投稿(3回試して全滅なら null=判定不能)
export async function recentPosts(acc) {
  for (let i = 0; i < 3; i++) {
    const r = await api(acc, 'GET', '/me/threads', { fields: 'id,text,timestamp', limit: 25 });
    if (r.ok && Array.isArray(r.data.data)) return r.data.data;
    await sleep(1500);
  }
  return null;
}
