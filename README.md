# threads-scheduler

Threads Graph API 用の軽量な投稿スケジューラ／コメント自動返信スクリプト集。
設定値・本文・トークンはコードに含めず、すべて環境変数（GitHub Secrets）から注入する設計です。

## スクリプト

- `scripts/post-scheduler.mjs` — その日の投稿データを読み、予定時刻（90分以内）の未投稿分を本文＋コメント＋ツリーまで publish。重複防止はステートレス（直近投稿の実物確認）。
- `scripts/auto-reply.mjs` — 直近投稿へのコメントに、テンプレを組み合わせて1回だけ返信。二重返信防止はステートレス。

## 必要な環境変数（Secrets）

| 名前 | 中身 |
|---|---|
| `THREADS_TOKENS` | `[{ "account": "...", "access_token": "..." }, ...]` のJSON配列 |
| `POSTS_JSON` | その日の投稿データ（JSON配列）を gzip して base64 したもの |
| `REPLY_PARTS` | 返信テンプレJSON（`{ account: { open:[], mid:[], emoji:[] } }`） |

ローカル実行時は各スクリプトと同じ `scripts/` 直下に `tokens.env` / `reply_parts.json`、`posts/{YYYY-MM-DD}.json` を置けば環境変数なしでも動く（いずれも `.gitignore` 済み）。

## ワークフロー

- `.github/workflows/post-scheduler.yml` — JST 07:00〜23:30 を30分ごと
- `.github/workflows/auto-reply.yml` — 15分ごと

公開リポジトリなら GitHub Actions は無料。
