# Mekuru（めくる）
**Apple Pencil 特化型 ミニマル・クロッキー PWA**

> **「描いて、めくる。」**  
> 実物のモチーフや別モニターのモデルを観察しながら、iPadとApple Pencilで直感的にクロッキーを重ねるための単機能スケッチブックPWA。

---

## 1. 特徴 & こだわり

* **画面全面が白紙キャンバス**: 余計なメニュー、レイヤー、カラーパレットを完全排除し、黒鉛筆の線と質感に全集中。
* **入力ソースの完全分離（パームリジェクション）**:
  * `e.pointerType === 'pen'`: 描画処理のみ実行。手首が画面に触れても絶対に汚れません。
  * `e.pointerType === 'touch'`: ジェスチャー操作（2本指タップでUndo、2本指スワイプで白紙へめくる）のみに割り当て。
  * `e.pointerType === 'mouse'`: PC環境での動作テスト・デバッグ用にも対応。
* **筆圧・傾き連動 & 鉛筆テクスチャ**:
  * **筆圧 (`e.pressure`)**: 線の太さと濃度を滑らかに動的制御。
  * **傾き (`e.altitudeAngle`)**: ペンを寝かせると描画スタンプ幅が広がり、黒鉛濃度が拡散して「鉛筆の腹を使った面塗り（シェーディング）」を忠実に再現。
  * **120Hz 補間 (`e.getCoalescedEvents`)**: iPadの走査レートに追従し、素早いストロークでも一切カクつきません。
  * **黒鉛粒子 & 乗算ブレンド**: `globalCompositeOperation = 'multiply'` により、線を重ねるほど本物の鉛筆のように自然に色が深まります。
* **ゼロ遅延ページめくり（Mekuru）**:
  * 「めくる」ボタンまたは2本指スワイプで、**次フレーム（<16ms）で瞬時に白紙クリア**。
  * 描画データはバックグラウンドで非同期保存（IndexedDB & Rustサーバー）されるため、ペン先の描画リズムを止めません。
* **ミニマル・クロッキータイマー**:
  * プリセット: [ なし | 30秒 | 1分 | 2分 | 5分 ]
  * タイムアップ時: 邪魔にならない上品な画面フラッシュ ＆ Web Audio API による優しいチャイム音。
  * 設定トグル: 「タイムアップ時に自動で白紙ページへめくる（Auto-flip）」機能。
* **見返しギャラリー & パラパラめくりビューア**:
  * 描いたスケッチを時系列グリッドで一覧表示。
  * タップで全画面ビューアを開き、左右スワイプでパラパラ漫画のようにサクサク見返し可能。
  * 端末の写真フォルダや他アプリへ書き出せるエクスポート（単体保存・共有）機能。
* **パスキー（WebAuthn）認証 & ハイブリッド永続化**:
  * オフラインでも端末内IndexedDB（Dexie.js）に100%安全保存。
  * サーバー接続時はRustバックエンド（SQLite3）に自動同期。
  * Touch ID / Face ID によるパスキー認証に対応。
  * **パスキーリセットCLI**: 万が一パスキーを紛失した場合は、CLIから即座にリセット可能。

---

## 2. ディレクトリ構成

```text
mekuru/
├── server/                 # Rustバックエンド (Axum, WebAuthn, Rusqlite, Clap)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs         # サーバー起動 & CLIサブコマンド (reset-passkey等)
│       ├── db.rs           # SQLite3 永続化 (ユーザー、パスキー、セッション、スケッチ)
│       ├── auth.rs         # WebAuthn (Passkey) ハンドラ
│       └── sketch.rs       # スケッチ送受信API
├── src/                    # フロントエンド (Vite + TypeScript + Tailwind CSS PWA)
│   ├── engine/             # 鉛筆描画コアエンジン & パームリジェクション
│   │   ├── PencilEngine.ts
│   │   ├── PencilTexture.ts
│   │   ├── GestureRecognizer.ts
│   │   └── UndoManager.ts
│   ├── db/                 # Dexie.js (端末内ローカルIndexedDB)
│   ├── timer/              # ミニマルクロッキータイマー
│   ├── audio/              # Web Audio API チャイムシンセサイザー
│   ├── gallery/            # ギャラリー一覧 & フルスクリーンスワイプビューア
│   ├── services/           # 認証 & バックエンド同期サービス
│   └── ui/                 # 四隅の極小HUD & トースト通知
├── public/                 # PWAマニフェスト用アイコン・ファビコン
├── Dockerfile              # マルチステージビルド (Node -> Rust -> Debian slim)
├── docker-compose.yml      # コンテナ構成 & データ永続化ボリューム
└── vite.config.ts          # Vite & PWA 設定
```

---

## 3. 起動方法 (Docker & Docker Compose)

最も手軽かつ推奨される起動方法です。

```bash
# 起動
docker compose up -d --build

# 停止
docker compose down
```

ブラウザで `http://localhost:3000` を開きます。  
iPadのSafariで開き、「ホーム画面に追加」を行うことで、URLバーのない全画面スタンドアロンPWAとして動作します。

---

## 4. パスキーリセット CLI マニュアル

万が一パスキーを紛失した場合や、別デバイスで再登録したい場合、ホストから以下のコマンドで安全にリセットできます。

```bash
# 特定ユーザーのパスキーをリセット（即座に再登録可能になります）
docker compose exec mekuru mekuru reset-passkey <ユーザー名>

# 登録ユーザーおよびパスキー登録数の一覧を表示
docker compose exec mekuru mekuru list-users

# ユーザーの事前作成
docker compose exec mekuru mekuru create-user <ユーザー名>
```

※ローカルバイナリで直接実行する場合は `./target/release/server reset-passkey <ユーザー名>` で実行可能です。

---

## 5. ローカル開発環境での起動

### フロントエンド開発 (Vite HMR)
```bash
npm install
npm run dev
```

### バックエンド開発 (Rust)
```bash
cd server
cargo run -- serve --port 3000
```