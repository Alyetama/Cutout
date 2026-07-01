// Prevents an extra console window on Windows in release. Harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Result of processing one image, sent back to the frontend.
#[derive(Serialize)]
struct ProcessResult {
    input_path: String,
    /// Full-resolution transparent PNG written to disk (the final output).
    saved_path: String,
    /// Small data-URL preview of the original (for the queue card).
    before_preview: String,
    /// Small data-URL preview of the cut-out result (for the queue card).
    after_preview: String,
}

/// Sources for the touch-up editor, as base64 PNG data URLs. Data URLs are
/// same-origin, so they don't taint the editor's canvas (unlike asset URLs).
#[derive(Serialize)]
struct EditSources {
    /// Full-resolution original (source for the "restore" brush).
    original: String,
    /// Full-resolution cut-out result (the saved output).
    result: String,
}

const PREVIEW_MAX_DIM: u32 = 1100;

// ---------------------------------------------------------------------------
// Helper-binary plumbing
// ---------------------------------------------------------------------------

/// Locate the bundled Swift Vision helper, with a dev-mode fallback.
fn helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(res) = app.path().resource_dir() {
        for cand in [
            "vision-bg-remove",
            "binaries/vision-bg-remove",
            "_up_/binaries/vision-bg-remove",
        ] {
            let p = res.join(cand);
            if p.exists() {
                return Ok(p);
            }
        }
    }
    // Running under `tauri dev`: fall back to the compiled binary in the repo.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries/vision-bg-remove");
    if dev.exists() {
        return Ok(dev);
    }
    Err("Background-removal helper is missing from the app bundle.".into())
}

/// Run the helper with the given arguments, mapping its exit codes to
/// user-facing error messages.
fn run_helper(app: &AppHandle, args: &[&str]) -> Result<(), String> {
    let bin = helper_path(app)?;
    let output = Command::new(&bin)
        .args(args)
        .output()
        .map_err(|e| format!("Could not launch the helper: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let msg = match output.status.code() {
        Some(3) => "No clear subject was detected in this image.".to_string(),
        Some(4) => "This image couldn't be read (unsupported or corrupt file).".to_string(),
        _ if !stderr.is_empty() => stderr,
        Some(code) => format!("Background removal failed (exit {code})."),
        None => "The helper was terminated before it finished.".to_string(),
    };
    Err(msg)
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A per-run scratch directory for previews and editor sources.
fn scratch_dir() -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("cutout-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create temp dir: {e}"))?;
    Ok(dir)
}

fn unique_temp(ext: &str) -> Result<PathBuf, String> {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(scratch_dir()?.join(format!("tmp-{t}-{n}.{ext}")))
}

/// Default output path: alongside the original as `<stem>-nobg.png`, unless an
/// explicit destination directory is given.
fn output_path_for(input: &str, output_dir: Option<&str>) -> Result<PathBuf, String> {
    let input = Path::new(input);
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Invalid input filename.".to_string())?;
    let file_name = format!("{stem}-nobg.png");
    let dir = match output_dir {
        Some(d) => PathBuf::from(d),
        None => input
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from(".")),
    };
    Ok(dir.join(file_name))
}

fn read_as_data_url(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read preview: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn process_image(
    app: AppHandle,
    input_path: String,
    output_dir: Option<String>,
) -> Result<ProcessResult, String> {
    // Everything below is blocking (subprocess + file IO); keep it off the
    // async runtime's worker so a big batch never freezes the UI.
    tauri::async_runtime::spawn_blocking(move || {
        let saved = output_path_for(&input_path, output_dir.as_deref())?;
        if let Some(parent) = saved.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create output folder: {e}"))?;
        }
        let saved_str = saved.to_string_lossy().to_string();

        // 1. The actual background removal (full resolution).
        run_helper(&app, &["remove", &input_path, &saved_str])?;

        // 2. Small previews for the queue card (before + after).
        let before_small = unique_temp("png")?;
        let after_small = unique_temp("png")?;
        run_helper(
            &app,
            &[
                "topng",
                &input_path,
                &before_small.to_string_lossy(),
                &PREVIEW_MAX_DIM.to_string(),
            ],
        )?;
        run_helper(
            &app,
            &[
                "topng",
                &saved_str,
                &after_small.to_string_lossy(),
                &PREVIEW_MAX_DIM.to_string(),
            ],
        )?;

        let result = ProcessResult {
            input_path,
            saved_path: saved_str,
            before_preview: read_as_data_url(&before_small)?,
            after_preview: read_as_data_url(&after_small)?,
        };
        let _ = std::fs::remove_file(&before_small);
        let _ = std::fs::remove_file(&after_small);
        Ok(result)
    })
    .await
    .map_err(|e| format!("Processing task failed: {e}"))?
}

/// Prepare full-resolution sources for the touch-up editor as data URLs.
#[tauri::command]
async fn prepare_edit(
    app: AppHandle,
    input_path: String,
    saved_path: String,
) -> Result<EditSources, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let original_png = unique_temp("png")?;
        run_helper(&app, &["topng", &input_path, &original_png.to_string_lossy()])?;
        let original = read_as_data_url(&original_png)?;
        let _ = std::fs::remove_file(&original_png);
        let result = read_as_data_url(Path::new(&saved_path))?;
        Ok(EditSources { original, result })
    })
    .await
    .map_err(|e| format!("Editor prep failed: {e}"))?
}

/// Copy an already-produced result to a user-chosen location ("Save As…").
#[tauri::command]
fn save_as(src_path: String, dest_path: String) -> Result<(), String> {
    std::fs::copy(&src_path, &dest_path).map_err(|e| format!("Could not save file: {e}"))?;
    Ok(())
}

/// Write raw PNG bytes (base64, possibly a data URL) to disk — used by the
/// touch-up editor to persist an edited cut-out.
#[tauri::command]
fn save_png_bytes(dest_path: String, data_base64: String) -> Result<(), String> {
    let payload = data_base64
        .split_once(",")
        .map(|(_, b)| b)
        .unwrap_or(&data_base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("Invalid image data: {e}"))?;
    std::fs::write(&dest_path, bytes).map_err(|e| format!("Could not save file: {e}"))?;
    Ok(())
}

/// Reveal a file in Finder.
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("/usr/bin/open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| format!("Could not open Finder: {e}"))?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            process_image,
            prepare_edit,
            save_as,
            save_png_bytes,
            reveal_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cutout");
}
