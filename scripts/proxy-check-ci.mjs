// GitHub Actions 上で「各アカの通信が本当にプロキシ経由か」を確かめる(読み取りだけ)
// 公開ログに出るので、IPは末尾だけ・トークン/アカ名は出さない
import { fetch } from 'undici';
import { dispatcherFor } from './threads-api.mjs';
const accs = JSON.parse(process.env.THREADS_TOKENS).filter(a => a && a.account);
const ipOf = async (dispatcher) => (await (await fetch('https://api.ipify.org?format=json', { dispatcher, signal: AbortSignal.timeout(15000) })).json()).ip;
const direct = await ipOf(undefined);
const tail = ip => '…' + ip.split('.').slice(-1)[0];
console.log(`GitHubサーバーの直接IP: ${tail(direct)}`);
let ng = 0;
for (const [i, a] of accs.entries()) {
  try {
    const d = dispatcherFor(a);
    if (!d) { console.log(`アカ${i + 1}: ❌ プロキシ設定なし`); ng++; continue; }
    const ip = await ipOf(d);
    const ok = ip !== direct;
    if (!ok) ng++;
    console.log(`アカ${i + 1}: ${ok ? '✅ プロキシ経由' : '❌ 直接'} 出口IP ${tail(ip)}`);
  } catch (e) { console.log(`アカ${i + 1}: ❌ 接続失敗 ${String(e.cause?.code || e.message).slice(0, 40)}`); ng++; }
}
process.exit(ng ? 1 : 0);
