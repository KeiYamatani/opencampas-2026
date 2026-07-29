# 脳の意思決定ラボ

高校生向けの時間判断 Go/No-go 課題です。0.8秒が比較する相手によって「長い」と「短い」に変わる体験を通して、反応時間・Weber型の時間判断・拡散決定モデル（DDM）を紹介します。

## 公開URL

GitHub Pages: https://keiyamatani.github.io/opencampas-2026/

`main` ブランチへの更新で GitHub Actions が静的サイトをビルドし、GitHub Pagesへ公開します。

## データの扱い

参加者の試行データは端末内に保存されます。結果画面のCSVを保存し、`/analysis` ページで複数のCSVを手動集計できます。外部データベースへの送信は行いません。

## 開発

```bash
pnpm install
pnpm dev
```

GitHub Pagesと同じパスで確認する場合は、環境変数 `NEXT_PUBLIC_BASE_PATH=/opencampas-2026` を設定して `pnpm build:pages` を実行します。
