use super::*;

// ============================================================================
// PTY Terminal Commands (Human Interactive Terminal)
// ============================================================================

/// Returns `Some` when `cwd` is non-empty (explicit working directory from the UI).
pub(crate) fn explicit_terminal_cwd(cwd: Option<String>) -> Option<String> {
    cwd.filter(|d| !d.is_empty())
}

/// Resolve the working directory for a terminal/command.
/// Priority: explicit cwd > project root from AtlsProjectState > std::env::current_dir()
pub(crate) fn resolve_working_dir(app: &AppHandle, cwd: Option<String>) -> String {
    if let Some(dir) = explicit_terminal_cwd(cwd) {
        return dir;
    }
    // Try to get the project root from ATLS state (non-async, use try_lock).
    if let Some(state) = app.try_state::<AtlsProjectState>() {
        if let Ok(guard) = state.roots.try_lock() {
            let ar = state.active_root.read().ok().and_then(|a| a.clone());
            if let Ok((project, _)) = resolve_project(&guard, &ar, None) {
                return project.root_path().to_string_lossy().to_string();
            }
        }
    }
    std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::explicit_terminal_cwd;

    #[test]
    fn explicit_cwd_none_or_empty_means_unset() {
        assert_eq!(explicit_terminal_cwd(None), None);
        assert_eq!(explicit_terminal_cwd(Some(String::new())), None);
    }

    #[test]
    fn explicit_cwd_returns_nonempty() {
        assert_eq!(
            explicit_terminal_cwd(Some("/tmp/proj".into())),
            Some("/tmp/proj".into())
        );
    }
}

/// Spawn a new PTY terminal instance
#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    id: String,
    cwd: Option<String>,
    shell: Option<String>,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;
    
    let shell_cmd = shell.unwrap_or_else(|| super::resolve_shell_exe());
    
    let working_dir = resolve_working_dir(&app, cwd);
    
    let mut cmd = CommandBuilder::new(&shell_cmd);
    cmd.cwd(&working_dir);
    
    // Set up environment
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    
    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;
    
    // Get reader for PTY output
    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;
    
    // Take writer once and store it (can only be called once)
    let writer = pair.master.take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {}", e))?;
    
    let shell_pid = child.process_id();
    let child = Arc::new(Mutex::new(child));
    let child_for_reader = Arc::clone(&child);

    let pty_instance = PtyInstance {
        master: pair.master,
        writer,
        child,
        shell_pid,
        _cwd: working_dir,
    };
    
    // Store PTY in state
    let state = app.state::<PtyState>();
    state.terminals.lock().unwrap().insert(id.clone(), pty_instance);
    
    // Spawn reader thread that coalesces rapid output into batched events,
    // preventing Tauri event-loop saturation on high-throughput commands.
    let app_clone = app.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        use std::io::Read as _;

        let event_name = format!("pty-output-{}", id_clone);
        let exit_event = format!("pty-exit-{}", id_clone);

        let mut buf = [0u8; 8192];
        let mut pending = String::new();
        let mut last_emit = Instant::now();
        const COALESCE_MS: u128 = 8;
        const MAX_PENDING: usize = 32_768;

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.push_str(&String::from_utf8_lossy(&buf[..n]));
                    let elapsed = last_emit.elapsed().as_millis();
                    if elapsed >= COALESCE_MS || pending.len() >= MAX_PENDING {
                        let _ = app_clone.emit(&event_name, std::mem::take(&mut pending));
                        last_emit = Instant::now();
                    }
                }
                Err(_) => break,
            }
        }
        // Flush any remaining buffered output before signalling exit
        if !pending.is_empty() {
            let _ = app_clone.emit(&event_name, pending);
        }

        // Wait for the child and determine success/failure
        let success: bool = child_for_reader.lock().ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.success())
            .unwrap_or(false);
        let _ = app_clone.emit(&exit_event, success);
    });
    
    Ok(())
}

/// Write data to PTY (user input)
#[tauri::command]
pub async fn write_pty(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut terminals = state.terminals.lock().unwrap();
    
    let pty = terminals.get_mut(&id)
        .ok_or_else(|| format!("PTY not found: {}", id))?;
    
    // Use the stored writer (taken once at spawn time)
    pty.writer.write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write to PTY: {}", e))?;
    
    // Flush to ensure data is sent immediately
    pty.writer.flush()
        .map_err(|e| format!("Failed to flush PTY: {}", e))?;
    
    Ok(())
}

