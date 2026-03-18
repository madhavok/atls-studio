use super::*;
pub(crate) const GIT_CMD_TIMEOUT_SECS: u64 = 30;

pub(crate) const GIT_INDEX_LOCK_RETRIES: u32 = 4;

/// Run a git command with timeout, pager/prompt suppression, and async-safe blocking.
/// Prevents hangs from pager, credential prompts, or slow Windows process spawning.
/// Auto-retries with backoff when .git/index.lock contention is detected.
pub(crate) async fn run_git_command(args: Vec<String>, cwd: String) -> Result<std::process::Output, String> {
    let cwd_path = std::path::Path::new(&cwd);
    if cwd.is_empty() {
        return Err("Git working directory is empty".to_string());
    }
    if !cwd_path.exists() || !cwd_path.is_dir() {
        return Err(format!("Git working directory does not exist or is not a directory: {}", cwd));
    }

    // Walk up to find .git — prevents empty-stderr failures on non-repo dirs
    {
        let mut probe = cwd_path.to_path_buf();
        let mut found_git = false;
        loop {
            if probe.join(".git").exists() {
                found_git = true;
                break;
            }
            if !probe.pop() { break; }
        }
        if !found_git {
            return Err(format!(
                "no .git repository found at or above {}. Specify workspace:'name' to target a sub-repo.",
                cwd
            ));
        }
    }

    let mut last_err = String::new();
    for attempt in 0..=GIT_INDEX_LOCK_RETRIES {
        if attempt > 0 {
            let delay_ms = 200 * (1u64 << (attempt - 1).min(3));
            tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        }

        let a = args.clone();
        let c = cwd.clone();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(GIT_CMD_TIMEOUT_SECS),
            tokio::task::spawn_blocking(move || {
                std::process::Command::new("git")
                    .args(&a)
                    .current_dir(&c)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .env("GIT_PAGER", "")
                    .output()
            }),
        )
        .await;

        match result {
            Ok(Ok(Ok(output))) => {
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    if stderr.contains("index.lock") || (stderr.contains("Unable to create") && stderr.contains(".lock")) {
                        last_err = format!("index.lock contention (attempt {}): {}", attempt + 1, stderr.chars().take(200).collect::<String>());
                        eprintln!("[git] {}", last_err);
                        continue;
                    }
                }
                return Ok(output);
            }
            Ok(Ok(Err(e))) => return Err(format!("Failed to run git: {}", e)),
            Ok(Err(e)) => return Err(format!("Git task panicked: {}", e)),
            Err(_) => return Err(format!("Git command timed out after {}s", GIT_CMD_TIMEOUT_SECS)),
        }
    }

    Err(format!("Git index.lock contention after {} retries: {}", GIT_INDEX_LOCK_RETRIES + 1, last_err))
}

/// Run a shell command with timeout, async-safe via spawn_blocking.
/// Mirrors `run_git_command` pattern to avoid blocking the tokio runtime.
pub(crate) async fn run_shell_cmd_async(
    cmd_str: String,
    working_dir: PathBuf,
    timeout_secs: u64,
) -> Result<std::process::Output, String> {
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        tokio::task::spawn_blocking(move || {
            let (shell, shell_arg) = super::resolve_shell();
            let mut cmd = std::process::Command::new(shell);
            cmd.arg(shell_arg)
                .arg(&cmd_str)
                .current_dir(&working_dir)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            #[cfg(windows)]
            cmd.creation_flags(0x08000000);
            cmd.output()
        }),
    )
    .await;

    match result {
        Ok(Ok(Ok(output))) => Ok(output),
        Ok(Ok(Err(e))) => Err(format!("Failed to run command: {}", e)),
        Ok(Err(e)) => Err(format!("Command task panicked: {}", e)),
        Err(_) => Err(format!(
            "Command timed out after {}s. For cold Rust builds \
             (cargo test compiling 80+ crates), set timeout_seconds:300 \
             or higher. Alternatively, use verify type:'typecheck' which \
             is much faster.",
            timeout_secs
        )),
    }
}

/// Filter PowerShell NativeCommandError boilerplate from stderr.
/// PowerShell injects these for ANY non-zero exit from native commands (npm, cargo, etc).
#[cfg(windows)]
pub(crate) fn filter_powershell_stderr(stderr: &str) -> String {
    stderr.lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.contains("NativeCommandError")
                && !trimmed.starts_with("Program '")
                && !trimmed.contains("failed to run:")
                && !trimmed.starts_with("+ CategoryInfo")
                && !trimmed.starts_with("+ FullyQualifiedErrorId")
        })
        .collect::<Vec<&str>>()
        .join("\n")
}

/// Index modified files incrementally after write operations.
/// Emits `index_progress` events so the UI can show scan status.
/// Returns a summary suitable for inclusion in TOON responses.
pub(crate) async fn index_modified_files(
    app: &AppHandle,
    indexer: &tokio::sync::Mutex<atls_core::Indexer>,
    project_root: &std::path::Path,
    files: &[String],
) -> serde_json::Value {
    if files.is_empty() {
        return serde_json::json!(null);
    }

    let total = files.len();
    let _ = app.emit("index_progress", serde_json::json!({
        "phase": "start",
        "total": total,
        "indexed": 0
    }));

    let indexer_guard = indexer.lock().await;
    let mut indexed: Vec<String> = Vec::new();
    let mut index_errors: Vec<serde_json::Value> = Vec::new();

    for (i, file) in files.iter().enumerate() {
        let abs_path = project_root.join(file);
        match indexer_guard.on_file_change(&abs_path).await {
            Ok(()) => indexed.push(file.clone()),
            Err(e) => index_errors.push(serde_json::json!({
                "file": file,
                "error": format!("{}", e)
            })),
        }
        let _ = app.emit("index_progress", serde_json::json!({
            "phase": "indexing",
            "total": total,
            "indexed": i + 1,
            "current_file": file
        }));
    }
    drop(indexer_guard);

    let _ = app.emit("index_progress", serde_json::json!({
        "phase": "done",
        "total": total,
        "indexed": indexed.len()
    }));

    serde_json::json!({
        "files_indexed": indexed.len(),
        "errors": if index_errors.is_empty() { None } else { Some(&index_errors) }
    })
}

/// Index deleted files: remove them from the DB so queries stay accurate.
pub(crate) async fn index_deleted_files(
    app: &AppHandle,
    indexer: &tokio::sync::Mutex<atls_core::Indexer>,
    project_root: &std::path::Path,
    files: &[String],
) -> serde_json::Value {
    if files.is_empty() {
        return serde_json::json!(null);
    }

    let indexer_guard = indexer.lock().await;
    let mut removed = 0usize;
    let mut index_errors: Vec<serde_json::Value> = Vec::new();

    for file in files {
        let abs_path = project_root.join(file);
        match indexer_guard.on_file_delete(&abs_path).await {
            Ok(()) => removed += 1,
            Err(e) => index_errors.push(serde_json::json!({
                "file": file,
                "error": format!("{}", e)
            })),
        }
    }
    drop(indexer_guard);

    let _ = app.emit("index_progress", serde_json::json!({
        "phase": "done",
        "total": files.len(),
        "removed": removed
    }));

    serde_json::json!({
        "removed": removed,
        "errors": if index_errors.is_empty() { None } else { Some(&index_errors) }
    })
}
