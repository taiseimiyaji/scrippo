# Googleカレンダー統合 設計書(Phase 2)

日付: 2026-07-09
ステータス: 設計承認済み・実装計画待ち

## 目的

Googleカレンダーの予定を日報生成パイプラインに取り込み、(1) キャプチャ空白(gap)を「会議」として日報に正しく書けるようにする、(2) 振り返りで予定と実績の突合(予定どおり出た会議 / 予定外に使った時間 / 会議合計時間)を可能にする。

## 手段の選定

**EventKit(macOSカレンダー.app経由)を採用。**

会社のGoogleアカウントは macOSカレンダー.app に同期済み/同期可能であるため、EventKit でローカルに読み取る。これにより:

- ネットワーク送信ゼロ・OAuth設定ゼロ・依存追加ゼロ(scrippoの「完全ローカル・依存最小」原則に合致)
- 外部送信ポイントは従来どおり Codex のみ、という性質を維持

不採用案:

- **Google Calendar API + loopback OAuth**(SPEC Phase 2 原案): GCPセットアップとトークン管理(保存・更新・失効)のコストが用途(1日1回の読み取り)に見合わない。リフレッシュトークンという秘匿情報がディスクに残る。macOSカレンダー同期が使えなくなった場合のフォールバックとして温存。
- **gcalcli等サードパーティCLI**: 依存最小の運用ルールに反するため不採用。

## 設計

### 1. Swift側: `ocr calendar-events` サブコマンド

`ocr-src/main.swift` に既存サブコマンド(`recognize` / `session-info`)と同居させる。

```
ocr calendar-events --date 2026-07-09
```

出力(stdout, JSON):

```jsonc
{
  "authorized": true,          // カレンダー権限の有無。未許可でも exit 0
  "events": [
    {
      "start": "2026-07-09T10:00:00+09:00",
      "end": "2026-07-09T11:00:00+09:00",
      "title": "チーム定例",
      "calendar": "you@example.com",
      "all_day": false,
      "my_status": "accepted",   // accepted | declined | tentative | pending | unknown
      "attendee_count": 5
    }
  ]
}
```

- `EKEventStore` + `requestFullAccessToEvents()`(macOS 14+)。権限未許可なら `{"authorized": false, "events": []}` を返しエラーにしない
- 指定日の 00:00〜24:00(ローカルタイムゾーン)のイベントを `predicateForEvents` で取得
- **辞退(declined)イベントも含めて全件返す**。`my_status` で区別し、解釈はテンプレート側に委ねる
- 終日イベントは `all_day: true`(時間帯突合の対象外としてdigest側で扱う)
- 権限が取得できない・カレンダー未設定・取得失敗のいずれも `authorized: false` または空配列で穏当に返す

### 2. 取得タイミング: report実行時にオンデマンド

キャプチャ側(capture.ts / JSONL)は**無変更**。`scrippo report` の digest 生成時に `ocr calendar-events` を呼び、結果を digest に併記する。

- 毎分プロセスが重くならない
- 予定タイトルという新たな平文がログ(JSONL)に蓄積しない
- **digest-cache には含めない**: キャッシュはキャプチャ由来の digest のみとし、予定は report 実行のたびに取得して合成する。同日中の予定変更が常に反映され、予定タイトルがディスクに残らない

### 3. digest への組み込み(決定的処理)

digest.json に追加:

```jsonc
{
  "calendar_events": [
    {
      "start": "10:00", "end": "11:00",
      "title": "チーム定例",
      "all_day": false,
      "my_status": "accepted",
      "attendee_count": 5,
      "overlap": "gap"   // 下記
    }
  ],
  "calendar_available": true   // false のとき calendar_events は省略
}
```

`overlap` はイベント時間帯とキャプチャ状況の突合結果(決定的コード、LLM不使用):

- `"gap"` — イベント時間帯の過半がキャプチャ空白(離席=会議室・通話に出ていた可能性が高い)
- `"captured"` — イベント時間帯の過半で画面キャプチャあり(画面を見ながらの会議、または不参加)
- `"partial"` — 混在

文章化・解釈(「この会議に出ていた」等)はテンプレート/LLM側に任せる。HANDOFF.md の方針(前処理は決定的、解釈はLLM)を踏襲。