/// Resize PTY terminal
#[tauri::command]
pub async fn resize_pty(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut terminals = state.terminals.lock().unwrap();
    
    let pty = terminals.get_mut(&id)
        .ok_or_else(|| format!("PTY not found: {}", id))?;
    
    pty.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }).map_err(|e| format!("Failed to resize PTY: {}", e))?;
    
    Ok(())
}

/// Check whether the shell has an active child process (i.e. a command is running).
///
/// - Windows: walks the process table via CreateToolhelp32Snapshot looking for
///   any process whose parent PID matches the shell.
/// - Unix: compares the PTY foreground process group leader to the shell PID.
#[tauri::command]
pub async fn is_pty_busy(app: AppHandle, id: String) -> Result<bool, String> {
    let state = app.state::<PtyState>();

    // Extract what we need under the lock, then drop it before doing real work.
    #[cfg(unix)]
    let (shell_pid, pgid) = {
        let terminals = state.terminals.lock().unwrap();
        let pty = terminals.get(&id)
            .ok_or_else(|| format!("PTY not found: {}", id))?;
        let shell_pid = match pty.shell_pid {
            Some(pid) => pid,
            None => return Ok(false),
        };
        let pgid = pty.master.process_group_leader();
        (shell_pid, pgid)
    };

    #[cfg(windows)]
    let shell_pid = {
        let terminals = state.terminals.lock().unwrap();
        let pty = terminals.get(&id)
            .ok_or_else(|| format!("PTY not found: {}", id))?;
        match pty.shell_pid {
            Some(pid) => pid,
            None => return Ok(false),
        }
    };

    #[cfg(windows)]
    {
        return is_busy_windows(shell_pid);
    }

    #[cfg(unix)]
    {
        return is_busy_unix_from_pgid(pgid, shell_pid);
    }

    #[cfg(not(any(windows, unix)))]
    {
        Ok(false)
    }
}

#[cfg(windows)]
fn is_busy_windows(shell_pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err("CreateToolhelp32Snapshot failed".into());
        }

        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

        if Process32FirstW(snap, &mut entry) == 0 {
            CloseHandle(snap);
            return Ok(false);
        }

        loop {
            if entry.th32ParentProcessID == shell_pid {
                CloseHandle(snap);
                return Ok(true);
            }
            if Process32NextW(snap, &mut entry) == 0 {
                break;
            }
        }

        CloseHandle(snap);
    }

    Ok(false)
}

#[cfg(unix)]
fn is_busy_unix_from_pgid(pgid: Option<i32>, shell_pid: u32) -> Result<bool, String> {
    match pgid {
        Some(pgid) if pgid > 0 && pgid as u32 != shell_pid => Ok(true),
        _ => Ok(false),
    }
}

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

/// Write a UTF-8 (with BOM) temp `.ps1` for agent exec; returns absolute path.
/// Caller runs `& 'path'` in the PTY and deletes the file when done.
#[tauri::command]
pub async fn write_agent_exec_ps1(content: String) -> Result<String, String> {
    let dir = std::env::temp_dir();
    let id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let path = dir.join(format!("atls-agent-exec-{id}.ps1"));
    let mut bytes: Vec<u8> = Vec::with_capacity(UTF8_BOM.len() + content.len());
    bytes.extend_from_slice(UTF8_BOM);
    bytes.extend_from_slice(content.as_bytes());
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn remove_temp_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if p.exists() {
        std::fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kill PTY terminal, reaping the child process to prevent zombies and FD leaks.
#[tauri::command]
pub async fn kill_pty(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<PtyState>();

    // Remove under the lock but release the lock before blocking on shutdown
    // so other PTY commands aren't stalled.
    let removed = {
        let mut terminals = state.terminals.lock().unwrap();
        terminals.remove(&id)
    };

    if let Some(mut pty) = removed {
        // Perform shutdown off the lock -- kill + reap child, drop FDs.
        tokio::task::spawn_blocking(move || pty.shutdown()).await
            .map_err(|e| format!("PTY shutdown join error: {}", e))?;
    }

    Ok(())
}
