// Chat attachment processing commands
use std::path::PathBuf;
use serde_json::json;
use image::DynamicImage;

/// Default max long-edge for compressed chat images. Matches Claude's native
/// tile grid (~1568px) so 1080p screenshots stay lossless and 1440p/4K sources
/// remain readable after downscale. Keeps the per-image vision cost under ~3.3k
/// Anthropic tokens (`ceil(w*h/750)`).
const DEFAULT_MAX_DIMENSION: u32 = 1568;

/// Encode a decoded image with alpha-aware format selection:
/// - Alpha present → WebP lossless (preserves transparency; compresses better than PNG)
/// - Opaque → JPEG q88 (smaller; visually lossless for text/UI)
/// Returns (bytes, media_type).
fn encode_image_alpha_aware(img: &DynamicImage) -> Result<(Vec<u8>, &'static str), String> {
    use std::io::Cursor;

    let has_alpha = img.color().has_alpha();
    let mut buffer = Cursor::new(Vec::new());

    if has_alpha {
        use image::codecs::webp::WebPEncoder;
        let rgba = img.to_rgba8();
        let encoder = WebPEncoder::new_lossless(&mut buffer);
        encoder
            .encode(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|e| format!("Failed to encode WebP: {}", e))?;
        Ok((buffer.into_inner(), "image/webp"))
    } else {
        use image::codecs::jpeg::JpegEncoder;
        let rgb = img.to_rgb8();
        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 88);
        encoder
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
        Ok((buffer.into_inner(), "image/jpeg"))
    }
}

/// Downscale to `max_dim` on the long edge only if the source exceeds it.
/// Aspect ratio preserved. Returns the input unchanged when it already fits.
fn maybe_downscale(img: DynamicImage, max_dim: u32) -> DynamicImage {
    if img.width() > max_dim || img.height() > max_dim {
        img.thumbnail(max_dim, max_dim)
    } else {
        img
    }
}

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

/// Compress a file-backed image and return base64 for chat (token-efficient).
/// Alpha-aware: transparent PNGs round-trip as WebP to preserve transparency.
#[tauri::command]
pub async fn compress_and_read_image(
    path: String,
    max_dimension: Option<u32>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        let p = PathBuf::from(&path);
        if !p.exists() {
            return Err(format!("File does not exist: {}", path));
        }

        let img = image::open(&p)
            .map_err(|e| format!("Failed to open image: {}", e))?;

        let (orig_width, orig_height) = (img.width(), img.height());
        let max_dim = max_dimension.unwrap_or(DEFAULT_MAX_DIMENSION);
        let resized = maybe_downscale(img, max_dim);
        let (resized_w, resized_h) = (resized.width(), resized.height());
        let (bytes, media_type) = encode_image_alpha_aware(&resized)?;
        let base64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let original_bytes = std::fs::metadata(&p)
            .map(|m| m.len() as usize)
            .unwrap_or(0);

        Ok(json!({
            "path": path,
            "base64": format!("data:{};base64,{}", media_type, base64),
            "media_type": media_type,
            "data": base64,
            "original_size": original_bytes,
            "compressed_size": bytes.len(),
            "original_dimensions": { "width": orig_width, "height": orig_height },
            "compressed_dimensions": { "width": resized_w, "height": resized_h },
        }))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Compress raw image bytes (base64-encoded) and return compressed base64 for chat.
/// Used for clipboard paste / HTML5 drag-drop where there is no file path to read.
/// Alpha-aware: transparent images round-trip as WebP to preserve transparency.
#[tauri::command]
pub async fn compress_image_bytes(
    data_base64: String,
    max_dimension: Option<u32>,
) -> Result<serde_json::Value, String> {
    tokio::task::spawn_blocking(move || {
        use base64::Engine;

        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data_base64.as_bytes())
            .map_err(|e| format!("Failed to decode base64 input: {}", e))?;
        let original_bytes = decoded.len();

        // Content-sniffs format; no extension needed. Returns an error for
        // unsupported codecs (HEIC, TIFF without features, corrupt) — the TS
        // layer falls back to a raw data URL in that case.
        let img = image::load_from_memory(&decoded)
            .map_err(|e| format!("Failed to decode image bytes: {}", e))?;

        let (orig_width, orig_height) = (img.width(), img.height());
        let max_dim = max_dimension.unwrap_or(DEFAULT_MAX_DIMENSION);
        let resized = maybe_downscale(img, max_dim);
        let (resized_w, resized_h) = (resized.width(), resized.height());
        let (bytes, media_type) = encode_image_alpha_aware(&resized)?;
        let base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

        Ok(json!({
            "base64": format!("data:{};base64,{}", media_type, base64),
            "media_type": media_type,
            "data": base64,
            "original_size": original_bytes,
            "compressed_size": bytes.len(),
            "original_dimensions": { "width": orig_width, "height": orig_height },
            "compressed_dimensions": { "width": resized_w, "height": resized_h },
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

#[cfg(test)]
mod tests {
    use super::{encode_image_alpha_aware, extract_signatures, maybe_downscale};
    use image::{DynamicImage, RgbImage, RgbaImage};

    #[test]
    fn extract_signatures_rust_collects_pub_fn_and_struct() {
        let src = "pub fn foo() {}\npub struct Bar {}\n";
        let sig = extract_signatures(src, "rust");
        assert!(sig.contains("pub fn foo"));
        assert!(sig.contains("pub struct Bar"));
    }

    #[test]
    fn extract_signatures_typescript_finds_export_function() {
        let src = "export function baz() {}\nconst x = 1;\n";
        let sig = extract_signatures(src, "typescript");
        assert!(sig.contains("export function baz"));
    }

    #[test]
    fn extract_signatures_empty_fallback_first_lines() {
        let lines: Vec<String> = (0..60).map(|i| format!("line {i}")).collect();
        let src = lines.join("\n");
        let sig = extract_signatures(&src, "rust");
        assert!(sig.contains("line 0"));
        assert!(!sig.contains("line 55"));
    }

    #[test]
    fn opaque_image_encodes_as_jpeg() {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(32, 32, image::Rgb([255, 0, 0])));
        let (bytes, media_type) = encode_image_alpha_aware(&img).unwrap();
        assert_eq!(media_type, "image/jpeg");
        assert!(!bytes.is_empty());
        // JPEG magic: FF D8 FF
        assert_eq!(&bytes[..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn alpha_image_encodes_as_webp() {
        let img = DynamicImage::ImageRgba8(RgbaImage::from_pixel(32, 32, image::Rgba([0, 0, 0, 0])));
        let (bytes, media_type) = encode_image_alpha_aware(&img).unwrap();
        assert_eq!(media_type, "image/webp");
        assert!(!bytes.is_empty());
        // WebP magic: RIFF....WEBP
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
    }

    #[test]
    fn downscale_shrinks_only_when_larger() {
        let small = DynamicImage::ImageRgb8(RgbImage::new(100, 100));
        let scaled = maybe_downscale(small, 1568);
        assert_eq!(scaled.width(), 100);
        assert_eq!(scaled.height(), 100);

        let big = DynamicImage::ImageRgb8(RgbImage::new(3840, 2160));
        let scaled = maybe_downscale(big, 1568);
        assert!(scaled.width() <= 1568);
        assert!(scaled.height() <= 1568);
        // Aspect ratio ≈ preserved (16:9)
        let ratio = scaled.width() as f32 / scaled.height() as f32;
        assert!((ratio - 16.0 / 9.0).abs() < 0.05);
    }
}
