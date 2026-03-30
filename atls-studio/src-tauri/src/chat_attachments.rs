// Chat attachment processing commands
use std::path::PathBuf;
use serde_json::json;

/// Read file and extract signatures for chat display (token-efficient)
#[tauri::command]
pub async fn read_file_signatures(path: String) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("File does not exist: {}", path));
        }

        let content = std::fs::read_to_string(&p)
            .map_err(|e| format!("Failed to read file: {}", e))?;

        // Detect language from extension
        let ext = p.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let lang = match ext {
            "rs" => "rust",
            "ts" | "tsx" => "typescript",
            "js" | "jsx" => "javascript",
            "py" => "python",
            "go" => "go",
            "java" => "java",
            "cpp" | "cc" | "cxx" => "cpp",
            "c" | "h" => "c",
            "cs" => "csharp",
            "swift" => "swift",
            _ => "text",
        };

        // Extract signatures (simplified - just function/class declarations)
        let signatures = if lang != "text" {
            extract_signatures(&content, lang)
        } else {
            content.clone()
        };

        Ok(json!({
            "path": path,
            "language": lang,
            "signatures": signatures,
            "full_content": content,
            "lines": content.lines().count(),
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Compress image and return base64 for chat (token-efficient)
#[tauri::command]
pub async fn compress_and_read_image(
    path: String,
    max_dimension: Option<u32>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        use image::ImageFormat;
        use std::io::Cursor;

        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("File does not exist: {}", path));
        }

        // Load image
        let img = image::open(&p)
            .map_err(|e| format!("Failed to open image: {}", e))?;

        let (orig_width, orig_height) = (img.width(), img.height());
        let max_dim = max_dimension.unwrap_or(1024);

        // Resize if needed
        let resized = if orig_width > max_dim || orig_height > max_dim {
            img.thumbnail(max_dim, max_dim)
        } else {
            img
        };

        // Convert to JPEG with quality 85
        let mut buffer = Cursor::new(Vec::new());
        resized
            .write_to(&mut buffer, ImageFormat::Jpeg)
            .map_err(|e| format!("Failed to encode image: {}", e))?;

        let bytes = buffer.into_inner();
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let original_bytes = std::fs::metadata(&p)
            .map(|m| m.len() as usize)
            .unwrap_or(0);

        Ok(json!({
            "path": path,
            "base64": format!("data:image/jpeg;base64,{}", base64),
            "media_type": "image/jpeg",
            "data": base64,
            "original_size": original_bytes,
            "compressed_size": bytes.len(),
            "original_dimensions": { "width": orig_width, "height": orig_height },
            "compressed_dimensions": { "width": resized.width(), "height": resized.height() },
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

fn extract_signatures(content: &str, lang: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let mut signatures = Vec::new();

    for line in lines {
        let trimmed = line.trim();
        
        // Simple signature detection (can be enhanced)
        let is_sig = match lang {
            "rust" => trimmed.starts_with("pub fn ") || trimmed.starts_with("fn ") ||
                      trimmed.starts_with("pub struct ") || trimmed.starts_with("struct ") ||
                      trimmed.starts_with("pub enum ") || trimmed.starts_with("enum ") ||
                      trimmed.starts_with("pub trait ") || trimmed.starts_with("trait "),
            "typescript" | "javascript" => 
                trimmed.starts_with("export function ") || trimmed.starts_with("function ") ||
                trimmed.starts_with("export class ") || trimmed.starts_with("class ") ||
                trimmed.starts_with("export interface ") || trimmed.starts_with("interface ") ||
                trimmed.starts_with("export const ") || trimmed.starts_with("const ") ||
                trimmed.starts_with("export type ") || trimmed.starts_with("type "),
            "python" => trimmed.starts_with("def ") || trimmed.starts_with("class ") ||
                       trimmed.starts_with("async def "),
            "go" => trimmed.starts_with("func ") || trimmed.starts_with("type ") ||
                   trimmed.starts_with("interface "),
            "java" | "csharp" | "cpp" | "c" | "swift" => 
                trimmed.contains("class ") || trimmed.contains("interface ") ||
                trimmed.contains("struct ") || trimmed.contains("enum ") ||
                (trimmed.contains('(') && trimmed.contains(')')),
            _ => false,
        };

        if is_sig {
            signatures.push(line);
        }
    }

    if signatures.is_empty() {
        // Fallback: return first 50 lines
        content.lines().take(50).collect::<Vec<_>>().join("\n")
    } else {
        signatures.join("\n")
    }
}
