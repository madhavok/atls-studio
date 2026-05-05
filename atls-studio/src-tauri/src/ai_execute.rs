use super::*;
use crate::pty::resolve_working_dir;
use serde::{Deserialize, Serialize};

// ============================================================================
// AI Execution API (Structured Output for AI)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiCommandResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
    cwd: String,
    truncated: bool,
}

/// Execute a command with structured output for AI consumption (async, non-blocking)
#[tauri::command]
pub async fn ai_execute(
    app: AppHandle,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<AiCommandResult, String> {
    let working_dir = resolve_working_dir(&app, cwd);
    let working_dir_clone = working_dir.clone();
    let start = Instant::now();
    let timeout_duration = timeout_ms.map(std::time::Duration::from_millis);

    let run_command = async move {
        let (shell, shell_arg) = super::resolve_shell();
        let mut cmd = tokio::process::Command::new(shell);
        cmd.arg(shell_arg)
            .arg(&command)
            .current_dir(&working_dir_clone)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        cmd.output().await
    };

    let output = match timeout_duration {
        Some(duration) => match tokio::time::timeout(duration, run_command).await {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => return Err(format!("Failed to execute command: {}", e)),
            Err(_) => return Err(format!("Command timed out after {}ms", timeout_ms.unwrap_or(0))),
        },
        None => match run_command.await {
            Ok(output) => output,
            Err(e) => return Err(format!("Failed to execute command: {}", e)),
        },
    };
    
    let duration = start.elapsed();
    
    // Limit output size (100KB each for stdout/stderr), strip ANSI escape codes
    const MAX_OUTPUT: usize = 100 * 1024;
    let mut stdout = strip_ansi(&String::from_utf8_lossy(&output.stdout));
    let mut stderr = strip_ansi(&String::from_utf8_lossy(&output.stderr));
    let truncated = stdout.len() > MAX_OUTPUT || stderr.len() > MAX_OUTPUT;
    
    if stdout.len() > MAX_OUTPUT {
        stdout = format!("{}...[truncated]", &stdout[..MAX_OUTPUT]);
    }
    if stderr.len() > MAX_OUTPUT {
        stderr = format!("{}...[truncated]", &stderr[..MAX_OUTPUT]);
    }
    
    Ok(AiCommandResult {
        exit_code: output.status.code().unwrap_or(-1),
        stdout,
        stderr,
        duration_ms: duration.as_millis() as u64,
        cwd: working_dir,
        truncated,
    })
}

// Background process state
pub(crate) struct BackgroundProcess {
    pub(crate) child: std::process::Child,
    pub(crate) output_buffer: Arc<Mutex<Vec<String>>>,
    /// Tracks when the process started for status reporting.
    pub(crate) _start_time: Instant,
}

pub(crate) struct BackgroundState {
    pub(crate) processes: Mutex<HashMap<String, BackgroundProcess>>,
}

impl Default for BackgroundState {
    fn default() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }
}

/// Execute a command in the background (for servers, watchers, etc.)
#[tauri::command]
pub async fn ai_execute_background(
    app: AppHandle,
    command: String,
    cwd: Option<String>,
    id: String,
) -> Result<(), String> {
    use std::process::{Command, Stdio};
    
    let (shell, shell_arg) = super::resolve_shell();
    let working_dir = resolve_working_dir(&app, cwd);
    
    let mut cmd = Command::new(shell);
    cmd.arg(shell_arg)
        .arg(&command)
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to spawn background process: {}", e))?;
    
    let output_buffer = Arc::new(Mutex::new(Vec::new()));
    let buffer_clone = Arc::clone(&output_buffer);
    
    // Read stdout in background
    if let Some(stdout) = child.stdout.take() {
        let buffer = Arc::clone(&buffer_clone);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    buffer.lock().unwrap().push(format!("[stdout] {}", line));
                }
            }
        });
    }
    
    // Read stderr in background
    if let Some(stderr) = child.stderr.take() {
        let buffer = buffer_clone;
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    buffer.lock().unwrap().push(format!("[stderr] {}", line));
                }
            }
        });
    }
    
    let bg_process = BackgroundProcess {
        child,
        output_buffer,
        _start_time: Instant::now(),
    };
    
    let state = app.state::<BackgroundState>();
    state.processes.lock().unwrap().insert(id, bg_process);
    
    Ok(())
}

/// Get output from a background process
#[tauri::command]
pub async fn ai_get_background_output(
    app: AppHandle,
    id: String,
    since_line: Option<usize>,
) -> Result<Vec<String>, String> {
    let state = app.state::<BackgroundState>();
    let processes = state.processes.lock().unwrap();
    
    let process = processes.get(&id)
        .ok_or_else(|| format!("Background process not found: {}", id))?;
    
    let buffer = process.output_buffer.lock().unwrap();
    let start = since_line.unwrap_or(0);
    
    Ok(buffer.iter().skip(start).cloned().collect())
}

/// Kill a background process
#[tauri::command]
pub async fn ai_kill_background(app: AppHandle, id: String) -> Result<i32, String> {
    let state = app.state::<BackgroundState>();
    let mut processes = state.processes.lock().unwrap();
    
    if let Some(mut process) = processes.remove(&id) {
        let _ = process.child.kill();
        let status = process.child.wait()
            .map_err(|e| format!("Failed to wait for process: {}", e))?;
        Ok(status.code().unwrap_or(-1))
    } else {
        Err(format!("Background process not found: {}", id))
    }
}

#[cfg(test)]
mod tests {
    use crate::strip_ansi;

    #[test]
    fn strip_ansi_removes_color_codes() {
        assert_eq!(strip_ansi("\x1b[31merr\x1b[0m"), "err");
    }
}
