// Pocket会計の Windows 版。PWA のファイル（desktop/web）を WebView2 で表示するだけの薄い外枠
// データは WebView2 の IndexedDB（%LOCALAPPDATA%\<identifier>\EBWebView）に保存され、外部へは送信しない
// 本番ビルドでコンソール窓を出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::DownloadEvent;
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Pocket会計")
                .inner_size(1200.0, 800.0)
                .min_inner_size(360.0, 560.0)
                // ノートPCなど画面の大きさがまちまちなので、最初から最大化して開く
                .maximized(true)
                // 外部のサイトへは移動させない（アプリ自身・blob・data などはそのまま）
                .on_navigation(|url| !is_external_url(url))
                // バックアップ・CSV の書き出し（<a download>）は保存先を選ばせる
                .on_download(|_webview, event| match event {
                    DownloadEvent::Requested { destination, .. } => {
                        match choose_destination(destination) {
                            Some(path) => {
                                *destination = path;
                                true
                            }
                            None => false,
                        }
                    }
                    DownloadEvent::Finished { success, .. } => {
                        if !success {
                            rfd::MessageDialog::new()
                                .set_title("Pocket会計")
                                .set_level(rfd::MessageLevel::Error)
                                .set_description("ファイルを保存できませんでした。")
                                .show();
                        }
                        true
                    }
                    _ => true,
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Pocket会計を起動できませんでした");
}

/// 外部のウェブサイトか。アプリ自身（Windows は http://tauri.localhost、そのほかは tauri://localhost）と
/// IPC（ipc.localhost）は外部ではない。http/https 以外（tauri・blob・data・about など）も止めない
fn is_external_url(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && !matches!(url.host_str(), Some("tauri.localhost" | "ipc.localhost" | "localhost"))
}

/// 保存ダイアログを出す。初期値は WebView2 が決めた保存先（ダウンロードフォルダ＋ファイル名）
fn choose_destination(default: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut dialog = rfd::FileDialog::new().set_title("保存先を選ぶ");
    if let Some(dir) = default.parent() {
        dialog = dialog.set_directory(dir);
    }
    if let Some(name) = default.file_name().and_then(|n| n.to_str()) {
        dialog = dialog.set_file_name(name);
        if let Some(ext) = default.extension().and_then(|e| e.to_str()) {
            dialog = dialog.add_filter(ext.to_uppercase(), &[ext]);
        }
    }
    dialog.save_file()
}
