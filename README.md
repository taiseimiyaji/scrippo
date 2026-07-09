# scrippo

> Your screen, distilled into a daily report. — screen + 日報 = scrippo

毎分スクリーンショットを撮り、macOS標準のOCR(Vision framework)でテキスト化してローカルに蓄積。1日の終わりに Codex(ChatGPTサブスク範囲)で日報・振り返りを自動生成するCLIツールです。

## 特徴

- **完全ローカル** — 外部送信は日報生成時の Codex リクエストのみ。自動投稿は一切しない
- **痕跡を残さない** — スクショ画像はOCR直後に削除。ログも日報を確認して `scrippo purge` すれば消える。残るのは日報だけ
- **ランニングコストゼロ** — OCRはmacOS標準、LLMはCodexサブスク内。追加API課金なし
- **テンプレート駆動** — 業務日報/振り返りを同梱。Markdownを1枚足すだけで自分好みの日報形式を追加可能
- **依存最小** — ランタイム依存は `@openai/codex-sdk` のみ

## 動作要件(macOS専用)

- macOS 14 以降(Vision framework / screencapture / EventKit を使用)
- Node.js 24 以降
- Xcode Command Line Tools(インストール時に OCR バイナリを swiftc でビルドします)
- Codex CLI ログイン済み(`codex login`)
- macOS権限: 画面収録(screencapture とウィンドウタイトル取得の両方をこの1つでカバー)
- macOS権限: カレンダーへのフルアクセス(日報にカレンダーの予定を含める場合。任意)
- Googleカレンダー連携する場合: システム設定 > インターネットアカウント に Google アカウントを追加し、カレンダー同期を有効化

## インストール

```bash
# 前提ツール(未導入の場合)
xcode-select --install        # Xcode Command Line Tools (swiftc)
brew install node             # Node.js 24+(mise 等でも可)

# 本体
npm install -g scrippo        # postinstall で bin/ocr を自動ビルド
scrippo start                 # テストキャプチャ→権限確認→常駐開始
```

> `scrippo start` は launchd に常駐登録し、インストール先の絶対パスを参照します。
> `npx scrippo status` のような単発の試用は可能ですが、常駐(`start`)は
> 必ずグローバルインストール(`npm install -g`)で行ってください
> (npx の一時キャッシュが消えると毎分のキャプチャが動かなくなります)。

### ソースから使う場合(開発者向け)

```bash
git clone https://github.com/taiseimiyaji/scrippo.git && cd scrippo
mise install          # Node LTS(mise.toml で固定)
npm ci                # 依存: @openai/codex-sdk のみ(postinstall で bin/ocr をビルド)
alias scrippo="node $(pwd)/src/cli.ts"
```

## 使い方

```bash
scrippo start        # 毎分キャプチャ開始(launchd常駐)
scrippo status       # 稼働状態・権限診断・今日のレコード数
scrippo report       # 今日のログから日報生成(--template furikaeri で振り返り)
scrippo purge        # 日報を確認したらログを削除
scrippo stop         # キャプチャ停止
```

## カレンダー連携(任意)

macOSカレンダー.appに同期された予定を、日報生成時に読み取って突合します(EventKit使用・外部送信なし)。

- デフォルトでは**自分のメールアドレスを名前に持つカレンダー**(Googleアカウントのプライマリカレンダー)のみが対象
- ただしメールアドレス形式の名前を持つ共有カレンダー(会議室・商談枠など)もデフォルト対象に含まれることがあります。混入する場合は `calendar_names` で自分のカレンダー名だけを指定してください
- 変更する場合は `~/.scrippo/config.json` の `calendar_names` にカレンダー名を列挙(`["*"]` で全カレンダー)
- 利用可能なカレンダー名と現在の対象は `scrippo status` で確認できます

予定はログ(JSONL)やキャッシュには保存されず、日報生成時にのみ読み取られます。対象外カレンダーの情報は Swift バイナリの外に出ません。

## 仕組み

```
毎分: screencapture → Vision OCR → JSONL追記(画像は即削除)
手動: JSONL → digest(重複排除・チャンク化, 決定的処理) → Codex → 日報Markdown
```

詳細は [docs/SPEC.md](docs/SPEC.md) を参照。

## プライバシー設計

- `~/.scrippo` は `700`、ファイルは `600`
- 画面ロック中はキャプチャしない(ロック状態が判定できない場合もキャプチャしない側に倒す)
- 除外アプリリスト(パスワードマネージャー等)のウィンドウが画面上にあればOCRをスキップ。ウィンドウタイトルも記録しない
- `purge` は重複判定用の直前キャプチャテキストも含めて削除する
- 生成された日報の公開・投稿はすべて人間が手動で行う
- カレンダーの予定はディスクに保存せず、日報生成時にのみ読み取って Codex へのプロンプトに含める
- 日報生成時の Codex 実行は、read-only サンドボックス・ネットワーク遮断・空の一時作業ディレクトリで行い、OCRテキスト経由のプロンプトインジェクション(画面に映った悪意ある指示文)への露出を最小化している

> **注意**: デフォルトの除外アプリは 1Password とキーチェーンアクセスのみです。ブラウザに表示した機密情報(銀行サイト、個人情報を含む画面など)はキャプチャ・OCR対象になります。必要に応じて `~/.scrippo/config.json` の `excluded_apps` にアプリを追加してください(例: 銀行専用ブラウザ)。

## License

MIT
