# scrippo 実装引き継ぎメモ

SPEC.md が正。ここは実装者(人間 or コーディングエージェント)向けの補足と、仕様策定時に決めた判断の背景。

## 決定事項と背景(なぜこうなっているか)

| 決定 | 背景 |
|---|---|
| TS + 依存は codex-sdk のみ | npmサプライチェーン懸念への対応。zod等も入れない。バリデーションは手書き |
| 重複排除は capture 側(書き込み時) | ディスク上の平文OCRテキストを最小化(プライバシー)+ JSONL自体を小さく |
| purge は手動、report では消さない | 生成失敗・再生成・人間の確認を挟むため |
| Codex は単発生成、エージェントモード不使用 | 480レコードをCodexに探索させるとトークン爆発&非決定的になるため。前処理は決定的コードで行うハイブリッド構成 |
| Swift バイナリは1個に集約(`bin/ocr`) | OCR / ロック判定 / 最前面ウィンドウ取得はすべてネイティブAPIが必要。サブコマンド方式(`ocr <img>` / `ocr session-info`)で1バイナリに |
| ロック中スキップ、除外アプリはappのみ記録(タイトルも省略) | プライバシー境界。初期除外: 1Password, キーチェーンアクセス。除外判定は最前面に限らず画面上の全ウィンドウが対象(別ディスプレイ表示中も含む) |
| プライバシー境界の判定はフェイルセーフ | ロック状態が取れない・除外判定に失敗した等の場合は「キャプチャしない」側に倒す |

## コンポーネント別の実装ノート

### 1. bin/ocr (Swift)

- `swiftc ocr-src/main.swift -o bin/ocr -framework Vision -framework AppKit` 程度の単純ビルドで済むよう、SwiftPM は使わず単一ファイルにする
- サブコマンド:
  - `ocr recognize <path>` → `{"text": "...", "confidence": 0.92}` をstdout
  - `ocr session-info` → `{"locked": false, "lock_state_unknown": false, "frontmost_app": "...", "window_title": "...", "on_screen_apps": ["...", "..."], "display_count": 2}`
- Vision: `VNRecognizeTextRequest`, `recognitionLevel = .accurate`, `recognitionLanguages = ["ja-JP", "en-US"]`, `usesLanguageCorrection = true`
- confidence はトップ候補の平均でよい
- ロック判定: `CGSessionCopyCurrentDictionary()` の `kCGSSessionScreenIsLocked`(private気味のキーなので、取れない場合は `locked: true` 扱い=キャプチャしない。フェイルセーフ)。判定不能だったことが分かるよう `lock_state_unknown: true` も返し、capture 側でエラーログに残す
- ウィンドウ情報: `CGWindowListCopyWindowInfo(.optionOnScreenOnly, ...)` から `kCGWindowLayer == 0` の最前面を拾う。加えて**画面上の全ウィンドウのオーナーアプリ名一覧**も返す(除外アプリ判定用: `on_screen_apps`)。タイトル(`kCGWindowName`)は macOS 10.15 以降**画面収録権限**があれば取れるはず(アクセシビリティ不要。実装時に実機で要検証)。権限がなくタイトルが取れない場合もエラーにせず空文字で返す

### 2. capture.ts

- 実行フロー: `ocr session-info` → locked(判定不能含む)なら exit 0 → 除外アプリ判定(`on_screen_apps` と excluded_apps の交差。最前面だけでなく画面上の全ウィンドウが対象)→ `screencapture -x -D 1..n <tmp>/d1.png` → 各画像を `ocr recognize` → Jaccard判定 → JSONL追記 → tmp削除
- 除外時のレコードは `app` と `skip_reason: "excluded"` のみ。`window_title` は書かない
- ディスプレイ数は session-info の `display_count` を使う
- Jaccard: 前回テキストは `~/.scrippo/.last-capture.json` に保持(これも600。purge/stopで削除される)。行集合で `|A∩B| / |A∪B| >= 0.9` なら `skip_reason: "duplicate"`
- capture-error.log は追記前にサイズをチェックし、1MB超なら古い半分を切り捨てる
- JSONL追記は `fs.appendFileSync`(毎分1プロセスなので競合しない)
- launchd plist は `scrippo start` がテンプレートから生成して `~/Library/LaunchAgents/com.<user>.scrippo.plist` に配置、`launchctl bootstrap gui/$(id -u)` でロード。node のフルパスを埋め込むこと(launchd は PATH が貧弱)
- `scrippo start` は launchd 登録の**前に**フォアグラウンドでテストキャプチャを1回実行する。権限ダイアログを対話コンテキストで発火させるためで、テストキャプチャが失敗(権限なし)なら登録せずに権限設定の案内を出して終了する

### 3. digest.ts

- SPEC のチャンク化ロジック参照。全て純関数で書き、実データJSONLを入れたスナップショットテストを用意すると調整が楽
- 50KB超過時: 各チャンクの ocr_highlights 上限を 1500 → 1000 → 600... と段階的に下げて再生成
- digest-cache には `{source_size, source_mtime}` を併記し、report 実行時に元JSONLと一致しなければキャッシュ無視で再生成(同日再実行の取りこぼし防止)

### 4. report.ts

- `@openai/codex-sdk` の Thread API で単発実行。`skipGitRepoCheck` 相当のオプションに注意(作業ディレクトリがgitリポジトリでなくても動くように)
- プロンプト: system指示(SPEC記載)+ テンプレート本文 + `---` + digest.json
- 出力から Markdown 部分だけを抽出(コードフェンスで囲まれて返る場合の剥がし処理を入れる)
- Codex 未ログイン時は分かりやすいエラー(`codex login を実行してください`)

### 5. cli.ts

- 引数パースは `node:util` の `parseArgs` を使う(依存追加しない)
- `status` で診断する項目: launchd ロード状態 / 今日のレコード数 / logs 合計サイズ / purge されていない日の一覧 / capture-error.log の直近エラー件数 / 画面収録権限(session-info のウィンドウタイトルが取れるかで間接判定)

## 最初の検証手順(実装順序と対応)

1. `bin/ocr recognize` を手元のスクショで叩いて日本語精度を確認
2. capture を launchd なしで手動実行 → JSONL を目視
3. launchd 登録して半日〜1日放置 → レコード数と skip 率、JSONL サイズを確認(想定: skip率50%以上、1日数MB以内)
4. digest を実データで生成 → 50KB以内か、チャンクが意味を成しているか
5. report で2テンプレート生成 → プロンプト調整ループ

## Phase 2 メモ

- Google カレンダー: loopback OAuth → `calendar_events: [{start, end, title}]` を digest に併記。テンプレートに「イベントとgapの整合を取れ」と書くだけで動くはず
- 週報テンプレート: report に `--range` を足して複数日 digest を連結
- Deno 互換化検証
