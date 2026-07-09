# scrippo 設計仕様書 v1.0

**scrippo** (screen + 日報) — 毎分のスクリーンショット + macOS OCR でローカルに作業ログを蓄積し、Codex SDK(ChatGPTサブスク範囲)で日報を生成するCLIツール。

## 設計原則

- **完全ローカル**: 外部送信は Codex への日報生成リクエストのみ。ツールは一切自動投稿しない
- **中間生成物は消える**: スクショ画像はOCR後即削除。JSONLログは `scrippo purge` で削除。残るのは日報Markdownのみ
- **依存最小**: ランタイム依存は `@openai/codex-sdk` のみ。他はNode標準ライブラリで実装
- **テンプレート駆動**: 日報の観点はテンプレートファイル(Markdown)の差し替えで自由にカスタマイズ

## アーキテクチャ

```
[launchd 毎分] → capture → screencapture(ディスプレイごと)
                         → メタデータ取得(最前面app/ウィンドウタイトル)
                         → bin/ocr (Swift/Vision) → テキスト化
                         → 画像即削除
                         → logs/YYYY-MM-DD.jsonl に追記

[手動] scrippo report → digest(重複排除・チャンク化)
                      → Codex SDK + テンプレート
                      → reports/YYYY-MM-DD-<template>.md

[手動] scrippo purge  → 確認済みの日のログ・digest-cache・.last-capture.json を削除
```

## ディレクトリ構成

```
scrippo/                        # リポジトリ
├── bin/ocr                     # Swift小バイナリ (VNRecognizeTextRequest, ja-JP/en-US)
├── ocr-src/main.swift          # ocrバイナリのソース(ビルドスクリプト付き)
├── src/
│   ├── cli.ts                  # エントリポイント・サブコマンドルーティング
│   ├── capture.ts              # 1回分のキャプチャ処理(launchdから毎分起動)
│   ├── digest.ts               # JSONL → digest.json
│   ├── report.ts               # digest + テンプレート → Codex → Markdown
│   └── util.ts                 # ロック判定・ファイルパーミッション等
├── templates/
│   ├── gyomu-nippo.md
│   └── furikaeri.md
├── mise.toml                   # Node LTS 固定
└── package.json                # 依存: @openai/codex-sdk のみ

~/.scrippo/                     # データディレクトリ (chmod 700, ファイルは 600)
├── logs/2026-07-09.jsonl
├── reports/2026-07-09-gyomu-nippo.md
├── digest-cache/2026-07-09.json   # 再生成時の再利用用(purgeで一緒に削除)
├── .last-capture.json             # 重複判定用の直前OCRテキスト(purge/stopで削除)
├── config.json                    # 除外アプリリスト等
└── capture-error.log              # サイズ上限つき(下記)
```

## capture の仕様

launchd (`StartInterval: 60`, `ProcessType: Background`) で毎分起動。デーモンとして常駐せず、毎回使い捨てプロセスとして動く(ただし重複判定用に直前OCRテキストを `.last-capture.json` として保持する)。

1. **ロック判定**: `CGSessionCopyCurrentDictionary` の `CGSSessionScreenIsLocked` をチェック(ocrバイナリに同居させる)。ロック中は何も書かず終了。**ロック状態が判定できない場合もキャプチャしない**(プライバシー境界はフェイルセーフに倒す)
2. **メタデータ取得**: 最前面アプリ名・ウィンドウタイトル(`CGWindowListCopyWindowInfo`、ocrバイナリに同居)
3. **除外アプリ判定**: config.json の `excluded_apps` のアプリが**画面上のいずれかのウィンドウ**に存在する場合(最前面に限らない。別ディスプレイに表示中も含む)、OCRせず `skip_reason: "excluded"` のレコードを書いて終了。このとき **window_title も記録しない**(パスワードマネージャーのタイトルはアイテム名を含み得るため)。初期値 `["1Password", "キーチェーンアクセス"]`
4. **スクショ**: `screencapture -x -D <n>` をディスプレイ数ぶん実行、一時ディレクトリ(`mkdtemp`)に保存
5. **OCR**: `bin/ocr <image>` がJSON(テキスト+confidence)をstdoutに返す
6. **画像削除**: OCR成否にかかわらず一時ディレクトリごと削除(finally で保証)
7. **JSONL追記**: 1分=1レコード(全ディスプレイ分を1レコードに内包)

