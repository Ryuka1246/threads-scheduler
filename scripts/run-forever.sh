#!/data/data/com.termux/files/usr/bin/sh
# 端末常駐ランチャー（スマホ操作ゼロ運用の心臓部）
#
# 毎サイクルで次をやる:
#   1) git pull  … リポジトリの最新を取得（= device-poster.mjs 等のコード修正を自動反映）
#   2) 投稿を1回  … node device-poster.mjs --once（その時点で期限内の枠だけ投稿）
#   3) 5分休む
#
# これにより「コードの修正」も「投稿データの追加」も、スマホを一切触らずに自動で反映される。
# 一度このランチャーを起動しておけば、以後 Claude 側が push するだけで全端末へ届く。
#
# 起動（端末で最初の1回だけ）:
#   chmod +x ~/threads-scheduler/scripts/run-forever.sh
#   nohup sh ~/threads-scheduler/scripts/run-forever.sh >> ~/poster.log 2>&1 &

REPO="$HOME/threads-scheduler"
cd "$REPO/scripts" 2>/dev/null || { echo "リポジトリが見つかりません: $REPO"; exit 1; }
echo "[run-forever] 起動 $(date)"

while true; do
  # ① 最新コードを取得（失敗しても前回のコードでそのまま続行）
  git -C "$REPO" pull --ff-only --quiet 2>/dev/null || echo "[run-forever] git pull 失敗（前回のコードで継続）"
  # ② 期限内の枠を1回ぶん投稿（エラーでもループは止めない）
  node "$REPO/scripts/device-poster.mjs" --once 2>&1 || echo "[run-forever] 投稿サイクルでエラー（次サイクルで再試行）"
  # ③ 5分休む
  sleep 300
done
