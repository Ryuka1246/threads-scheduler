# 端末ローカル投稿セットアップ（12端末 × 2アカ = 24アカ）

リーチ抑制（共有データセンターIP・全アカ同時発火）対策として、GitHub Actions の集中投稿をやめ、
**12台の物理端末それぞれのモバイル回線（別IP）から、その端末担当の2アカだけ**を投稿する構成。

- 投稿IPが12個に分散 → 「1人がスマホで2垢運用」という自然な見え方になる
- スクリプト本体: `device-poster.mjs`（複数アカ対応・常駐5分ループ）
- 設定ファイル: `device.json`（端末ごとに中身を変える。**gitignore済＝トークンはリポに入らない**）

> ⚠️ **必ずモバイルデータ（4G/5G）で動かす。** 自宅wifiだと全端末が同じ自宅IPになり分散にならない（＝対策の意味が消える）。

---

## 端末 ↔ 担当アカ 割り当て（本家N + 2アカ目N）

本家とその2アカ目は同一人物の2垢なので、同じ端末にまとめる。

| 端末 | 本家(ひらがな) | 2アカ目(漢字) |
|------|----------------|----------------|
| D01  | 千鶴           | ちづる         |
| D02  | 小梅           | こうめ         |
| D03  | あんな         | 杏奈           |
| D04  | なな           | 奈々           |
| D05  | あかり         | 明里           |
| D06  | ゆりあ         | 友梨亜         |
| D07  | みお           | 澪             |
| D08  | レナ           | 玲奈           |
| D09  | さくら         | 桜             |
| D10  | まりな         | 真里奈         |
| D11  | りな           | 梨奈           |
| D12  | ゆき           | 雪             |

※ account 名は `posts.json` / `THREADS_TOKENS` の表記と**完全一致**（上記の日本語名そのまま）。

---

## 各端末のセットアップ（Android / Termux）

1. **Termux** を F-Droid から導入（Google Play版は古いので非推奨）
2. 必要パッケージ:
   ```
   pkg update && pkg install nodejs git
   ```
3. リポジトリを取得:
   ```
   git clone <このリポジトリ> && cd threads-scheduler/scripts
   ```
4. 設定ファイルを作成（**その端末の担当2アカ**に書き換え）:
   ```
   cp device.example.json device.json
   ```
   `device.json` の中身（例: D01）:
   ```json
   {
     "device_id": "D01",
     "posts_url": "https://.../posts/{date}.json",
     "accounts": [
       { "account": "千鶴",   "access_token": "THxxxx..." },
       { "account": "ちづる", "access_token": "THyyyy..." }
     ]
   }
   ```
5. スリープで止まらないように（termux-api 導入時）:
   ```
   termux-wake-lock
   ```
6. 起動（常駐・5分ごとに点検して予定時刻の来た投稿を出す）:
   ```
   node device-poster.mjs
   ```
   - `--dry` … 投稿せず判定だけ（動作確認用）
   - `--once` … 1サイクルだけ実行して終了（cron運用向け）
7. （任意）端末再起動後の自動起動: **Termux:Boot** アドオンを入れ、`~/.termux/boot/` に起動スクリプトを置く。

---

## 投稿データ（posts/{日付}.json）の配り方

`posts/` は手法秘匿のため **gitignore 済**。公開リポの raw では取得できない。どちらかで各端末に渡す:

- **方法A（推奨・自動）**: 秘密の GitHub Gist（非公開）に毎日の `{date}.json` を置き、その raw URL を
  `device.json` の `posts_url` に設定（`{date}` はスクリプトが当日の日付に置換）。
  全アカ分の1ファイルでOK（各端末が自分の担当アカ分だけ抽出する）。
- **方法B（手動）**: 各端末の `scripts/posts/{日付}.json` に手で配置（`posts_url` を空にする）。

> トークン(`access_token`)は `device.json` にのみ記入し、**リポジトリには絶対にコミットしない**（`.gitignore` で `scripts/device.json` と `scripts/device-data/` を除外済）。

---

## 二重投稿・取りこぼし対策（スクリプト挙動）

- 予定時刻から **110分以内** の枠だけ投稿（取りこぼし吸収・最短枠間隔を割らない）
- 投稿済みは端末ローカルの `device-data/posted_{日付}_{アカ}.json` に記録（アカ×slot単位）
- 投稿前に Threads API で直近投稿を実物確認。判定不能時は**投稿しない**（安全側）
- 端末内の2アカは順番に処理し、間に小休止（同一IPからの同時発火の足跡を避ける）

---

## 残タスク

- [ ] 24アカのトークンを各 `device.json` に配布（本家12=`new_tokens.json` / 2アカ目12=`new_tokens2.json` 由来。別Metaアプリ）
- [ ] posts配布方法の確定（方法A: 秘密Gist / 方法B: 手動）
- [ ] 現行の GitHub Actions 投稿（post-scheduler.yml）を止めるタイミング（端末運用の実投稿を確認してから `gh workflow disable`）
- [ ] トークン失効対策（60日・refresh）を端末運用でどう回すか
