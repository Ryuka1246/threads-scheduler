// Decodo の Endpoints 画面でコピーした接続情報(クリップボード)から、.env の PROXY_USER / PROXY_PASS を自動で埋める。
// 実行: node scripts/set-proxy.mjs
//  対応する形: host:port:user:pass / http://user:pass@host:port / user:pass@host:port
//  値は画面に出さない(何文字だったかだけ表示)。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
const clip = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).trim();

let host, user, pass;
let m = clip.match(/^(?:https?:\/\/)?([^:@\s]+):([^@\s]+)@([^:\s]+):(\d+)$/); // user:pass@host:port
if (m) [, user, pass, host] = m;
else if ((m = clip.match(/^([^:\s]+):(\d+):([^:\s]+):(\S+)$/))) [, host, , user, pass] = m; // host:port:user:pass
if (!user || !pass) {
  console.log('クリップボードが接続情報の形ではありませんでした。Decodo の Endpoints 画面で、行の右端のコピーボタンを押してから、もう一度実行してください。');
  process.exit(1);
}

let env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
const setLine = (k, v) => {
  const re = new RegExp(`^${k}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, () => `${k}=${v}`) : env + `\n${k}=${v}`;
};
setLine('PROXY_HOST', host);
setLine('PROXY_USER', user);
setLine('PROXY_PASS', pass);
writeFileSync(ENV_PATH, env);
// クリップボードに残さない
execFileSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value " "']);
console.log(`✅ .env に保存しました(ホスト=${host} / ユーザー名${user.length}文字 / パスワード${pass.length}文字)。クリップボードは消しました。`);
