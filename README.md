# MacOS-AI-swimmers-note

MacOS 上で起動できる AI スイマー向け練習ノートアプリです。既存の Express + SQLite + Ollama 構成をベースに、ローカル API サーバーを起動してブラウザをアプリ風ウィンドウで開く Mac ランチャーを用意しています。

## セットアップ

```bash
cd ~/Documents/MacOS-AI-swimmers-note
npm install
npm run start:desktop
```

`start:desktop` はローカル Node サーバーを起動し、Chrome 系ブラウザがあれば `--app=` モードで専用ウィンドウを開きます。Mac に `node` が入っている前提です。

ローカル API サーバーだけを起動したい場合:

```bash
npm start
```

## MacOS アプリ化のポイント

- Mac ランチャー: `desktop-launcher.js`
- API サーバー: `server.js`
- フロントエンド: `public/index.html`
- データベース: `~/Library/Application Support/MacOS-AI-swimmers-note/data/swimmers.db`

## 補足

- `GEMMA_MODEL` 環境変数で利用モデルを切り替え可能です。
- AI コメントはローカル Ollama (`http://localhost:11434/v1/chat/completions`) を利用します。
- SQLite はローカル Node プロセス側で扱います。