エラー時は `~/.scrippo/capture-error.log` に1行追記して黙って終了(毎分実行なので通知はしない)。恒常的なエラーで無限成長しないよう、**1MBを超えたら古い半分を切り捨てる**簡易ローテーションを入れる。直近のエラーは `scrippo status` で件数表示する。

### JSONL レコードスキーマ

```jsonc
{
  "ts": "2026-07-09T10:23:00+09:00",
  "app": "Google Chrome",
  "window_title": "MR !412: fix reservation slot calc - GitLab",
  "displays": [
    { "id": 1, "ocr_text": "...", "confidence": 0.92 },
    { "id": 2, "ocr_text": "...", "confidence": 0.88 }
  ],
  "skip_reason": null   // OCRスキップ時のみ "duplicate"(直前と画面がほぼ同一) or "excluded"(除外アプリ)。スキップ時は displays 省略
}
```

skipの2つの理由を区別して記録することで、digest・テンプレート側で「画面に変化がなかった時間帯」と「除外アプリ使用中」を書き分けられる。`skip_reason: "excluded"` のレコードは `window_title` も省略する。

### 重複排除(書き込み時)

前回レコードの各ディスプレイOCRテキスト(正規化後: 連続空白を1つに圧縮)を `.last-capture.json` に保持。今回のテキストとの類似度を**行集合のJaccard係数**で判定し、**0.9以上なら `skip_reason: "duplicate"` でテキスト省略**(app/window_title は記録)。書き込み時に排除することでディスク上の平文テキスト量も最小化する。`.last-capture.json` も平文OCRテキストを含むため、`scrippo purge` および `scrippo stop` で削除する。

## digest の仕様

`scrippo report` 実行時に当日(または `--date`)のJSONLを読み、以下を生成:

```jsonc
{
  "date": "2026-07-09",
  "coverage": { "first": "09:12", "last": "18:47", "captured_minutes": 431, "gap_minutes": 62 },
  "app_summary": [
    { "app": "Google Chrome", "minutes": 180 },
    { "app": "iTerm2", "minutes": 120 }
  ],
  "chunks": [
    {
      "start": "09:10", "end": "09:50",
      "dominant_app": "Google Chrome",
      "window_titles": ["MR !412: ... - GitLab", "Redmine #8821 ..."],
      "ocr_highlights": "（この区間の非重複OCRテキストから抽出した要点。全文ではない）",
      "gap_before_minutes": 0
    }
  ]
}
```

チャンク化ロジック(決定的、LLM不使用):

- 基本10分区切り。ただし dominant_app が同じ連続区間はマージ(最大40分)
- 5分以上のキャプチャ空白は `gap` として明示(離席・スリープ)
- `ocr_highlights`: チャンク内の非スキップOCRテキストを連結 → 行単位で重複除去 → **チャンクあたり最大1500文字**に切り詰め。URL・チケット番号・MR番号らしき行(`#\d+`, `!\d+`, `https?://`)を優先的に残す
- digest全体の目標サイズ: **50KB以下**(超えたら ocr_highlights の上限を動的に縮める)

## report の仕様(Codex SDK)

1. digest.json を生成。digest-cache には**生成時の元JSONLのサイズとmtime**を併記し、キャッシュがあっても元JSONLが変わっていれば自動的に再生成する(同日に再実行したとき、午後の作業が古いキャッシュのせいで抜け落ちるのを防ぐ)。`--force` は無条件に再生成
2. テンプレートファイルを読み込み
3. Codex SDK でスレッド開始。プロンプト構成:
   - system相当: 「あなたは日報作成アシスタント。digestは自動キャプチャ由来で不完全。推測は控えめに、不明な時間帯は不明と書く」+ テンプレートの指示部
   - user: digest.json 全文
4. 出力Markdownを `reports/YYYY-MM-DD-<template名>.md` に保存し、パスを表示
5. **ログは削除しない**(purge するまで残す)。同日・同テンプレートの再実行は上書き確認プロンプト

Codexはエージェントモードでなく単発生成として使う(ファイルシステム探索はさせない)。将来テンプレート側で追加集計が必要になったらエージェント化を検討。

## テンプレート仕様

