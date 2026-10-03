# Vesktop Chat Exporter

Vesktop（Vencord）用のユーザープラグインです。Vesktop起動中に受信したサーバーメッセージを専用フォルダーへ自動保存します。また、サーバーメニューから**現在のアカウントが閲覧できるテキストチャンネル**の過去ログを一括取得できます。

- `.txt`：検索・加工しやすいプレーンテキスト
- `.html`：チャンネル一覧付きでブラウザ閲覧できるログ

ログは保存確認なしで、専用フォルダーへ直接保存されます。

```text
C:\Users\<ユーザー名>\Documents\VesktopChatLogs
```

## 重要事項

- 自動保存はVesktop起動中にクライアントが受信した新規メッセージが対象です。プラグイン導入前やVesktop終了中の履歴は、サーバーメニューの一括保存で取得します。
- Discordの通常クライアントAPIを現在ログイン中のユーザーとして使用します。Botトークンやユーザートークンの入力・保存は行いません。
- 閲覧権限がないチャンネル、削除済みメッセージ、取得できないスレッドは保存できません。
- 大規模サーバーでは取得に長時間かかります。Discord APIのレート制限を避けるため、ページ間に待機時間を設けています。
- ログには個人情報が含まれる場合があります。保存・共有はサーバー規約、Discord利用規約、適用法令および参加者のプライバシーに従ってください。
- Discord/Vencordの非公式改造環境です。利用は自己責任です。

## インストール

### かんたんインストール（Releases・推奨）

[Releases](../../releases) から `VesktopChatExporter.zip` をダウンロードし、展開して `install.bat` をダブルクリックします。

```text
VesktopChatExporter.zip
├── install.bat        ← ダブルクリック
├── install.ps1
├── uninstall.ps1
├── README.txt
└── vencordFiles/      ← VesktopChatExporter 入りの Vencord ビルド
```

インストーラーは以下を行います。

1. Vesktop のデータフォルダー（`%APPDATA%\vesktop` など）を自動検出
2. 既存の Vencord ファイルを `vencordFiles.bak-<日時>` へバックアップ
3. 同梱の Vencord ビルドを `sessionData\vencordFiles` へコピー

その後 **Vesktop を完全に終了して起動し直し**、`設定 → Vencord → Plugins` で `VesktopChatExporter` を有効化します。

元に戻すときは `uninstall.ps1` を実行します（バックアップから復元、無ければ公式 Vencord を再取得）。

> Vesktop を更新した場合や `--repair` を実行した場合は公式 Vencord に戻るため、再インストールが必要です。

### 手動でビルドする場合

Vencord公式ビルドは外部プラグインをそのまま読み込みません。Vencordをソースからビルドします。

1. Vencordソースを取得します。
2. このリポジトリのプラグインをVencordへコピーします。

```powershell
Copy-Item -Recurse .\src\plugins\vesktopChatExporter <Vencord>\src\userplugins\vesktopChatExporter
```

`src/userplugins` が使えないバージョンでは、次へコピーしてください。

```text
<Vencord>/src/plugins/vesktopChatExporter
```

3. Vencordの手順に従って依存関係を導入し、Vesktop向けにビルド・注入します。
4. Vesktopを再起動し、`設定 → Vencord → Plugins` で `VesktopChatExporter` を有効化します。

同梱パッケージを自分で作り直す場合は次を実行します（要 git / Node.js 22+ / pnpm）。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-vencord.ps1
```

生成された `release\vencordFiles` を `installer` フォルダーと一緒に zip にします。

## 使用方法

1. サーバーアイコンを右クリックするか、サーバー名のメニューを開きます。
2. **全チャンネルのログを保存（TXT + HTML）** を選択します。
3. 完了後、TXTとHTMLが `ドキュメント\VesktopChatLogs` へ保存されます。

同じメニューの **ログ保存フォルダーを開く** で保存先を開けます。取得中は同じメニューから中止できます。

## 設定

- **添付ファイルと埋め込みのURLを出力する**：添付そのものではなくURLをログへ記録します。
- **APIページ取得間隔**：100メッセージ取得ごとの待機時間です。標準は750ms、最低500msです。
- **自動保存**：Vesktop起動中に受信したサーバーメッセージを、日付・チャンネル別のTXT/HTMLへ追記します。
- **強制履歴収集**：全サーバーの閲覧可能な履歴を最新から古い順に取得します。1秒に1リクエスト、10回ごとに5秒休止し、HTTP 429時は即停止してDiscord指定時間以上待機します。進捗は再起動後も引き継ぎます。
- **停止するサーバーID / 停止するチャンネルID**：ここへ追加したサーバー・チャンネルはログ収集を一切行いません（後述）。

## 指定したサーバー・チャンネルのログ停止

サーバー単位・チャンネル単位でログ収集を止められます。停止した対象は次のすべてに適用されます。

- 受信メッセージの自動保存
- 起動中の履歴の自動収集（実行中のチャンネルはその場で中断）
- サーバーメニューからの一括保存
- Vesktop Consent Recorder による通話・画面共有の録画

設定する方法は3つあります。

1. **サーバーを右クリック → 「このサーバーのログ収集を停止」**
2. **チャンネルを右クリック → 「このチャンネルのログ収集を停止」**
3. **設定 → VesktopChatExporter → 停止するサーバーID / 停止するチャンネルID** にIDを直接入力

IDは17〜20桁の数字で、カンマ・改行・空白のいずれでも区切れます。もう一度同じメニューを選ぶか、設定欄から該当IDを消すと収集を再開します。

> 録画側（Vesktop Consent Recorder）はこの停止リストをそのまま読み取るため、同じ対象で通話録画も停止します。

## 現在の制限

- 添付ファイル本体はダウンロードしません。
- アクティブスレッドを独立チャンネルとして列挙する処理は未実装です。
- DiscordやVencord内部APIの変更により、将来修正が必要になる場合があります。
- 1つの巨大なHTML/TXTをメモリ上で作るため、数百万件規模ではメモリを多く消費します。

## License

GPL-3.0-or-later
