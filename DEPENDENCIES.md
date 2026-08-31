# 実行時依存関係

このアプリはビルド工程を持たないVanilla HTML/CSS/JavaScriptアプリです。`npm install` は不要で、`index.html` をWebサーバから配信すれば動きます（ES moduleを使うため `file://` では動きません）。

## 第三者コンポーネント（CDNから読み込み）

| 名称 | 固定版・配信元 | 用途 | ライセンス | 外部通信 |
|---|---|---|---|---|
| MathJax | 3.2.2 / jsDelivr | 数式表示 | Apache-2.0 | 初回読込時にjsDelivr |
| MathLive | 0.98.4 / unpkg | 数式入力（`<math-field>`） | MIT | 初回読込時にunpkg |
| BIZ UDPGothic, Outfit | Google Fonts | 文字表示 | OFL-1.1 | 初回読込時にGoogle Fonts |

読み込み場所は次のとおりです。MathJaxとMathLiveは `index.html` の `<script>`、**Google Fontsは `style.css` 1行目の `@import`** です。外部を参照しているのはこの3つだけで、ほかにパッケージ、バンドラ、ポリフィル、アイコンフォント、画像、音声、service worker、manifest は使っていません。

### 読み込み順序（変更禁止）

1. `<head>`: `window.MathJax = {...}` の設定 → MathJaxスクリプト（`async`）
2. `<body>` 末尾: MathLive → `handwriting-overlay.js` → `main.js`（`type="module"`）

**MathLiveを `<head>` で読み込まないでください。** MathJaxの初期化がMathLiveのShadow DOMを壊します。

### MathJaxの設定

`tex.packages` から `require` / `html` / `textmacros` を除外しています。生徒の入力を含む数式から `\href{javascript:...}` などが実行される経路を作らないためです。加えて、生徒の答えは構文木から組み直したLaTeXだけを表示し、パースに失敗した入力は数式として組版しません。

## 同梱している自作ファイル

| ファイル | 役割 | 外部依存 |
|---|---|---|
| `index.html` | 3画面の構造とライブラリ読み込み | — |
| `style.css` | 全スタイル（Google Fontsの`@import`のみ外部） | Google Fonts |
| `main.js` | 画面遷移・入力・履歴・復習（DOM操作のみ） | 上記2コンポーネント |
| `questions.js` | 問題生成・ヒント・解説（DOM非依存の純関数） | なし |
| `domain-judge.js` | 数式パーサ・値判定・形式判定（DOM非依存の純関数） | なし |
| `handwriting-overlay.js` | 画面全体の手書きレイヤー（社内自作部品） | なし |
| `tests.mjs` | 自動テスト（`node tests.mjs`） | なし |
| `package.json` | `{"type":"module","private":true}` のみ | なし（依存パッケージ0件） |

`handwriting-overlay.js` は社内スキル `handwriting-overlay` 同梱の自作部品で、第三者コードを含みません。

## 通信と保存

- 外部への送信コードはありません（`fetch`・`XMLHttpRequest`・`WebSocket`・ビーコンをいずれも使用していません）。
- 通信は上記3コンポーネントの初回読み込みだけです。
- 保存は端末内のlocalStorage 2キー（`nyushi-series:v2:course:exam-calculation` / `nyushi-series:v2:history:exam-calculation`）のみです。氏名・学校名・生徒IDは収集しません。

CDNへ到達できない環境では数式の表示・入力ができません。その場合はネットワーク接続を確認して再読み込みしてください。

## 動作確認した環境

- Chrome（Chromebook 1366×768 相当のビューポート）
- Node.js（`node tests.mjs` / `node --check`）。BigIntを使うため、BigInt対応のブラウザとNodeが必要です。