テンプレート = 1つのMarkdownファイル。フロントマターで軽い設定、本文がプロンプト指示+出力フォーマット例。ユーザーは `templates/` にファイルを追加するだけで `scrippo report --template <ファイル名>` で使える。`{date}` は report 側で置換。

以下の2テンプレートは初期実装の仕様。**実装後は `templates/` の実ファイルを正とし**、本書の写しは更新しない(二重管理によるドリフトを避けるため、以後の文言調整は実ファイル側だけで行う)。

### templates/gyomu-nippo.md

```markdown
---
name: 業務日報
---
digestから業務日報を作成してください。社内共有前提のトーンで、事実ベースに。

# 出力フォーマット

## 日報 {date}

### 本日の作業
時系列で3〜7項目。各項目は「時間帯 / 作業内容(対象のMR・チケット番号があれば含める)」。
細かいアプリ切り替えは丸めて、意味のある作業単位で書く。

### 成果・完了事項
完了が読み取れるものだけ。推測で「完了」と書かない。

### 明日の予定・持ち越し
digestから継続中とわかる作業を持ち越しとして列挙。予定は不明なら「(記入)」とプレースホルダにする。

### 備考
キャプチャ空白が大きい時間帯(会議・外出の可能性)はここに記載。
```

### templates/furikaeri.md

```markdown
---
name: 振り返り
---
digestから個人の振り返りメモを作成してください。自分専用、率直なトーンで。

# 出力フォーマット

## 振り返り {date}

### タイムライン概観
集中して1つの作業に取り組めた区間(30分以上同一コンテキスト)と、
切り替えが激しかった区間を対比して示す。

### 集中とコンテキストスイッチ
- 最長の集中区間とその内容
- アプリ/タスク切り替えが多かった時間帯と、切り替え先の傾向(Slack? ブラウザ?)

### 気づき
データから言える範囲で2〜3点。過度な断定や説教はしない。

### 明日試すこと
1点だけ提案。
```

## CLI コマンド

```
scrippo start                # フォアグラウンドでテストキャプチャ→権限確認OK後に launchd plist生成・ロード
scrippo stop                 # アンロード + .last-capture.json 削除
scrippo status               # 稼働状態 / 今日のレコード数 / logs容量 / purge待ちの日 / 直近エラー件数 / macOS権限診断
scrippo report [--template gyomu-nippo] [--date YYYY-MM-DD] [--force]
scrippo purge [--date YYYY-MM-DD | --all-reported]   # 確認プロンプトあり。digest-cache と .last-capture.json も削除
scrippo templates            # テンプレート一覧
```

`scrippo start` は launchd 登録の**前に**フォアグラウンドで1回テストキャプチャを実行する。launchd 経由の初回実行で権限ダイアログが出ると、ユーザーが気づかないままメタデータのみの空ログが溜まり続けるため、権限プロンプトは必ず対話的なコンテキストで発火させる。

## セキュリティ・運用ルール

- Node: LTS を mise で固定(`mise.toml` をリポジトリに含める)
- 依存: `@openai/codex-sdk` のみ。`npm ci` 運用、lockfileコミット必須。依存追加はレビュー必須
- `~/.scrippo` は 700、全ファイル 600 で作成
- macOS権限: **画面収録のみ**。screencapture に加え、ウィンドウタイトル取得(`kCGWindowName`)も macOS 10.15 以降は画面収録権限でカバーされるため、アクセシビリティ権限は原則不要(実装時に実機で要検証。必要と判明した場合のみ要求に追加)。`scrippo status` で権限状態を診断表示

## Phase 2(スコープ外・メモ)

- Googleカレンダー統合: CLI上のOAuth(loopback flow)でイベント取得 → digest に `calendar_events` として併記し、テンプレート側で整合性チェックを指示
- 週報テンプレート(複数日のdigestを入力)
- Deno互換化(パーミッションモデルによる防御強化)

## 実装順序

1. `ocr-src/main.swift` → `bin/ocr`(単体で `ocr image.png` → JSON。ロック判定・最前面ウィンドウ取得のサブコマンドも同居: `ocr session-info`)
2. `capture.ts` + launchd plist(1日回して JSONL の質を確認)
3. `digest.ts`(実データでチャンクとサイズ感を調整)
4. `report.ts` + テンプレート2種(プロンプト試行錯誤)
5. `purge` / `status` / 権限診断
