Vesktop Chat Exporter - インストール手順
========================================

1. このフォルダーごと、任意の場所へ展開します。
2. install.bat をダブルクリックします。
   （PowerShell から実行する場合）
   powershell -ExecutionPolicy Bypass -File install.ps1
3. Vesktop を完全に終了し、起動し直します。
4. 設定 -> Vencord -> Plugins -> VesktopChatExporter を有効化します。
5. サーバーを右クリック -> 「全チャンネルのログを保存（TXT + HTML）」

ログの保存先:
  C:\Users\<ユーザー名>\Documents\VesktopChatLogs

アンインストール:
  uninstall.ps1 を実行すると、インストール前の Vencord ファイルへ戻します。

注意:
  - このパッケージは Vesktop が使う Vencord 一式を置き換えます。
    他の Vencord プラグイン設定（%APPDATA%\Vencord\settings.json）は維持されます。
  - Vesktop を更新した場合や --repair を実行した場合は、
    公式 Vencord に戻るため再インストールが必要です。
  - 本ツールは Discord / Vencord の非公式改造です。Discord 利用規約に
    従って自己責任で使用してください。
