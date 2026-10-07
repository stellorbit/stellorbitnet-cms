use std::fs::File;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CMS_PORT: u16 = 8322;
const ASTRO_PORT: u16 = 4321;

#[derive(Default)]
pub struct AppState {
    cms_child: Mutex<Option<Child>>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct HealthStatus {
    pub cms_running: bool,
    pub astro_running: bool,
    pub ready: bool,
    pub message: String,
}

// サーバーのポートがリッスン中か確認
fn is_port_open(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

// プロジェクトのルートディレクトリを探す
fn find_project_root() -> PathBuf {
    // 1. カレントディレクトリの確認
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("scripts").join("dev-cms.mjs").exists() {
            return cwd;
        }
        if let Some(parent) = cwd.parent() {
            if parent.join("scripts").join("dev-cms.mjs").exists() {
                return parent.to_path_buf();
            }
        }
    }

    // 2. 実行ファイル (exe) の上位ディレクトリを探索
    if let Ok(exe_path) = std::env::current_exe() {
        let mut cur = exe_path.as_path();
        while let Some(parent) = cur.parent() {
            if parent.join("scripts").join("dev-cms.mjs").exists() {
                return parent.to_path_buf();
            }
            cur = parent;
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

// node.exe のパスを探す
fn find_node_executable() -> String {
    let candidates = [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\Program Files (x86)\\nodejs\\node.exe",
    ];

    for candidate in candidates {
        if Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }

    // フォールバック: PATH上の "node"
    "node".to_string()
}

// CMSサーバーの起動処理
fn start_cms_process(state: &AppState) -> Result<bool, String> {
    if is_port_open(CMS_PORT) {
        log::info!("CMS server is already running on port {}", CMS_PORT);
        return Ok(true);
    }

    let root = find_project_root();
    let script_path = root.join("scripts").join("dev-cms.mjs");
    let node_bin = find_node_executable();

    log::info!("Starting CMS server child process. root: {:?}, node: {}", root, node_bin);

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&script_path);
    cmd.current_dir(&root);

    // ログファイルへの出力を設定
    let log_path = root.join("cms-gui.log");
    if let Ok(log_file) = File::create(&log_path) {
        if let Ok(err_file) = log_file.try_clone() {
            cmd.stdout(Stdio::from(log_file));
            cmd.stderr(Stdio::from(err_file));
        }
    }

    #[cfg(target_os = "windows")]
    {
        // CREATE_NO_WINDOW (0x08000000) で黒いコマンドプロンプト画面を非表示にする
        cmd.creation_flags(0x08000000);
    }

    match cmd.spawn() {
        Ok(child) => {
            let mut lock = state.cms_child.lock().unwrap();
            *lock = Some(child);
            log::info!("CMS child process spawned successfully");
            Ok(true)
        }
        Err(e) => {
            let err_msg = format!("Failed to spawn {}: {}", node_bin, e);
            log::error!("{}", err_msg);
            Err(err_msg)
        }
    }
}

// フロントエンドからの起動リクエスト
#[tauri::command]
fn ensure_cms_server_running(state: tauri::State<AppState>) -> Result<bool, String> {
    start_cms_process(&state)
}

// フロントエンドからのヘルスチェック
#[tauri::command]
fn check_cms_health(state: tauri::State<AppState>) -> HealthStatus {
    let cms_running = is_port_open(CMS_PORT);

    // CMSサーバーがまだ動いていなければ起動を試みる
    if !cms_running {
        let _ = start_cms_process(&state);
    }

    let astro_running = is_port_open(ASTRO_PORT);

    let (ready, message) = if !cms_running {
        (false, "CMSサーバーを起動しています...".to_string())
    } else if !astro_running {
        (false, "Astro開発サーバーを待機中...".to_string())
    } else {
        (true, "すべてのサーバーが準備完了しました！".to_string())
    };

    HealthStatus {
        cms_running,
        astro_running,
        ready,
        message,
    }
}

// スプラッシュ画面を閉じてメインウィンドウを表示
#[tauri::command]
fn show_main_and_close_splash(app: AppHandle) -> Result<(), String> {
    log::info!("Transitioning from splashscreen to main window...");

    if let Some(main_win) = app.get_webview_window("main") {
        // メインウィンドウを確実に http://localhost:8322 にロード
        let _ = main_win.navigate(tauri::Url::parse("http://localhost:8322").unwrap());
        let _ = main_win.show();
        let _ = main_win.set_focus();
    } else {
        log::warn!("Main window not found");
    }

    if let Some(splash_win) = app.get_webview_window("splashscreen") {
        let _ = splash_win.close();
    }

    Ok(())
}

// アプリケーション終了
#[tauri::command]
fn close_application(app: AppHandle) {
    app.exit(0);
}

// クリーンアップ処理
fn cleanup_child_process(state: &AppState) {
    let mut lock = state.cms_child.lock().unwrap();
    if let Some(mut child) = lock.take() {
        let pid = child.id();
        log::info!("Cleaning up CMS child process with PID: {}", pid);

        #[cfg(target_os = "windows")]
        {
            // Windows環境: 子プロセスツリー全体を確実に終了
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .creation_flags(0x08000000)
                .output();
        }

        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            ensure_cms_server_running,
            check_cms_health,
            show_main_and_close_splash,
            close_application
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // アプリ起動時にRust側から直ちにCMSサーバーを自動起動
            let state = app.state::<AppState>();
            let _ = start_cms_process(&state);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
                log::info!("Application exiting, cleaning up processes...");
                let state = app_handle.state::<AppState>();
                cleanup_child_process(&state);
            }
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                if label == "main" {
                    log::info!("Main window destroyed, exiting app...");
                    let state = app_handle.state::<AppState>();
                    cleanup_child_process(&state);
                    app_handle.exit(0);
                }
            }
            _ => {}
        }
    });
}