終日イベント(`all_day: true`)は overlap 判定の対象外(`overlap` を省略)。

digest 50KB制限との関係: calendar_events は高々数十件・数KBのため、既存の縮小ロジック(ocr_highlights を段階的に縮める)の対象外とし、常に全件含める。

### 4. テンプレート更新

- **gyomu-nippo.md**: calendar_events がある場合、`overlap: "gap"` のイベントは会議として「本日の作業」に記載。`my_status: "declined"` の会議は原則作業に数えないが、overlap が gap なら「実際には出ていた可能性」の手がかりとして扱う。終日イベントは備考に回す。calendar_events が無い日は従来どおりの出力。
- **furikaeri.md**: 「予定と実績」セクションを追加 — 予定どおり出た会議 / 予定外に使った時間帯 / 会議に費やした合計時間の対比。calendar_events が無い場合はセクションごと省略、と明記。

(実装後は `templates/` の実ファイルを正とする — SPEC.md の既存方針どおり)

### 5. CLI・診断・設定

- `scrippo status`: カレンダー権限の診断行を追加(`ocr calendar-events` の `authorized` で判定)
- **デフォルトの対象カレンダー**: `calendar_names` 未設定時は「Googleアカウントのメールアドレスを名前に持つカレンダー」= 各アカウントのプライマリカレンダーのみを対象とする。判定は Swift 側で行う: カレンダー名(`EKCalendar.title`)がメールアドレス形式で、かつ所属アカウント(`EKSource`)のアカウント名と一致するもの。共有カレンダー・チームカレンダー・祝日カレンダー等はデフォルトで除外される
- `config.json` の `calendar_names: string[]` で明示指定した場合はそのカレンダー名のみを対象とする(デフォルト判定を上書き。`["*"]` で全カレンダー)。report 側が config.json を読み、`ocr calendar-events --date <date> --calendars "<name1>,<name2>"` として引数で渡す(未設定時は `--calendars` を省略し、Swift 側がデフォルト判定を適用)。フィルタは Swift 側で適用する(対象外カレンダーのタイトル平文をプロセス間で流さない)
- `ocr calendar-events --list-calendars`: 利用可能なカレンダー名の一覧を出力(`{"authorized": true, "calendars": [{"name": "...", "account": "...", "default_selected": true}]}`)。`scrippo status` でこの一覧と現在の対象を表示し、`calendar_names` の設定ミスに気づけるようにする

### エラー処理

権限なし・カレンダー.app未設定・`ocr calendar-events` の失敗のいずれも「calendar_events なしで従来どおり日報生成」に倒し、report を止めない。`calendar_available: false` を digest に残し、status で権限不足に気づける。

### 必要な macOS 権限

既存の「画面収録」に加えて「カレンダーへのフルアクセス」が1つ増える。初回は `scrippo report` 実行時(対話的コンテキスト)に権限ダイアログが出る。README の動作要件に追記する。

### README 追記(実装時に反映)

- **動作要件**: 「macOS権限: カレンダーへのフルアクセス(日報にカレンダーの予定を含める場合。任意)」「GoogleアカウントをmacOSのインターネットアカウントに追加しカレンダー同期を有効化」
- **設定セクション**(新設または既存に追記):
  - デフォルトでは自分のメールアドレスを名前に持つカレンダー(= Googleアカウントのプライマリカレンダー)のみが対象になること
  - 変更したい場合は `~/.scrippo/config.json` の `calendar_names` にカレンダー名を列挙すること(`["*"]` で全カレンダー)
  - 利用可能なカレンダー名は `scrippo status` で確認できること
- **プライバシー設計**: 「予定はログ(JSONL)には保存されず、日報生成時にのみ読み取られる。対象外カレンダーの情報はSwiftバイナリの外に出ない」を追記

### テスト

- digest の overlap 判定・イベント整形は純関数で実装し、スナップショット/ユニットテストを用意
- Swift 側(EventKit)は実機で手動検証(既存の検証手順に準拠): 権限あり/なし、辞退イベント、終日イベント、複数カレンダー

### スコープ外

- MTG単位の議事メモ生成(イベントに紐づくOCR切り出し)— 将来の拡張候補
- 週報テンプレート、Calendar API(OAuth)版
