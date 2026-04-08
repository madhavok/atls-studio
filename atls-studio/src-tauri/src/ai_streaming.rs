use super::*;

// ============================================================================
// AI Chat Streaming (bypasses browser CORS)
// ============================================================================

/// Convert a single content block's images from Anthropic to OpenAI format.
/// Uses image_url (Chat Completions API) — for Responses API use convert_block_for_responses_api.
pub(crate) fn convert_image_block_for_openai(block: &serde_json::Value) -> serde_json::Value {
    if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
        if block_type == "image" {
            if let Some(source) = block.get("source") {
                let media_type = source.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png");
                let data = source.get("data").and_then(|d| d.as_str()).unwrap_or("");
                return serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", media_type, data)
                    }
                });
            }
        }
    }
    block.clone()
}

/// Convert a content block to OpenAI Responses API format.
/// User/developer text uses `input_text`; assistant prior-turn text uses `output_text` (required by the API).
/// Images use `input_image` (not image_url). See: https://developers.openai.com/api/docs/guides/images-vision
pub(crate) fn convert_block_for_responses_api(block: &serde_json::Value, role: &str) -> serde_json::Value {
    let boundary = "<<PRIOR_TURN_BOUNDARY>>";
    let staged_boundary = "<<STAGED_CONTEXT_BOUNDARY>>";
    if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
        match block_type {
            "text" => {
                let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("")
                    .replace(boundary, "").replace(staged_boundary, "");
                let content_type = if role == "assistant" { "output_text" } else { "input_text" };
                return serde_json::json!({ "type": content_type, "text": text });
            }
            "image" => {
                if let Some(source) = block.get("source") {
                    let media_type = source.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png");
                    let data = source.get("data").and_then(|d| d.as_str()).unwrap_or("");
                    return serde_json::json!({
                        "type": "input_image",
                        "image_url": format!("data:{};base64,{}", media_type, data)
                    });
                }
            }
            _ => {}
        }
    }
    block.clone()
}

/// Strip cache boundary markers from a JSON content value (for non-Anthropic providers).
/// Handles both BP3 (PRIOR_TURN_BOUNDARY) and BP4 (STAGED_CONTEXT_BOUNDARY) markers.
pub(crate) fn strip_boundary_markers(content: &serde_json::Value) -> serde_json::Value {
    let markers = ["<<PRIOR_TURN_BOUNDARY>>", "<<STAGED_CONTEXT_BOUNDARY>>"];
    match content {
        serde_json::Value::String(s) => {
            let mut result = s.clone();
            for m in &markers { result = result.replace(m, ""); }
            serde_json::Value::String(result)
        }
        serde_json::Value::Array(blocks) => {
            serde_json::Value::Array(blocks.iter().map(|block| {
                let mut b = block.clone();
                if let Some(mut text) = b.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()) {
                    for m in &markers { text = text.replace(m, ""); }
                    b["text"] = serde_json::json!(text);
                }
                if let Some(mut content) = b.get("content").and_then(|c| c.as_str()).map(|s| s.to_string()) {
                    for m in &markers { content = content.replace(m, ""); }
                    b["content"] = serde_json::json!(content);
                }
                b
            }).collect())
        }
        other => other.clone(),
    }
}

/// Convert Anthropic-format conversation history to OpenAI message format.
/// Handles tool_use -> tool_calls (message-level) and tool_result -> role:"tool" messages.
pub(crate) fn convert_messages_for_openai(messages: &[ChatMessage], system_prompt: Option<&str>) -> Vec<serde_json::Value> {
    let mut result: Vec<serde_json::Value> = Vec::new();

    if let Some(system) = system_prompt {
        // Strip cache markers (Anthropic-specific); OpenAI auto-caches by prefix stability
        let cleaned = system.replace("\n<<CACHE_BREAK>>\n", "\n\n");
        result.push(serde_json::json!({ "role": "system", "content": cleaned }));
    }

    for msg in messages.iter().filter(|m| m.role != "system") {
        match &msg.content {
            serde_json::Value::Array(blocks) => {
                let has_tool_use = blocks.iter().any(|b|
                    b.get("type").and_then(|t| t.as_str()) == Some("tool_use"));
                let has_tool_result = blocks.iter().any(|b|
                    b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));

                if msg.role == "assistant" && has_tool_use {
                    // Extract text content and tool_calls separately
                    let mut text_parts: Vec<String> = Vec::new();
                    let mut tool_calls: Vec<serde_json::Value> = Vec::new();

                    for block in blocks {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                    if !t.is_empty() { text_parts.push(t.to_string()); }
                                }
                            }
                            Some("tool_use") => {
                                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                let name = block.get("name")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or("atls");
                                let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                                let args_str = serde_json::to_string(&input).unwrap_or_default();
                                tool_calls.push(serde_json::json!({
                                    "id": id,
                                    "type": "function",
                                    "function": { "name": name, "arguments": args_str }
                                }));
                            }
                            _ => {}
                        }
                    }

                    let content_val = if text_parts.is_empty() {
                        serde_json::Value::Null
                    } else {
                        serde_json::Value::String(text_parts.join("\n"))
                    };

                    let mut assistant_msg = serde_json::json!({
                        "role": "assistant",
                        "content": content_val,
                    });
                    if !tool_calls.is_empty() {
                        assistant_msg["tool_calls"] = serde_json::json!(tool_calls);
                    }
                    result.push(assistant_msg);
                } else if msg.role == "user" && has_tool_result {
                    // Expand tool_result blocks into separate role:"tool" messages
                    let boundary = "<<PRIOR_TURN_BOUNDARY>>";
                    let staged_boundary = "<<STAGED_CONTEXT_BOUNDARY>>";
                    for block in blocks {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                            let tool_call_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                            let content_str = block.get("content").and_then(|c| c.as_str()).unwrap_or("").replace(boundary, "").replace(staged_boundary, "");
                            result.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_call_id,
                                "content": content_str,
                            }));
                        } else if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                let clean = t.replace(boundary, "").replace(staged_boundary, "");
                                if !clean.is_empty() {
                                    result.push(serde_json::json!({ "role": "user", "content": clean }));
                                }
                            }
                        }
                    }
                } else {
                    // Regular array content (images, text) - convert images only
                    let converted: Vec<serde_json::Value> = blocks.iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) != Some("tool_use")
                                  && b.get("type").and_then(|t| t.as_str()) != Some("tool_result"))
                        .map(|b| convert_image_block_for_openai(b))
                        .collect();
                    if !converted.is_empty() {
                        result.push(serde_json::json!({
                            "role": msg.role,
                            "content": converted,
                        }));
                    }
                }
            }
            _ => {
                result.push(serde_json::json!({
                    "role": msg.role,
                    "content": strip_boundary_markers(&msg.content),
                }));
            }
        }
    }

    result
}

/// Convert messages to OpenAI Responses API input items.
/// The Responses API uses a flat list of typed items instead of role-based messages:
/// - text messages → {"type":"message", "role":"...", "content":"..."}
/// - assistant tool calls → {"type":"function_call", "name":"...", "arguments":"...", "call_id":"...", "id":"..."}
/// - tool results → {"type":"function_call_output", "call_id":"...", "output":"..."}
pub(crate) fn convert_messages_for_responses_api(messages: &[ChatMessage], system_prompt: Option<&str>) -> Vec<serde_json::Value> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    let boundary = "<<PRIOR_TURN_BOUNDARY>>";
    let staged_boundary = "<<STAGED_CONTEXT_BOUNDARY>>";

    if let Some(system) = system_prompt {
        let cleaned = system.replace("\n<<CACHE_BREAK>>\n", "\n\n");
        items.push(serde_json::json!({
            "type": "message",
            "role": "developer",
            "content": cleaned
        }));
    }

    for msg in messages.iter().filter(|m| m.role != "system") {
        match &msg.content {
            serde_json::Value::Array(blocks) => {
                let has_tool_use = blocks.iter().any(|b|
                    b.get("type").and_then(|t| t.as_str()) == Some("tool_use"));
                let has_tool_result = blocks.iter().any(|b|
                    b.get("type").and_then(|t| t.as_str()) == Some("tool_result"));

                if msg.role == "assistant" && has_tool_use {
                    let mut text_parts: Vec<String> = Vec::new();
                    for block in blocks {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") => {
                                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                    if !t.is_empty() { text_parts.push(t.to_string()); }
                                }
                            }
                            Some("tool_use") => {
                                // Emit any accumulated text first
                                if !text_parts.is_empty() {
                                    items.push(serde_json::json!({
                                        "type": "message",
                                        "role": "assistant",
                                        "content": text_parts.join("\n")
                                    }));
                                    text_parts.clear();
                                }
                                let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("");
                                let name = block.get("name")
                                    .and_then(|v| v.as_str())
                                    .filter(|s| !s.is_empty())
                                    .unwrap_or("atls");
                                let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                                let args_str = serde_json::to_string(&input).unwrap_or_default();
                                items.push(serde_json::json!({
                                    "type": "function_call",
                                    "id": format!("fc_{}", id),
                                    "call_id": id,
                                    "name": name,
                                    "arguments": args_str
                                }));
                            }
                            _ => {}
                        }
                    }
                    if !text_parts.is_empty() {
                        items.push(serde_json::json!({
                            "type": "message",
                            "role": "assistant",
                            "content": text_parts.join("\n")
                        }));
                    }
                } else if msg.role == "user" && has_tool_result {
                    for block in blocks {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                            let call_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                            let content_str = block.get("content").and_then(|c| c.as_str()).unwrap_or("")
                                .replace(boundary, "").replace(staged_boundary, "");
                            items.push(serde_json::json!({
                                "type": "function_call_output",
                                "call_id": call_id,
                                "output": content_str
                            }));
                        } else if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                let clean = t.replace(boundary, "").replace(staged_boundary, "");
                                if !clean.is_empty() {
                                    items.push(serde_json::json!({
                                        "type": "message",
                                        "role": "user",
                                        "content": clean
                                    }));
                                }
                            }
                        }
                    }
                } else {
                    let converted: Vec<serde_json::Value> = blocks.iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) != Some("tool_use")
                                  && b.get("type").and_then(|t| t.as_str()) != Some("tool_result"))
                        .map(|b| convert_block_for_responses_api(b, msg.role.as_str()))
                        .collect();
                    if !converted.is_empty() {
                        items.push(serde_json::json!({
                            "type": "message",
                            "role": msg.role,
                            "content": converted
                        }));
                    }
                }
            }
            _ => {
                let clean = strip_boundary_markers(&msg.content);
                let content_str = clean.as_str().unwrap_or("");
                if !content_str.is_empty() {
                    items.push(serde_json::json!({
                        "type": "message",
                        "role": msg.role,
                        "content": content_str
                    }));
                }
            }
        }
    }

    items
}

/// Build `reasoning` for OpenAI Responses API. Raw reasoning tokens are not exposed;
/// always request [`summary: "auto"`](https://platform.openai.com/docs/guides/reasoning) whenever
/// we send `reasoning` so streamed `response.reasoning_summary_text.delta` (and output items)
/// include a readable summary. Reasoning token cost is driven by `effort`; the summary is the
/// API-supported way to surface what you paid for in the UI.
pub(crate) fn reasoning_body_for_responses_api(effort: &str) -> serde_json::Value {
    serde_json::json!({
        "effort": effort,
        "summary": "auto"
    })
}

/// Convert multimodal content to Google Gemini parts format.
/// Handles text, image, and Anthropic-format tool_use/tool_result blocks.
/// Strips both BP3 and BP4 boundary markers.
pub(crate) fn convert_content_for_google(content: &serde_json::Value) -> Vec<serde_json::Value> {
    let boundary = "<<PRIOR_TURN_BOUNDARY>>";
    let staged_boundary = "<<STAGED_CONTEXT_BOUNDARY>>";
    match content {
        serde_json::Value::String(text) => vec![serde_json::json!({"text": text.replace(boundary, "").replace(staged_boundary, "")})],
        serde_json::Value::Array(blocks) => {
            blocks.iter().map(|block| {
                if let Some(block_type) = block.get("type").and_then(|t| t.as_str()) {
                    match block_type {
                        "text" => {
                            let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("").replace(boundary, "").replace(staged_boundary, "");
                            serde_json::json!({"text": text})
                        }
                        "image" => {
                            if let Some(source) = block.get("source") {
                                let media_type = source.get("media_type").and_then(|m| m.as_str()).unwrap_or("image/png");
                                let data = source.get("data").and_then(|d| d.as_str()).unwrap_or("");
                                serde_json::json!({
                                    "inlineData": {
                                        "mimeType": media_type,
                                        "data": data
                                    }
                                })
                            } else {
                                block.clone()
                            }
                        }
                        "tool_use" => {
                            let name = block.get("name")
                                .and_then(|n| n.as_str())
                                .filter(|s| !s.is_empty())
                                .unwrap_or("atls");
                            let args = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                            let mut part = serde_json::json!({
                                "functionCall": { "name": name, "args": args }
                            });
                            // Gemini 3+ requires thoughtSignature on functionCall parts for multi-turn.
                            if let Some(sig) = block.get("thoughtSignature").and_then(|s| s.as_str()) {
                                part["thoughtSignature"] = serde_json::json!(sig);
                            }
                            part
                        }
                        "tool_result" => {
                            let explicit_name = block.get("name").and_then(|n| n.as_str());
                            let tool_use_id = block.get("tool_use_id").and_then(|v| v.as_str()).unwrap_or("");
                            // Resolve name: explicit > lookup from sibling tool_use by id > fallback
                            let name = explicit_name.unwrap_or_else(|| {
                                blocks.iter().find(|b| {
                                    b.get("type").and_then(|t| t.as_str()) == Some("tool_use")
                                        && b.get("id").and_then(|i| i.as_str()) == Some(tool_use_id)
                                }).and_then(|b| b.get("name").and_then(|n| n.as_str())).unwrap_or("atls")
                            });
                            let content_str = block.get("content").and_then(|c| c.as_str()).unwrap_or("").replace(boundary, "").replace(staged_boundary, "");
                            serde_json::json!({
                                "functionResponse": {
                                    "name": name,
                                    "response": { "content": content_str }
                                }
                            })
                        }
                        _ => block.clone(),
                    }
                } else {
                    block.clone()
                }
            }).collect()
        }
        _ => vec![serde_json::json!({"text": content.to_string()})],
    }
}

// Gemini 3+ thought signature compatibility: dummy value for old messages without real signatures.
// base64("skip_thought_signature_validator") — recognized by the API as a bypass token.
pub(crate) const DUMMY_THOUGHT_SIGNATURE: &str = "c2tpcF90aG91Z2h0X3NpZ25hdHVyZV92YWxpZGF0b3I=";

/// Returns true if the model name indicates Gemini 3+ (requires thought signatures).
pub(crate) fn is_gemini3_model(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("gemini-3") || m.contains("gemini3")
}

/// Inject dummy thoughtSignature on functionCall parts that lack one (Gemini 3+ compatibility).
pub(crate) fn inject_dummy_thought_signatures(contents: &mut Vec<serde_json::Value>) {
    for msg in contents.iter_mut() {
        if let Some(parts) = msg.get_mut("parts").and_then(|p| p.as_array_mut()) {
            for part in parts.iter_mut() {
                if part.get("functionCall").is_some() && part.get("thoughtSignature").is_none() {
                    part["thoughtSignature"] = serde_json::json!(DUMMY_THOUGHT_SIGNATURE);
                }
            }
        }
    }
}

/// Log Gemini contents summary for debugging context issues.
pub(crate) fn log_gemini_contents_summary(label: &str, contents: &[serde_json::Value], cached: bool) {
    let mut roles: Vec<&str> = Vec::new();
    let mut total_chars: usize = 0;
    for msg in contents {
        let role = msg.get("role").and_then(|r| r.as_str()).unwrap_or("?");
        roles.push(role);
        if let Some(parts) = msg.get("parts").and_then(|p| p.as_array()) {
            for part in parts {
                if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                    total_chars += t.len();
                }
                if let Some(fc) = part.get("functionCall") {
                    total_chars += fc.to_string().len();
                }
                if let Some(fr) = part.get("functionResponse") {
                    total_chars += fr.to_string().len();
                }
            }
        }
    }
    let role_seq: String = roles.iter().map(|r| if *r == "user" { "u" } else { "m" }).collect::<Vec<_>>().join(",");
    eprintln!(
        "[{}] msgs={} roles=[{}] ~{}k tokens cached={}",
        label, contents.len(), role_seq, total_chars / 4000, cached
    );
}

/// Validate Gemini contents: alternating roles, starts with user, ends with user.
pub(crate) fn validate_gemini_contents(label: &str, contents: &[serde_json::Value]) {
    if contents.is_empty() { return; }
    let first_role = contents.first().and_then(|m| m.get("role")).and_then(|r| r.as_str()).unwrap_or("");
    let last_role = contents.last().and_then(|m| m.get("role")).and_then(|r| r.as_str()).unwrap_or("");
    if first_role != "user" {
        eprintln!("[{}] WARNING: first message role is '{}', expected 'user'", label, first_role);
    }
    if last_role != "user" {
        eprintln!("[{}] WARNING: last message role is '{}', expected 'user'", label, last_role);
    }
    for i in 1..contents.len() {
        let prev = contents[i-1].get("role").and_then(|r| r.as_str()).unwrap_or("");
        let curr = contents[i].get("role").and_then(|r| r.as_str()).unwrap_or("");
        if prev == curr {
            eprintln!("[{}] WARNING: consecutive same role '{}' at indices {}-{}", label, curr, i-1, i);
        }
    }
}

// Rate limiting constants
pub(crate) const MAX_RETRIES: u32 = 5;
pub(crate) const INITIAL_RETRY_DELAY_MS: u64 = 2000;
pub(crate) const MAX_RETRY_DELAY_MS: u64 = 120_000;

/// Parse retry delay from API response body (supports Google, OpenAI, Anthropic formats).
pub(crate) fn parse_retry_delay_from_body(body: &str) -> Option<u64> {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
        // Google: { "error": { "details": [{ "@type": "...RetryInfo", "retryDelay": "48s" }] } }
        if let Some(details) = json.pointer("/error/details") {
            if let Some(arr) = details.as_array() {
                for detail in arr {
                    if let Some(delay_str) = detail.get("retryDelay").and_then(|d| d.as_str()) {
                        let secs: f64 = delay_str
                            .trim_end_matches('s')
                            .parse()
                            .unwrap_or(0.0);
                        if secs > 0.0 {
                            return Some((secs * 1000.0) as u64);
                        }
                    }
                }
            }
        }
        // OpenAI / Anthropic: check "Retry-After" style hints in message text
        if let Some(msg) = json.pointer("/error/message").and_then(|m| m.as_str()) {
            if let Some(idx) = msg.find("Please retry after ") {
                let after = &msg[idx + 19..];
                if let Some(end) = after.find('s') {
                    if let Ok(secs) = after[..end].trim().parse::<f64>() {
                        return Some((secs * 1000.0) as u64);
                    }
                }
            }
        }
    }
    None
}

/// Retry helper with exponential backoff for rate limit (429) and server (5xx) errors.
/// Emits `StreamChunk::Status` to notify the frontend when retrying.
pub(crate) async fn retry_with_backoff<F, Fut, T>(
    max_retries: u32,
    app: Option<&AppHandle>,
    stream_id: Option<&str>,
    operation: F,
) -> Result<T, String>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T, (reqwest::StatusCode, String)>>,
{
    use crate::stream_protocol::{emit_chunk, StreamChunk};
    let mut retry_count = 0;
    let mut delay_ms = INITIAL_RETRY_DELAY_MS;
    
    loop {
        match operation().await {
            Ok(result) => return Ok(result),
            Err((status, body)) => {
                let should_retry = status == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || status.is_server_error();
                
                if !should_retry || retry_count >= max_retries {
                    return Err(format!("API error {}: {}", status, body));
                }
                
                let wait_ms = if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                    parse_retry_delay_from_body(&body)
                        .map(|d| d.min(MAX_RETRY_DELAY_MS))
                        .unwrap_or(delay_ms)
                } else {
                    delay_ms
                };
                
                let wait_secs = (wait_ms as f64 / 1000.0).ceil() as u64;
                let status_msg = format!(
                    "Rate limited — retrying in {}s (attempt {}/{})",
                    wait_secs, retry_count + 1, max_retries
                );
                eprintln!("[ATLS] {}", status_msg);
                
                if let (Some(a), Some(sid)) = (app, stream_id) {
                    emit_chunk(a, sid, StreamChunk::Status { message: status_msg });
                }
                
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                
                // Clear status after wait
                if let (Some(a), Some(sid)) = (app, stream_id) {
                    emit_chunk(a, sid, StreamChunk::Status { message: String::new() });
                }
                
                retry_count += 1;
                delay_ms = (delay_ms * 2).min(MAX_RETRY_DELAY_MS);
            }
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    /// String for text-only, or array of content blocks for multimodal
    pub content: serde_json::Value,
}

// ATLS Tools - Unified tool definitions for all providers
// Minimal schema, AI learns from system prompt (TOON format)

/// Tool definition structure (provider-agnostic)
pub(crate) struct ToolDef {
    name: &'static str,
    description: &'static str,
    parameters: serde_json::Value,
}

/// Convert JS/TOON object literal syntax to valid JSON by quoting unquoted keys.
/// Handles: {tool:"x",params:{a:1}} -> {"tool":"x","params":{"a":1}}
pub(crate) fn js_object_to_json(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut result = String::with_capacity(input.len() + 32);
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                // Copy quoted string verbatim
                result.push('"');
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' && i + 1 < bytes.len() {
                        result.push(bytes[i] as char);
                        i += 1;
                        result.push(bytes[i] as char);
                        i += 1;
                    } else {
                        result.push(bytes[i] as char);
                        i += 1;
                    }
                }
                if i < bytes.len() {
                    result.push('"');
                    i += 1;
                }
            }
            b'\'' => {
                // Convert single-quoted string to double-quoted
                result.push('"');
                i += 1;
                while i < bytes.len() && bytes[i] != b'\'' {
                    if bytes[i] == b'"' {
                        result.push_str("\\\""); // Escape double quotes inside
                    } else if bytes[i] == b'\\' {
                        // Handle escapes
                        if i + 1 < bytes.len() {
                            if bytes[i+1] == b'\'' {
                                // Escaped single quote \' -> '
                                result.push('\'');
                                i += 2;
                                continue;
                            }
                        }
                        result.push(bytes[i] as char);
                        i += 1;
                        if i < bytes.len() {
                            result.push(bytes[i] as char);
                        }
                    } else {
                        result.push(bytes[i] as char);
                    }
                    i += 1;
                }
                if i < bytes.len() {
                    result.push('"');
                    i += 1;
                }
            }
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                // Identifier: check if followed by `:` (unquoted key)
                let start = i;
                while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                    i += 1;
                }
                let ident = &input[start..i];
                // Skip whitespace to check for colon
                let mut j = i;
                while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\n' || bytes[j] == b'\r' || bytes[j] == b'\t') { j += 1; }
                if j < bytes.len() && bytes[j] == b':' {
                    // Unquoted key - add quotes
                    result.push('"');
                    result.push_str(ident);
                    result.push('"');
                } else {
                    // Bare identifier as value (true/false/null) - keep as-is
                    result.push_str(ident);
                }
            }
            b',' => {
                // Check if trailing comma
                let mut j = i + 1;
                while j < bytes.len() && (bytes[j] == b' ' || bytes[j] == b'\n' || bytes[j] == b'\r' || bytes[j] == b'\t') { j += 1; }
                if j < bytes.len() && (bytes[j] == b'}' || bytes[j] == b']') {
                    // It's a trailing comma, skip it
                    i += 1;
                } else {
                    result.push(',');
                    i += 1;
                }
            }
            _ => {
                result.push(bytes[i] as char);
                i += 1;
            }
        }
    }
    result
}

/// Extract text-based tool calls (`batch(...)`, `manage(...)`, `task_complete(...)`)
/// that Gemini may output as text instead of using native functionCall.
/// Returns (remaining_text, extracted_tool_calls).
/// Handles both strict JSON and JS/TOON object literal syntax (unquoted keys).
/// Strip status markers in both guillemet-wrapped («st:...») and loose (st:...) forms.
/// Gemini/Vertex models often drop the opening « character.
pub(crate) fn strip_status_markers(s: &str) -> String {
    use std::sync::OnceLock;
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(
        r"\u{00AB}?st:\s*(?:working|done)(?:\|[^\n\u{00BB}]*)?\u{00BB}?\s*"
    ).unwrap());
    re.replace_all(s, "").to_string()
}

/// Normalize {"name": "...", "args": {...}} format into {"tool": "...", "params": {...}}.
/// Gemini 3.x models sometimes emit tool calls in this OpenAI-like array format
/// instead of the expected batch({...}) / manage({...}) / task_complete({...}) wrapper.
pub(crate) fn normalize_name_args_to_tool_params(item: &serde_json::Value) -> Option<serde_json::Value> {
    let name = item.get("name").and_then(|n| n.as_str())?;
    let args = item.get("args").cloned().unwrap_or(serde_json::json!({}));

    Some(serde_json::json!({
        "tool": name,
        "params": args
    }))
}

pub(crate) fn extract_text_tool_calls(text: &str) -> (String, Vec<serde_json::Value>) {
    let mut calls: Vec<serde_json::Value> = Vec::new();
    let mut remaining = String::new();
    let mut pos = 0;

    use std::sync::OnceLock;

    // Regex to match text-emitted tool wrappers with optional whitespace
    static TOOL_RE: OnceLock<Regex> = OnceLock::new();
    let tool_re = TOOL_RE.get_or_init(|| Regex::new(r"(manage|task_complete|batch)\s*\(").unwrap());

    // Regex to find JSON code blocks: ```json { ... } ``` or ```javascript manage(...) ```
    static JSON_BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    let json_block_re = JSON_BLOCK_RE.get_or_init(|| Regex::new(r"```(?:json|javascript|js)?\s*([\s\S]*?)\s*```").unwrap());

    // First pass: extract JSON code blocks (skip if no backticks — avoids regex scan)
    let mut text_without_json_blocks = text.to_string();
    if text.contains("```") {
        for cap in json_block_re.captures_iter(text) {
        if let Some(block_content) = cap.get(1) {
            // Strip single-line comments (// ...) before parsing
            let stripped: String = block_content.as_str()
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            let trimmed = stripped.trim();
            
            // Determine what we're looking at and extract the JSON portion
            let (json_string, is_wrapper, is_array): (String, bool, bool) = if trimmed.ends_with(")") && (trimmed.starts_with("task_complete") || trimmed.starts_with("batch")) {
                if let Some(start) = trimmed.find('(') {
                    let end = trimmed.len() - 1;
                    (trimmed[start+1..end].to_string(), true, false)
                } else {
                    continue;
                }
            } else if trimmed.starts_with("{") && trimmed.ends_with("}") {
                (trimmed.to_string(), false, false)
            } else if trimmed.starts_with("[") && trimmed.ends_with("]") {
                (trimmed.to_string(), false, true)
            } else if trimmed.starts_with("task_complete") || trimmed.starts_with("batch") {
                // Handle cases where code block contains just the command without parens or with complex spacing
                // e.g. batch({ ... })
                if let Some(start) = trimmed.find('(') {
                    if let Some(end) = trimmed.rfind(')') {
                        (trimmed[start+1..end].to_string(), true, false)
                    } else {
                        continue;
                    }
                } else {
                    continue;
                }
            } else {
                continue;
            };

            // Try strict JSON first, then JS object literal conversion
            let parsed = serde_json::from_str::<serde_json::Value>(&json_string)
                .or_else(|_| {
                    let fixed = js_object_to_json(&json_string);
                    serde_json::from_str::<serde_json::Value>(&fixed)
                });

            if let Ok(mut val) = parsed {
                if is_array {
                    // Handle array of tool calls: [{"name": "exec", "args": {...}}, ...]
                    if let Some(arr) = val.as_array() {
                        let mut any_extracted = false;
                        for item in arr {
                            if let Some(tc) = normalize_name_args_to_tool_params(item) {
                                calls.push(tc);
                                any_extracted = true;
                            }
                        }
                        if any_extracted {
                            text_without_json_blocks = text_without_json_blocks.replace(cap.get(0).unwrap().as_str(), "");
                        }
                    }
                } else {
                    // Try name/args single-object format first: {"name": "manage", "args": {...}}
                    if let Some(tc) = normalize_name_args_to_tool_params(&val) {
                        calls.push(tc);
                        text_without_json_blocks = text_without_json_blocks.replace(cap.get(0).unwrap().as_str(), "");
                    } else {
                        // Handle manage shorthand: {ops:[...]} -> {tool:"manage", params:{ops:[...]}}
                        if val.get("ops").is_some() && val.get("tool").is_none() {
                             val = serde_json::json!({
                                "tool": "manage",
                                "params": val
                            });
                        }

                        // If it was a manage()/batch()/task_complete() wrapper, ensure it's treated as a tool call
                        if is_wrapper && val.get("tool").is_none() {
                             let tool_name = if trimmed.starts_with("manage") { "manage" } else if trimmed.starts_with("task_complete") { "task_complete" } else if trimmed.starts_with("batch") { "batch" } else { "batch" };
                             val = serde_json::json!({
                                "tool": tool_name,
                                "params": val
                             });
                        }

                        if val.get("tool").is_some() {
                            calls.push(val);
                            text_without_json_blocks = text_without_json_blocks.replace(cap.get(0).unwrap().as_str(), "");
                        }
                    }
                }
            }
        }
    }
    }
    
    // Use the cleaned text for the rest of the processing
    let text = &*text_without_json_blocks;
    let bytes = text.as_bytes();

    while pos < bytes.len() {
        if let Some(mat) = tool_re.find(&text[pos..]) {
            let start = mat.start();
            let match_str = mat.as_str();
            let match_len = mat.end(); 
            let abs_start = pos + start;
            
            // Add text before this call, stripping status markers
            let pre = strip_status_markers(&text[pos..abs_start]);
            remaining.push_str(&pre);

            // Find matching closing paren
            let paren_start = abs_start + match_len; 
            let mut depth = 1i32;
            let mut i = paren_start;
            while i < bytes.len() && depth > 0 {
                match bytes[i] {
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    b'"' => {
                        i += 1;
                        while i < bytes.len() && bytes[i] != b'"' {
                            if bytes[i] == b'\\' { i += 1; }
                            i += 1;
                        }
                    }
                    b'\'' => {
                        i += 1;
                        while i < bytes.len() && bytes[i] != b'\'' {
                            if bytes[i] == b'\\' { i += 1; }
                            i += 1;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }

            if depth == 0 {
                let raw = &text[paren_start..i - 1];
                let is_manage = match_str.contains("manage");
                
                // Parse the content
                let parsed = serde_json::from_str::<serde_json::Value>(raw)
                    .or_else(|_| {
                        let fixed = js_object_to_json(raw);
                        serde_json::from_str::<serde_json::Value>(&fixed)
                    });

                if let Ok(mut val) = parsed {
                    if is_manage {
                        val = serde_json::json!({
                            "tool": "manage",
                            "params": val
                        });
                    } else if match_str.contains("task_complete") {
                        val = serde_json::json!({
                            "tool": "task_complete",
                            "params": val
                        });
                    } else if match_str.contains("batch") {
                        val = serde_json::json!({
                            "tool": "batch",
                            "params": val
                        });
                    }

                    if val.get("tool").is_some() {
                        calls.push(val);
                        pos = i;
                        // Skip trailing whitespace/newlines/status markers
                        while pos < bytes.len() {
                            if bytes[pos] == b'\n' || bytes[pos] == b'\r' || bytes[pos] == b' ' {
                                pos += 1;
                            } else if text[pos..].starts_with("\u{00AB}")
                                   || text[pos..].starts_with("st:") {
                                static SKIP_RE: OnceLock<Regex> = OnceLock::new();
                                let re = SKIP_RE.get_or_init(|| Regex::new(
                                    r"^\u{00AB}?st:\s*(?:working|done)(?:\|[^\n\u{00BB}]*)?\u{00BB}?\s*"
                                ).unwrap());
                                
                                if let Some(m) = re.find(&text[pos..]) {
                                    pos += m.end();
                                } else {
                                    if let Some(nl) = text[pos..].find('\n') {
                                        pos += nl;
                                    } else {
                                        pos = bytes.len();
                                    }
                                }
                            } else {
                                break;
                            }
                        }
                        continue;
                    }
                }
                remaining.push_str(&text[abs_start..i]);
                pos = i;
            } else {
                remaining.push_str(&text[abs_start..]);
                pos = bytes.len();
            }
        } else {
            remaining.push_str(&text[pos..]);
            break;
        }
    }

    // Strip any remaining status markers (both «...» and loose forms)
    remaining = strip_status_markers(&remaining);
    let trimmed = remaining.trim();
    if trimmed.is_empty() {
        remaining.clear();
    }

    (remaining, calls)
}

/// Get unified ATLS tool definitions
pub(crate) fn get_tool_definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "task_complete",
            description: "Signal that the task is fully complete. MUST be called when finished with all work.",
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "summary": { "type": "string", "description": "Brief summary of what was accomplished" },
                    "files_changed": { 
                        "type": "array", 
                        "items": { "type": "string" },
                        "description": "List of files that were modified"
                    }
                },
                "required": ["summary", "files_changed"]
            }),
        },
        ToolDef {
            name: "batch",
            description: "Unified ATLS batch execution. Provide either (1) line-per-step text in `q`, or (2) structured `version` + `steps` JSON (same shape the app uses for Anthropic).",
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "version": {
                        "type": "string",
                        "description": "Batch protocol version (e.g. 1.0). Use with structured `steps`."
                    },
                    "steps": {
                        "type": "array",
                        "description": "Structured steps: [{ id, use, with?, ... }]. Preferred for OpenAI/Gemini JSON tool calls.",
                        "items": { "type": "object" }
                    },
                    "q": {
                        "type": "string",
                        "description": "Line-per-step batch: one step per line (ID USE key:val ...). Alternative to version+steps."
                    }
                }
            }),
        },
    ]
}

/// Recursively sanitize a JSON Schema for Gemini compatibility.
/// Gemini does not support `"const"` — replace with single-value `"enum"`.
fn sanitize_schema_for_gemini(schema: &serde_json::Value) -> serde_json::Value {
    match schema {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if k == "const" {
                    out.insert("enum".to_string(), serde_json::json!([v]));
                } else {
                    out.insert(k.clone(), sanitize_schema_for_gemini(v));
                }
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(sanitize_schema_for_gemini).collect())
        }
        other => other.clone(),
    }
}

// P0 #5: Tool schema caching — tool definitions are static; build once per provider
pub(crate) static CACHED_TOOLS_ANTHROPIC: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
pub(crate) static CACHED_TOOLS_OPENAI: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
pub(crate) static CACHED_TOOLS_GOOGLE: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();

pub(crate) fn build_atls_tools_for_provider(provider: &str) -> serde_json::Value {
    let tools = get_tool_definitions();
    match provider {
        "anthropic" => {
            let mut tool_array: Vec<serde_json::Value> = tools.iter().map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters
                })
            }).collect();
            if let Some(last) = tool_array.last_mut() {
                last["cache_control"] = serde_json::json!({"type": "ephemeral"});
            }
            serde_json::json!(tool_array)
        }
        "openai" => serde_json::json!(tools.iter().map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters
                }
            })
        }).collect::<Vec<_>>()),
        "google" => serde_json::json!([{
            "functionDeclarations": tools.iter().map(|t| {
                serde_json::json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": sanitize_schema_for_gemini(&t.parameters)
                })
            }).collect::<Vec<_>>()
        }]),
        _ => serde_json::json!([])
    }
}

/// Get tools formatted for specific provider (cached — P0 #5).
/// Supports: `anthropic`, `openai`, `google` (case-insensitive), plus aliases **`vertex` → Gemini format**
/// and **`lmstudio` → OpenAI format** so BP2 / [`count_tool_def_tokens`](crate::tokenizer::count_tool_def_tokens_inner)
/// match the shapes used by `stream_chat_vertex` / `stream_chat_lmstudio`.
pub(crate) fn get_atls_tools(provider: &str) -> serde_json::Value {
    let lower = provider.to_lowercase();
    let key = match lower.as_str() {
        "vertex" => "google",
        "lmstudio" => "openai",
        other => other,
    };
    match key {
        "anthropic" => CACHED_TOOLS_ANTHROPIC.get_or_init(|| build_atls_tools_for_provider("anthropic")).clone(),
        "openai" => CACHED_TOOLS_OPENAI.get_or_init(|| build_atls_tools_for_provider("openai")).clone(),
        "google" => CACHED_TOOLS_GOOGLE.get_or_init(|| build_atls_tools_for_provider("google")).clone(),
        _ => serde_json::json!([]),
    }
}

/// Estimate token count for tool definitions (for CacheCompositionSection BP2).
#[tauri::command]
pub fn estimate_tool_def_tokens(provider: String) -> u32 {
    let tools = get_atls_tools(&provider);
    let s = tools.to_string();
    ((s.len() as f64) / 3.5).ceil() as u32
}

/// Cancel an active chat stream by stream_id.
/// Aborts the background tokio task and emits chat-done so the frontend unblocks.
#[tauri::command]
pub async fn cancel_chat_stream(
    app: AppHandle,
    stream_id: String,
) -> Result<(), String> {
    let state = app.state::<ChatStreamState>();
    let mut handles = state.handles.lock().await;
    if let Some(handle) = handles.remove(&stream_id) {
        handle.abort();
        let _ = stream_protocol::emit_chunk(&app, &stream_id, stream_protocol::StreamChunk::Done);
        eprintln!("[ChatStream] Cancelled stream {}", stream_id);
    }
    Ok(())
}

/// Cancel ALL active chat streams (used on hard stop).
#[tauri::command]
pub async fn cancel_all_chat_streams(
    app: AppHandle,
) -> Result<(), String> {
    let state = app.state::<ChatStreamState>();
    let mut handles = state.handles.lock().await;
    for (id, handle) in handles.drain() {
        handle.abort();
        let _ = stream_protocol::emit_chunk(&app, &id, stream_protocol::StreamChunk::Done);
        eprintln!("[ChatStream] Cancelled stream {}", id);
    }
    Ok(())
}

/// Stream chat response from Anthropic Claude
#[tauri::command]
pub async fn stream_chat_anthropic(
    app: AppHandle,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
    system_prompt: Option<String>,
    stream_id: String,
    enable_tools: Option<bool>,
    anthropic_beta: Option<Vec<String>>,
    thinking_budget: Option<u32>,
) -> Result<(), String> {
    let stream_state = app.state::<ChatStreamState>();
    let client = reqwest::Client::new();
    
    // Convert messages to Anthropic format with BP3 cache breakpoint
    let boundary_marker = "<<PRIOR_TURN_BOUNDARY>>";
    let mut anthropic_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| serde_json::json!({
            "role": m.role,
            "content": m.content,
        }))
        .collect();

    // Anthropic rejects extra fields on content blocks.
    // Strip non-standard keys so stored conversation history doesn't cause 400s.
    for msg in anthropic_messages.iter_mut() {
        if let Some(serde_json::Value::Array(blocks)) = msg.get_mut("content") {
            for block in blocks.iter_mut() {
                if let Some(obj) = block.as_object_mut() {
                    match obj.get("type").and_then(|t| t.as_str()) {
                        Some("tool_result") => { obj.remove("name"); }
                        Some("tool_use") => { obj.remove("thoughtSignature"); }
                        _ => {}
                    }
                }
            }
        }
    }

    // BP3: Find the PRIOR_TURN_BOUNDARY marker in messages, strip it,
    // and add cache_control to that content block. This caches all prior
    // turns so they're read from cache on subsequent tool loop rounds.
    for msg in anthropic_messages.iter_mut() {
        if let Some(content) = msg.get_mut("content") {
            let found = match content {
                serde_json::Value::String(s) if s.ends_with(boundary_marker) => {
                    s.truncate(s.len() - boundary_marker.len());
                    true
                }
                serde_json::Value::Array(blocks) => {
                    let mut found_in_block = false;
                    for block in blocks.iter_mut() {
                        // Check text blocks
                        if let Some(text) = block.get_mut("text").and_then(|t| t.as_str().map(|s| s.to_string())).filter(|s| s.ends_with(boundary_marker)) {
                            let clean = &text[..text.len() - boundary_marker.len()];
                            block["text"] = serde_json::json!(clean);
                            block["cache_control"] = serde_json::json!({"type": "ephemeral"});
                            found_in_block = true;
                            break;
                        }
                        // Check tool_result content blocks
                        if let Some(text) = block.get_mut("content").and_then(|c| c.as_str().map(|s| s.to_string())).filter(|s| s.ends_with(boundary_marker)) {
                            let clean = &text[..text.len() - boundary_marker.len()];
                            block["content"] = serde_json::json!(clean);
                            block["cache_control"] = serde_json::json!({"type": "ephemeral"});
                            found_in_block = true;
                            break;
                        }
                    }
                    found_in_block
                }
                _ => false,
            };
            if found {
                break; // Only one BP3 marker per request
            }
        }
    }

    // BP4: Find the STAGED_CONTEXT_BOUNDARY marker, strip it,
    // and add cache_control to that content block. This caches PRIMER +
    // staged snippets so they're read from cache on subsequent rounds.
    let staged_marker = "<<STAGED_CONTEXT_BOUNDARY>>";
    for msg in anthropic_messages.iter_mut() {
        if let Some(content) = msg.get_mut("content") {
            let found = match content {
                serde_json::Value::String(s) if s.ends_with(staged_marker) => {
                    s.truncate(s.len() - staged_marker.len());
                    true
                }
                serde_json::Value::Array(blocks) => {
                    let mut found_in_block = false;
                    for block in blocks.iter_mut() {
                        if let Some(text) = block.get_mut("text").and_then(|t| t.as_str().map(|s| s.to_string())).filter(|s| s.ends_with(staged_marker)) {
                            let clean = &text[..text.len() - staged_marker.len()];
                            block["text"] = serde_json::json!(clean);
                            block["cache_control"] = serde_json::json!({"type": "ephemeral"});
                            found_in_block = true;
                            break;
                        }
                    }
                    found_in_block
                }
                _ => false,
            };
            if found {
                // For string content (not array blocks), wrap into a text block with cache_control
                if content.is_string() {
                    let text_val = content.as_str().unwrap_or("").to_string();
                    *content = serde_json::json!([{
                        "type": "text",
                        "text": text_val,
                        "cache_control": { "type": "ephemeral" }
                    }]);
                }
                break; // Only one BP4 marker per request
            }
        }
    }
    
    // System prompt — no separate cache_control here. The single cache
    // breakpoint lives on the last tool definition, so system + tools are
    // cached as one prefix block. This avoids wasting a breakpoint slot and
    // guarantees the combined block clears the minimum token threshold.
    let raw_system = system_prompt.unwrap_or_else(|| "You are an AI assistant in ATLS Studio.".to_string());
    let system_value = serde_json::json!([{
        "type": "text",
        "text": raw_system
    }]);

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system_value,
        "messages": anthropic_messages,
        "stream": true,
    });

    // Anthropic thinking is incompatible with temperature/top_k modifications.
    // When thinking is active, omit temperature so the API uses its default;
    // otherwise pass the user's manual temperature value through.
    let thinking_active = thinking_budget
        .filter(|&b| b >= 1024 && b < max_tokens)
        .is_some();

    if thinking_active {
        body["thinking"] = serde_json::json!({
            "type": "enabled",
            "budget_tokens": thinking_budget.unwrap()
        });
    } else {
        body["temperature"] = serde_json::json!(temperature);
    }
    
    // Add tools if enabled
    if enable_tools.unwrap_or(true) {
        body["tools"] = get_atls_tools("anthropic");
    }
    
    // Use retry helper for rate limit handling
    let body_str = body.to_string();
    let anthropic_beta_header = anthropic_beta
        .filter(|v| !v.is_empty())
        .map(|v| v.join(","));
    let response = retry_with_backoff(MAX_RETRIES, Some(&app), Some(&stream_id), || {
        let client = client.clone();
        let api_key = api_key.clone();
        let body_str = body_str.clone();
        let beta_header = anthropic_beta_header.clone();
        async move {
            let mut req = client
                .post("https://api.anthropic.com/v1/messages")
                .header("Content-Type", "application/json")
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01");
            if let Some(ref h) = beta_header {
                req = req.header("anthropic-beta", h.as_str());
            }
            let resp = req
                .body(body_str)
                .send()
                .await
                .map_err(|e| (reqwest::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err((status, body));
            }
            
            Ok(resp)
        }
    }).await?;
    
    // Stream the response (track handle for cancellation)
    let app_clone = app.clone();
    let stream_id_clone = stream_id.clone();
    let stream_id_cleanup = stream_id.clone();
    let app_cleanup = app.clone();
    
    let handle = tokio::spawn(async move {
        use futures::StreamExt;
        use crate::stream_protocol::*;
        
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut block_counter: u32 = 0;
        
        let mut text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
        let mut reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
        
        // Track current tool call being streamed (Anthropic sends tool_use incrementally)
        let mut pending_tool_id: Option<String> = None;
        let mut pending_tool_name: Option<String> = None;
        let mut pending_tool_args = String::new();
        // Track current content block type by index
        let mut current_block_type: Option<String> = None;
        
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    
                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].to_string();
                        buffer = buffer[newline_pos + 1..].to_string();
                        
                        if line.starts_with("data: ") {
                            let data = &line[6..];
                            if data == "[DONE]" {
                                text_batcher.close(&app_clone, &stream_id_clone);
                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                                return;
                            }
                            
                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(event_type) = event.get("type").and_then(|t| t.as_str()) {
                                    match event_type {
                                        "content_block_start" => {
                                            if let Some(content_block) = event.get("content_block") {
                                                let block_type = content_block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                                current_block_type = Some(block_type.to_string());
                                                match block_type {
                                                    "tool_use" => {
                                                        // Close any open text/reasoning block before tool
                                                        text_batcher.close(&app_clone, &stream_id_clone);
                                                        reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                        let id = content_block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                        let name = content_block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputStart {
                                                            tool_call_id: id.clone(),
                                                            tool_name: name.clone(),
                                                        });
                                                        pending_tool_id = Some(id);
                                                        pending_tool_name = Some(name);
                                                        pending_tool_args.clear();
                                                    }
                                                    "thinking" => {
                                                        // Close text before reasoning
                                                        text_batcher.close(&app_clone, &stream_id_clone);
                                                        // ReasoningBatcher auto-starts on first push
                                                        if reasoning_batcher.started() {
                                                            reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                            reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
                                                        }
                                                    }
                                                    "text" => {
                                                        // Close reasoning before text
                                                        reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                        if text_batcher.started() {
                                                            text_batcher.close(&app_clone, &stream_id_clone);
                                                            text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                        }
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        }
                                        "content_block_delta" => {
                                            if let Some(delta) = event.get("delta") {
                                                let delta_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                                                match delta_type {
                                                    "text_delta" => {
                                                        if let Some(text) = delta.get("text").and_then(|t| t.as_str()) {
                                                            text_batcher.push(text, &app_clone, &stream_id_clone);
                                                        }
                                                    }
                                                    "thinking_delta" => {
                                                        if let Some(thinking) = delta.get("thinking").and_then(|t| t.as_str()) {
                                                            reasoning_batcher.push(thinking, &app_clone, &stream_id_clone);
                                                        }
                                                    }
                                                    "input_json_delta" => {
                                                        if let Some(partial_json) = delta.get("partial_json").and_then(|t| t.as_str()) {
                                                            pending_tool_args.push_str(partial_json);
                                                            if let Some(ref id) = pending_tool_id {
                                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputDelta {
                                                                    tool_call_id: id.clone(),
                                                                    input_text_delta: partial_json.to_string(),
                                                                });
                                                            }
                                                        }
                                                    }
                                                    _ => {}
                                                }
                                            }
                                        }
                                        "content_block_stop" => {
                                            // Finalize the current block based on its type
                                            if let Some(ref bt) = current_block_type {
                                                match bt.as_str() {
                                                    "tool_use" => {
                                                        if let (Some(id), Some(name)) = (pending_tool_id.take(), pending_tool_name.take()) {
                                                            let input = serde_json::from_str::<serde_json::Value>(&pending_tool_args)
                                                                .unwrap_or(serde_json::json!({}));
                                                            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                                                                tool_call_id: id,
                                                                tool_name: name,
                                                                input,
                                                                thought_signature: None,
                                                            });
                                                            pending_tool_args.clear();
                                                        }
                                                    }
                                                    "thinking" => {
                                                        reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                        reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
                                                    }
                                                    "text" => {
                                                        text_batcher.close(&app_clone, &stream_id_clone);
                                                        text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                    }
                                                    _ => {}
                                                }
                                            }
                                            current_block_type = None;
                                        }
                                        "message_start" => {
                                            if let Some(usage) = event.get("message").and_then(|m| m.get("usage")) {
                                                let input_tok = usage.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                                let cache_creation = usage.get("cache_creation_input_tokens").and_then(|v| v.as_i64());
                                                let cache_read = usage.get("cache_read_input_tokens").and_then(|v| v.as_i64());
                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Usage {
                                                    input_tokens: input_tok,
                                                    output_tokens: 0,
                                                    cache_creation_input_tokens: cache_creation,
                                                    cache_read_input_tokens: cache_read,
                                                    openai_cached_tokens: None,
                                                    cached_content_tokens: None,
                                                });
                                            }
                                        }
                                        "message_delta" => {
                                            if let Some(usage) = event.get("usage") {
                                                let output_tok = usage.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Usage {
                                                    input_tokens: 0,
                                                    output_tokens: output_tok,
                                                    cache_creation_input_tokens: None,
                                                    cache_read_input_tokens: None,
                                                    openai_cached_tokens: None,
                                                    cached_content_tokens: None,
                                                });
                                            }
                                            if let Some(delta) = event.get("delta") {
                                                if let Some(stop_reason) = delta.get("stop_reason").and_then(|s| s.as_str()) {
                                                    let normalized = match stop_reason {
                                                        "end_turn" | "stop_sequence" => "end_turn",
                                                        "max_tokens" => "max_tokens",
                                                        "tool_use" => "tool_use",
                                                        other => other,
                                                    };
                                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::StopReason {
                                                        reason: normalized.to_string(),
                                                    });
                                                }
                                            }
                                        }
                                        "message_stop" => {
                                            text_batcher.close(&app_clone, &stream_id_clone);
                                            reasoning_batcher.close(&app_clone, &stream_id_clone);
                                            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                                            return;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Error {
                        error_text: e.to_string(),
                    });
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                    return;
                }
            }
        }
        
        text_batcher.close(&app_clone, &stream_id_clone);
        reasoning_batcher.close(&app_clone, &stream_id_clone);
        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
    });
    
    {
        let mut handles = stream_state.handles.lock().await;
        handles.insert(stream_id.clone(), handle);
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = app_cleanup.state::<ChatStreamState>();
            let handles = state.handles.lock().await;
            if let Some(h) = handles.get(&stream_id_cleanup) {
                if h.is_finished() {
                    drop(handles);
                    app_cleanup.state::<ChatStreamState>().handles.lock().await.remove(&stream_id_cleanup);
                    break;
                }
            } else {
                break;
            }
        }
    });
    
    Ok(())
}

/// Models that use Responses API (v1/responses). Includes:
/// - Responses-only: o1-pro, o3-pro, o3-deep-research, o4-mini-deep-research, computer-use-preview,
///   gpt-5-codex, gpt-5-pro (per API reference ResponsesOnlyModel)
/// - Reasoning models o1/o3/o4/gpt-5: also routed here for compatibility (some accounts get
///   "only supported in v1/responses" when using Chat Completions; both APIs work for these).
pub(crate) fn openai_model_requires_responses_api(model_id: &str) -> bool {
    model_id.starts_with("o1")
        || model_id.starts_with("o3")
        || model_id.starts_with("o4")
        || model_id.starts_with("gpt-5")
        || model_id.contains("deep-research")
        || model_id.starts_with("computer-use")
}

/// Tools in Responses API format: { type: "function", name, parameters, strict, description }
pub(crate) fn get_atls_tools_responses() -> serde_json::Value {
    let tools = get_tool_definitions();
    serde_json::json!(tools.iter().map(|t| {
        serde_json::json!({
            "type": "function",
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
            "strict": false
        })
    }).collect::<Vec<_>>())
}

/// Stream response from OpenAI Responses API (v1/responses). Used for Responses-only models.
pub(crate) async fn stream_responses_openai_inner(
    app: AppHandle,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
    system_prompt: Option<String>,
    stream_id: String,
    enable_tools: bool,
    reasoning_effort: Option<String>,
    verbosity: Option<String>,
) -> Result<(), String> {
    let stream_state = app.state::<ChatStreamState>();
    let client = reqwest::Client::new();
    let input_items = convert_messages_for_responses_api(&messages, system_prompt.as_deref());
    let mut body = serde_json::json!({
        "model": model,
        "input": input_items,
        "max_output_tokens": max_tokens,
        "stream": true,
        "store": false,
    });
    // Reasoning models (o1/o3/o4/gpt-5) don't support temperature; only set for non-reasoning
    let is_reasoning = model.starts_with("o1") || model.starts_with("o3")
        || model.starts_with("o4") || model.starts_with("gpt-5");
    if !is_reasoning {
        body["temperature"] = serde_json::json!(temperature);
    }
    // Responses API: reasoning.effort + optional reasoning.summary (required for visible summaries)
    if let Some(ref effort) = reasoning_effort {
        body["reasoning"] = reasoning_body_for_responses_api(effort);
    }
    // GPT-5 verbosity — top-level `verbosity` was removed; use `text.verbosity`
    // https://platform.openai.com/docs/api-reference/responses/create
    if let Some(ref v) = verbosity {
        body["text"] = serde_json::json!({"verbosity": v});
    }
    if enable_tools {
        body["tools"] = get_atls_tools_responses();
    }
    let body_str = body.to_string();
    let response = retry_with_backoff(MAX_RETRIES, Some(&app), Some(&stream_id), || {
        let client = client.clone();
        let api_key = api_key.clone();
        let body_str = body_str.clone();
        async move {
            let resp = client
                .post("https://api.openai.com/v1/responses")
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", api_key))
                .body(body_str)
                .send()
                .await
                .map_err(|e| (reqwest::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err((status, body));
            }
            Ok(resp)
        }
    })
    .await?;

    let app_clone = app.clone();
    let stream_id_clone = stream_id.clone();
    let stream_id_cleanup = stream_id.clone();
    let app_cleanup = app.clone();
    let handle = tokio::spawn(async move {
        use futures::StreamExt;
        use crate::stream_protocol::*;

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut block_counter: u32 = 0;

        let mut text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
        let mut reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
        let mut is_reasoning = false;
        let mut pending_tool_call: Option<(String, String, String)> = None;
        let mut usage_emitted = false;

        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    let mut event_type: Option<String> = None;
                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].trim_end().to_string();
                        buffer = buffer[newline_pos + 1..].to_string();
                        if line.starts_with("event: ") {
                            event_type = Some(line.strip_prefix("event: ").unwrap_or("").trim().to_string());
                        } else if line.starts_with("data: ") {
                            let data_str = line.strip_prefix("data: ").unwrap_or("").trim();
                            if data_str == "[DONE]" {
                                event_type = None;
                                continue;
                            }
                            let evt = event_type.clone().unwrap_or_default();
                            event_type = None;
                            if data_str.is_empty() {
                                continue;
                            }
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(data_str) {
                                match evt.as_str() {
                                    "response.output_text.delta" => {
                                        if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                                            if is_reasoning {
                                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
                                                text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                is_reasoning = false;
                                            }
                                            text_batcher.push(delta, &app_clone, &stream_id_clone);
                                        }
                                    }
                                    "response.reasoning.delta" | "response.reasoning_summary_text.delta" => {
                                        if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                                            if !is_reasoning {
                                                text_batcher.close(&app_clone, &stream_id_clone);
                                                is_reasoning = true;
                                            }
                                            reasoning_batcher.push(delta, &app_clone, &stream_id_clone);
                                        }
                                    }
                                    "response.function_call_arguments.delta" => {
                                        if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                                            if let Some((ref id, _, ref mut args)) = pending_tool_call {
                                                args.push_str(delta);
                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputDelta {
                                                    tool_call_id: id.clone(),
                                                    input_text_delta: delta.to_string(),
                                                });
                                            }
                                        }
                                    }
                                    "response.function_call_arguments.done" => {
                                        text_batcher.close(&app_clone, &stream_id_clone);
                                        reasoning_batcher.close(&app_clone, &stream_id_clone);
                                        let item_id = data.get("item_id").and_then(|v| v.as_str()).unwrap_or("");
                                        let event_name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                        let arguments = data.get("arguments").and_then(|v| v.as_str()).unwrap_or("");
                                        let (id, pending_name, _) = pending_tool_call.take()
                                            .unwrap_or((item_id.to_string(), event_name.to_string(), arguments.to_string()));
                                        let resolved_name = if pending_name.is_empty() { event_name.to_string() } else { pending_name };
                                        let input = serde_json::from_str::<serde_json::Value>(arguments).unwrap_or(serde_json::json!({}));
                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                                            tool_call_id: id,
                                            tool_name: resolved_name,
                                            input,
                                            thought_signature: None,
                                        });
                                    }
                                    "response.output_item.added" => {
                                        if let Some(item) = data.get("item") {
                                            if item.get("type").and_then(|t| t.as_str()) == Some("function_call") {
                                                text_batcher.close(&app_clone, &stream_id_clone);
                                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputStart {
                                                    tool_call_id: id.clone(),
                                                    tool_name: name.clone(),
                                                });
                                                pending_tool_call = Some((id, name, String::new()));
                                            }
                                        }
                                    }
                                    "response.completed" => {
                                        text_batcher.close(&app_clone, &stream_id_clone);
                                        reasoning_batcher.close(&app_clone, &stream_id_clone);
                                        // Flush any pending tool call that never got function_call_arguments.done
                                        // (avoids tools stuck on "Preparing" when API event order differs)
                                        if let Some((id, name, args)) = pending_tool_call.take() {
                                            let input = serde_json::from_str::<serde_json::Value>(&args).unwrap_or(serde_json::json!({}));
                                            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                                                tool_call_id: id,
                                                tool_name: name,
                                                input,
                                                thought_signature: None,
                                            });
                                        }
                                        let mut has_function_calls = false;
                                        if let Some(resp) = data.get("response") {
                                            let usage = resp.get("usage");
                                            let input_tok = usage
                                                .and_then(|u| u.get("input_tokens").and_then(|v| v.as_i64()))
                                                .or_else(|| usage.and_then(|u| u.get("prompt_tokens").and_then(|v| v.as_i64())))
                                                .unwrap_or(0);
                                            let output_tok = usage
                                                .and_then(|u| u.get("output_tokens").and_then(|v| v.as_i64()))
                                                .or_else(|| usage.and_then(|u| u.get("completion_tokens").and_then(|v| v.as_i64())))
                                                .unwrap_or(0);
                                            let cached = usage
                                                .and_then(|u| u.get("input_tokens_details").and_then(|d| d.get("cached_tokens")).and_then(|v| v.as_i64()))
                                                .or_else(|| usage.and_then(|u| u.get("prompt_tokens_details").and_then(|d| d.get("cached_tokens")).and_then(|v| v.as_i64())))
                                                .unwrap_or(0);
                                            if input_tok == 0 && output_tok == 0 {
                                                eprintln!("[atls] Responses API: no usage in response.completed");
                                            }
                                            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Usage {
                                                input_tokens: input_tok,
                                                output_tokens: output_tok,
                                                cache_creation_input_tokens: None,
                                                cache_read_input_tokens: None,
                                                openai_cached_tokens: if cached > 0 { Some(cached) } else { None },
                                                cached_content_tokens: None,
                                            });
                                            // We return below; usage_emitted not needed for this path
                                            // Check if output contains function_call items
                                            if let Some(output) = resp.get("output").and_then(|o| o.as_array()) {
                                                has_function_calls = output.iter().any(|item|
                                                    item.get("type").and_then(|t| t.as_str()) == Some("function_call"));
                                            }
                                        }
                                        let reason = if has_function_calls { "tool_use" } else { "end_turn" };
                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::StopReason {
                                            reason: reason.to_string(),
                                        });
                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                                        return;
                                    }
                                    "response.incomplete" => {
                                        // Non-terminal: reasoning models emit this when switching output items
                                        // (e.g. reasoning -> text). Continue until response.completed.
                                    }
                                    "response.failed" => {
                                        text_batcher.close(&app_clone, &stream_id_clone);
                                        reasoning_batcher.close(&app_clone, &stream_id_clone);
                                        if let Some((id, name, args)) = pending_tool_call.take() {
                                            let input = serde_json::from_str::<serde_json::Value>(&args).unwrap_or(serde_json::json!({}));
                                            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                                                tool_call_id: id,
                                                tool_name: name,
                                                input,
                                                thought_signature: None,
                                            });
                                        }
                                        let err_msg = data.get("response").and_then(|r| r.get("error"))
                                            .and_then(|e| e.get("message").and_then(|m| m.as_str()))
                                            .unwrap_or("Unknown error");
                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Error {
                                            error_text: err_msg.to_string(),
                                        });
                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                                        return;
                                    }
                                    _ => {}
                                }
                                // Fallback: extract usage from payload when evt unknown (e.g. API puts type in JSON)
                                if !usage_emitted {
                                    if let Some(resp) = data.get("response") {
                                        if let Some(usage) = resp.get("usage") {
                                            let input_tok = usage
                                                .get("input_tokens")
                                                .and_then(|v| v.as_i64())
                                                .or_else(|| usage.get("prompt_tokens").and_then(|v| v.as_i64()))
                                                .unwrap_or(0);
                                            let output_tok = usage
                                                .get("output_tokens")
                                                .and_then(|v| v.as_i64())
                                                .or_else(|| usage.get("completion_tokens").and_then(|v| v.as_i64()))
                                                .unwrap_or(0);
                                            let cached = usage
                                                .get("input_tokens_details")
                                                .and_then(|d| d.get("cached_tokens"))
                                                .and_then(|v| v.as_i64())
                                                .or_else(|| {
                                                    usage.get("prompt_tokens_details")
                                                        .and_then(|d| d.get("cached_tokens"))
                                                        .and_then(|v| v.as_i64())
                                                });
                                            if input_tok > 0 || output_tok > 0 {
                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Usage {
                                                    input_tokens: input_tok,
                                                    output_tokens: output_tok,
                                                    cache_creation_input_tokens: None,
                                                    cache_read_input_tokens: None,
                                                    openai_cached_tokens: if cached.unwrap_or(0) > 0 { cached } else { None },
                                                    cached_content_tokens: None,
                                                });
                                                usage_emitted = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Error {
                        error_text: e.to_string(),
                    });
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                    return;
                }
            }
        }
        text_batcher.close(&app_clone, &stream_id_clone);
        reasoning_batcher.close(&app_clone, &stream_id_clone);
        if !usage_emitted {
            eprintln!("[atls] Responses API: stream ended without usage — cost/ATLS internals may show flat (no response.completed with usage)");
        }
        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
    });

    {
        let mut handles = stream_state.handles.lock().await;
        handles.insert(stream_id.clone(), handle);
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = app_cleanup.state::<ChatStreamState>();
            let handles = state.handles.lock().await;
            if let Some(h) = handles.get(&stream_id_cleanup) {
                if h.is_finished() {
                    drop(handles);
                    app_cleanup.state::<ChatStreamState>().handles.lock().await.remove(&stream_id_cleanup);
                    break;
                }
            } else {
                break;
            }
        }
    });
    Ok(())
}

/// Stream chat response from OpenAI
#[tauri::command]
pub async fn stream_chat_openai(
    app: AppHandle,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
    system_prompt: Option<String>,
    stream_id: String,
    enable_tools: Option<bool>,
    reasoning_effort: Option<String>,
    verbosity: Option<String>,
) -> Result<(), String> {
    if openai_model_requires_responses_api(&model) {
        return stream_responses_openai_inner(
            app,
            api_key,
            model,
            messages,
            max_tokens,
            temperature,
            system_prompt,
            stream_id,
            enable_tools.unwrap_or(true),
            reasoning_effort,
            verbosity,
        )
        .await;
    }
    let stream_state = app.state::<ChatStreamState>();
    let client = reqwest::Client::new();
    
    // Build messages with tool_use/tool_result restructuring for OpenAI format
    let openai_messages = convert_messages_for_openai(&messages, system_prompt.as_deref());
    
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": openai_messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });

    // Reasoning effort (Chat Completions path — non-Responses models)
    if let Some(ref effort) = reasoning_effort {
        body["reasoning_effort"] = serde_json::json!(effort);
    }
    
    // Add tools if enabled
    if enable_tools.unwrap_or(true) {
        body["tools"] = get_atls_tools("openai");
    }
    
    // Use retry helper for rate limit handling
    let body_str = body.to_string();
    let response = retry_with_backoff(MAX_RETRIES, Some(&app), Some(&stream_id), || {
        let client = client.clone();
        let api_key = api_key.clone();
        let body_str = body_str.clone();
        async move {
            let resp = client
                .post("https://api.openai.com/v1/chat/completions")
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", api_key))
                .body(body_str)
                .send()
                .await
                .map_err(|e| (reqwest::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err((status, body));
            }
            
            Ok(resp)
        }
    }).await?;
    
    let app_clone = app.clone();
    let stream_id_clone = stream_id.clone();
    let stream_id_cleanup = stream_id.clone();
    let app_cleanup = app.clone();
    
    let handle = tokio::spawn(async move {
        use futures::StreamExt;
        use crate::stream_protocol::*;
        
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut block_counter: u32 = 0;
        
        let mut text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
        let mut reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
        let mut is_reasoning = false;
        
        // Accumulate incremental tool call deltas (OpenAI sends name only in the first chunk)
        // Map: index -> (id, name, accumulated_args, started_emitting)
        let mut pending_tc: std::collections::HashMap<usize, (String, String, String, bool)> = std::collections::HashMap::new();
        let mut last_stop_reason: Option<String> = None;
        
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    
                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].to_string();
                        buffer = buffer[newline_pos + 1..].to_string();
                        
                        if line.starts_with("data: ") {
                            let data = &line[6..];
                            if data == "[DONE]" {
                                text_batcher.close(&app_clone, &stream_id_clone);
                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                // Flush any remaining accumulated tool calls
                                for (_, (id, name, args, _)) in pending_tc.drain() {
                                    if !name.is_empty() {
                                        let input = serde_json::from_str::<serde_json::Value>(&args).unwrap_or(serde_json::json!({}));
                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                                            tool_call_id: id,
                                            tool_name: name,
                                            input,
                                            thought_signature: None,
                                        });
                                    }
                                }
                                if let Some(ref reason) = last_stop_reason {
                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::StopReason {
                                        reason: reason.clone(),
                                    });
                                }
                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                                return;
                            }
                            
                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(usage) = event.get("usage") {
                                    let cached = usage.get("prompt_tokens_details")
                                        .and_then(|d| d.get("cached_tokens"))
                                        .and_then(|v| v.as_i64())
                                        .unwrap_or(0);
                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Usage {
                                        input_tokens: usage.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
                                        output_tokens: usage.get("completion_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
                                        cache_creation_input_tokens: None,
                                        cache_read_input_tokens: None,
                                        openai_cached_tokens: Some(cached),
                                        cached_content_tokens: None,
                                    });
                                }
                                
                                if let Some(choices) = event.get("choices").and_then(|c| c.as_array()) {
                                    if let Some(choice) = choices.first() {
                                        if let Some(delta) = choice.get("delta") {
                                            // Handle reasoning content (o1/o3/o4/gpt-5 models)
                                            let reasoning_text = delta.get("reasoning_content")
                                                .or_else(|| delta.get("reasoning"))
                                                .and_then(|r| r.as_str());
                                            if let Some(reasoning) = reasoning_text {
                                                if !is_reasoning {
                                                    text_batcher.close(&app_clone, &stream_id_clone);
                                                    is_reasoning = true;
                                                }
                                                reasoning_batcher.push(reasoning, &app_clone, &stream_id_clone);
                                            }
                                            
                                            // Handle text content
                                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                                if is_reasoning {
                                                    reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                    reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
                                                    text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                    is_reasoning = false;
                                                }
                                                text_batcher.push(content, &app_clone, &stream_id_clone);
                                            }
                                            
                                            // Handle tool calls (OpenAI streams incrementally)
                                            if let Some(tool_calls) = delta.get("tool_calls").and_then(|tc| tc.as_array()) {
                                                text_batcher.close(&app_clone, &stream_id_clone);
                                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                for tool_call in tool_calls {
                                                    let idx = tool_call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                                    if let Some(func) = tool_call.get("function") {
                                                        let entry = pending_tc.entry(idx).or_insert_with(|| (String::new(), String::new(), String::new(), false));
                                                        if let Some(id) = tool_call.get("id").and_then(|v| v.as_str()) {
                                                            if !id.is_empty() { entry.0 = id.to_string(); }
                                                        }
                                                        if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                                            if !name.is_empty() { entry.1 = name.to_string(); }
                                                        }
                                                        // Emit ToolInputStart on first delta for this tool
                                                        if !entry.3 && !entry.0.is_empty() && !entry.1.is_empty() {
                                                            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputStart {
                                                                tool_call_id: entry.0.clone(),
                                                                tool_name: entry.1.clone(),
                                                            });
                                                            entry.3 = true;
                                                        }
                                                        if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                                            entry.2.push_str(args);
                                                            if entry.3 {
                                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputDelta {
                                                                    tool_call_id: entry.0.clone(),
                                                                    input_text_delta: args.to_string(),
                                                                });
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        if let Some(finish_reason) = choice.get("finish_reason") {
                                            if !finish_reason.is_null() {
                                                let normalized = match finish_reason.as_str().unwrap_or("") {
                                                    "stop" | "content_filter" => "end_turn",
                                                    "length" => "max_tokens",
                                                    "tool_calls" => "tool_use",
                                                    other => other,
                                                };
                                                last_stop_reason = Some(normalized.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Error {
                        error_text: e.to_string(),
                    });
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                    return;
                }
            }
        }
        
        text_batcher.close(&app_clone, &stream_id_clone);
        reasoning_batcher.close(&app_clone, &stream_id_clone);
        for (_, (id, name, args, _)) in pending_tc.drain() {
            if !name.is_empty() {
                let input = serde_json::from_str::<serde_json::Value>(&args).unwrap_or(serde_json::json!({}));
                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                    tool_call_id: id,
                    tool_name: name,
                    input,
                    thought_signature: None,
                });
            }
        }
        if let Some(ref reason) = last_stop_reason {
            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::StopReason {
                reason: reason.clone(),
            });
        }
        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
    });
    
    {
        let mut handles = stream_state.handles.lock().await;
        handles.insert(stream_id.clone(), handle);
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = app_cleanup.state::<ChatStreamState>();
            let handles = state.handles.lock().await;
            if let Some(h) = handles.get(&stream_id_cleanup) {
                if h.is_finished() {
                    drop(handles);
                    app_cleanup.state::<ChatStreamState>().handles.lock().await.remove(&stream_id_cleanup);
                    break;
                }
            } else {
                break;
            }
        }
    });
    
    Ok(())
}

/// Stream chat from LM Studio (OpenAI-compatible local server).
/// Uses the same /v1/chat/completions format as OpenAI but against a user-provided base URL.
#[tauri::command]
pub async fn stream_chat_lmstudio(
    app: AppHandle,
    base_url: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
    system_prompt: Option<String>,
    stream_id: String,
    enable_tools: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<(), String> {
    let stream_state = app.state::<ChatStreamState>();
    let client = reqwest::Client::new();

    let openai_messages = convert_messages_for_openai(&messages, system_prompt.as_deref());

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "messages": openai_messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });

    // Best-effort passthrough for OpenAI-compatible local servers
    if let Some(ref effort) = reasoning_effort {
        body["reasoning_effort"] = serde_json::json!(effort);
    }

    if enable_tools.unwrap_or(false) {
        body["tools"] = get_atls_tools("openai");
    }

    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let body_str = body.to_string();
    let response = retry_with_backoff(MAX_RETRIES, Some(&app), Some(&stream_id), || {
        let client = client.clone();
        let body_str = body_str.clone();
        let url = url.clone();
        async move {
            let resp = client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body_str)
                .send()
                .await
                .map_err(|e| (reqwest::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err((status, body));
            }

            Ok(resp)
        }
    }).await?;

    let app_clone = app.clone();
    let stream_id_clone = stream_id.clone();
    let stream_id_cleanup = stream_id.clone();

    let handle = tokio::spawn(async move {
        use futures::StreamExt;
        use crate::stream_protocol::*;

        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut block_counter: u32 = 0;

        let mut text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
        let mut reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
        let mut is_reasoning = false;
        let mut pending_tc: std::collections::HashMap<usize, (String, String, String, bool)> = std::collections::HashMap::new();
        let mut last_stop_reason: Option<String> = None;

        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));

                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].to_string();
                        buffer = buffer[newline_pos + 1..].to_string();

                        if line.starts_with("data: ") {
                            let data = &line[6..];
                            if data.trim() == "[DONE]" {
                                text_batcher.close(&app_clone, &stream_id_clone);
                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                for (_, (id, name, args, _)) in pending_tc.drain() {
                                    if !name.is_empty() {
                                        let input = serde_json::from_str::<serde_json::Value>(&args).unwrap_or(serde_json::json!({}));
                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                                            tool_call_id: id, tool_name: name, input,
                                            thought_signature: None,
                                        });
                                    }
                                }
                                if let Some(ref reason) = last_stop_reason {
                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::StopReason {
                                        reason: reason.clone(),
                                    });
                                }
                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                                return;
                            }

                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data.trim()) {
                                if let Some(usage) = event.get("usage") {
                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Usage {
                                        input_tokens: usage.get("prompt_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
                                        output_tokens: usage.get("completion_tokens").and_then(|v| v.as_i64()).unwrap_or(0),
                                        cache_creation_input_tokens: None,
                                        cache_read_input_tokens: None,
                                        openai_cached_tokens: None,
                                        cached_content_tokens: None,
                                    });
                                }

                                if let Some(choices) = event.get("choices").and_then(|c| c.as_array()) {
                                    if let Some(choice) = choices.first() {
                                        if let Some(delta) = choice.get("delta") {
                                            let reasoning_text = delta.get("reasoning_content")
                                                .or_else(|| delta.get("reasoning"))
                                                .and_then(|r| r.as_str());
                                            if let Some(reasoning) = reasoning_text {
                                                if !is_reasoning {
                                                    text_batcher.close(&app_clone, &stream_id_clone);
                                                    is_reasoning = true;
                                                }
                                                reasoning_batcher.push(reasoning, &app_clone, &stream_id_clone);
                                            }
                                            if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
                                                if is_reasoning {
                                                    reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                    reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
                                                    text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                    is_reasoning = false;
                                                }
                                                text_batcher.push(content, &app_clone, &stream_id_clone);
                                            }
                                            if let Some(tool_calls) = delta.get("tool_calls").and_then(|tc| tc.as_array()) {
                                                text_batcher.close(&app_clone, &stream_id_clone);
                                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                for tool_call in tool_calls {
                                                    let idx = tool_call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                                    if let Some(func) = tool_call.get("function") {
                                                        let entry = pending_tc.entry(idx).or_insert_with(|| (String::new(), String::new(), String::new(), false));
                                                        if let Some(id) = tool_call.get("id").and_then(|v| v.as_str()) {
                                                            if !id.is_empty() { entry.0 = id.to_string(); }
                                                        }
                                                        if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                                            if !name.is_empty() { entry.1 = name.to_string(); }
                                                        }
                                                        if !entry.3 && !entry.0.is_empty() && !entry.1.is_empty() {
                                                            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputStart {
                                                                tool_call_id: entry.0.clone(), tool_name: entry.1.clone(),
                                                            });
                                                            entry.3 = true;
                                                        }
                                                        if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                                            entry.2.push_str(args);
                                                            if entry.3 {
                                                                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputDelta {
                                                                    tool_call_id: entry.0.clone(), input_text_delta: args.to_string(),
                                                                });
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        if let Some(finish_reason) = choice.get("finish_reason") {
                                            if !finish_reason.is_null() {
                                                let normalized = match finish_reason.as_str().unwrap_or("") {
                                                    "stop" | "content_filter" => "end_turn",
                                                    "length" => "max_tokens",
                                                    "tool_calls" => "tool_use",
                                                    other => other,
                                                };
                                                last_stop_reason = Some(normalized.to_string());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Error {
                        error_text: e.to_string(),
                    });
                    break;
                }
            }
        }

        text_batcher.close(&app_clone, &stream_id_clone);
        reasoning_batcher.close(&app_clone, &stream_id_clone);
        for (_, (id, name, args, _)) in pending_tc.drain() {
            if !name.is_empty() {
                let input = serde_json::from_str::<serde_json::Value>(&args).unwrap_or(serde_json::json!({}));
                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                    tool_call_id: id,
                    tool_name: name,
                    input,
                    thought_signature: None,
                });
            }
        }
        if let Some(ref reason) = last_stop_reason {
            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::StopReason {
                reason: reason.clone(),
            });
        }
        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
    });

    stream_state.handles.lock().await.insert(stream_id_cleanup.clone(), handle);

    Ok(())
}

/// Stream chat response from Google AI (Gemini)
#[tauri::command]
pub async fn stream_chat_google(
    app: AppHandle,
    api_key: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
    system_prompt: Option<String>,
    stream_id: String,
    enable_tools: Option<bool>,
    cached_content: Option<String>,
    dynamic_context: Option<String>,
    thinking_budget: Option<i32>,
) -> Result<(), String> {
    let stream_state = app.state::<ChatStreamState>();
    let client = reqwest::Client::new();
    
    // Convert to Gemini format, handling multimodal content.
    // Gemini requires functionResponse parts in their own user message,
    // separate from text parts. Split mixed messages accordingly.
    let mut contents: Vec<serde_json::Value> = Vec::new();
    for m in messages.iter().filter(|m| m.role != "system") {
        let role = if m.role == "assistant" { "model" } else { "user" };
        let parts = convert_content_for_google(&m.content);

        if role == "user" {
            // Split: functionResponse parts go in one message, everything else in another
            let mut fn_response_parts: Vec<serde_json::Value> = Vec::new();
            let mut other_parts: Vec<serde_json::Value> = Vec::new();
            for part in &parts {
                if part.get("functionResponse").is_some() {
                    fn_response_parts.push(part.clone());
                } else {
                    other_parts.push(part.clone());
                }
            }
            if !fn_response_parts.is_empty() {
                contents.push(serde_json::json!({ "role": "user", "parts": fn_response_parts }));
            }
            if !other_parts.is_empty() {
                contents.push(serde_json::json!({ "role": "user", "parts": other_parts }));
            }
            if fn_response_parts.is_empty() && other_parts.is_empty() {
                contents.push(serde_json::json!({ "role": "user", "parts": parts }));
            }
        } else {
            contents.push(serde_json::json!({ "role": role, "parts": parts }));
        }
    }

    // Gemini requires alternating user/model roles. Merge consecutive same-role messages.
    let mut merged_contents: Vec<serde_json::Value> = Vec::new();
    for entry in contents {
        let role = entry.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        let parts = entry.get("parts").cloned().unwrap_or(serde_json::json!([]));
        if let Some(last) = merged_contents.last_mut() {
            let last_role = last.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if last_role == role {
                if let Some(last_parts) = last.get_mut("parts").and_then(|p| p.as_array_mut()) {
                    if let Some(new_parts) = parts.as_array() {
                        last_parts.extend(new_parts.iter().cloned());
                    }
                }
                continue;
            }
        }
        merged_contents.push(serde_json::json!({ "role": role, "parts": parts }));
    }

    // Gemini 3+ requires thoughtSignature on functionCall parts in conversation history
    if is_gemini3_model(&model) {
        inject_dummy_thought_signatures(&mut merged_contents);
    }

    // Inject dynamic context (WM, task state, project tree) into the conversation.
    // When cachedContent is active, systemInstruction is forbidden, so we prepend
    // to the last user message parts. Prepended (not appended) so the user's actual
    // instruction retains recency primacy — Gemini attends most to the last content.
    if let Some(ref dyn_ctx) = dynamic_context {
        if !dyn_ctx.is_empty() && cached_content.is_some() {
            if let Some(last_user) = merged_contents.iter_mut().rev().find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user")) {
                if let Some(parts) = last_user.get_mut("parts").and_then(|p| p.as_array_mut()) {
                    parts.insert(0, serde_json::json!({"text": dyn_ctx}));
                }
            }
        }
    }

    validate_gemini_contents("Google", &merged_contents);
    log_gemini_contents_summary("Google", &merged_contents, cached_content.is_some());

    if cached_content.is_some() && merged_contents.is_empty() {
        return Err(
            "Gemini stream_chat_google: cachedContent is set but contents is empty after merge; \
             uncached messages tail must be non-empty (same invariant as OpenAI full messages)."
                .to_string(),
        );
    }

    let mut gen_config = serde_json::json!({
        "maxOutputTokens": max_tokens,
        "temperature": temperature,
    });

    // Gemini thinkingConfig for 2.5/3+ models
    if let Some(budget) = thinking_budget {
        gen_config["thinkingConfig"] = serde_json::json!({
            "thinkingBudget": budget,
            "includeThoughts": true
        });
    }

    let mut body = serde_json::json!({
        "contents": merged_contents,
        "generationConfig": gen_config,
    });

    // Use cached content only if explicitly provided by frontend (single source of truth)
    let tools_enabled = enable_tools.unwrap_or(true);
    if let Some(ref cache_name) = cached_content {
        body["cachedContent"] = serde_json::json!(cache_name);
        if tools_enabled {
            body["tools"] = get_atls_tools("google");
            body["toolConfig"] = serde_json::json!({
                "functionCallingConfig": { "mode": "AUTO" }
            });
        }
    } else {
        let mut system_text = system_prompt.unwrap_or_default();
        if let Some(ref dyn_ctx) = dynamic_context {
            if !dyn_ctx.is_empty() {
                system_text.push_str("\n\n");
                system_text.push_str(dyn_ctx);
            }
        }
        if !system_text.is_empty() {
            body["systemInstruction"] = serde_json::json!({
                "parts": [{ "text": system_text }]
            });
        }
        if tools_enabled {
            body["tools"] = get_atls_tools("google");
            body["toolConfig"] = serde_json::json!({
                "functionCallingConfig": { "mode": "AUTO" }
            });
        }
    }
    
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?key={}&alt=sse",
        model, api_key
    );
    
    // Use retry helper for rate limit handling
    let body_str = body.to_string();
    let response = retry_with_backoff(MAX_RETRIES, Some(&app), Some(&stream_id), || {
        let client = client.clone();
        let url = url.clone();
        let body_str = body_str.clone();
        async move {
            let resp = client
                .post(&url)
                .header("Content-Type", "application/json")
                .body(body_str)
                .send()
                .await
                .map_err(|e| (reqwest::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err((status, body));
            }
            
            Ok(resp)
        }
    }).await?;
    
    let app_clone = app.clone();
    let stream_id_clone = stream_id.clone();
    let stream_id_cleanup = stream_id.clone();
    let app_cleanup = app.clone();
    
    let handle = tokio::spawn(async move {
        use futures::StreamExt;
        use std::time::Duration;
        use crate::stream_protocol::*;
        
        let mut stream = response.bytes_stream();
        let mut buffer = String::new();
        let mut block_counter: u32 = 0;
        
        let mut text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
        let mut reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
        let mut full_response = String::new();
        let mut had_native_tool_call = false;
        let mut stream_finished = false;
        let mut last_stop_reason: Option<String> = None;
        let mut done_marker_count: u32 = 0;
        let mut in_thought = false;
        
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk));
                    
                    while let Some(newline_pos) = buffer.find('\n') {
                        let line = buffer[..newline_pos].to_string();
                        buffer = buffer[newline_pos + 1..].to_string();
                        
                        if line.starts_with("data: ") {
                            let data = &line[6..];
                            
                            if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                                // Gemini SSE can carry inline error objects (e.g. 400/403/429)
                                if let Some(err_obj) = event.get("error") {
                                    let code = err_obj.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
                                    let msg = err_obj.get("message").and_then(|v| v.as_str()).unwrap_or("Unknown Gemini error");
                                    let status = err_obj.get("status").and_then(|v| v.as_str()).unwrap_or("");
                                    let error_text = format!("Gemini API error {} ({}): {}", code, status, msg);
                                    eprintln!("[ATLS] {}", error_text);
                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Error { error_text });
                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                                    return;
                                }
                                // When stream_finished (e.g. tool calls), drain remaining chunks for usageMetadata only
                                if !stream_finished {
                                if let Some(candidates) = event.get("candidates").and_then(|c| c.as_array()) {
                                    if let Some(candidate) = candidates.first() {
                                        if let Some(content) = candidate.get("content") {
                                            if let Some(parts) = content.get("parts").and_then(|p| p.as_array()) {
                                                for part in parts {
                                                    let is_thought = part.get("thought").and_then(|t| t.as_bool()).unwrap_or(false);
                                                    
                                                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                                                        if text.contains("st:done") {
                                                            done_marker_count += 1;
                                                            if done_marker_count > 2 {
                                                                stream_finished = true;
                                                                break;
                                                            }
                                                        }
                                                        
                                                        if is_thought {
                                                            // Transition: text -> reasoning
                                                            if !in_thought {
                                                                text_batcher.close(&app_clone, &stream_id_clone);
                                                                text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                                in_thought = true;
                                                            }
                                                            reasoning_batcher.push(text, &app_clone, &stream_id_clone);
                                                        } else {
                                                            // Transition: reasoning -> text
                                                            if in_thought {
                                                                reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                                reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
                                                                in_thought = false;
                                                            }
                                                            text_batcher.push(text, &app_clone, &stream_id_clone);
                                                            full_response.push_str(text);
                                                        }
                                                    }
                                                    
                                                    if let Some(function_call) = part.get("functionCall") {
                                                        had_native_tool_call = true;
                                                        text_batcher.close(&app_clone, &stream_id_clone);
                                                        reasoning_batcher.close(&app_clone, &stream_id_clone);
                                                        text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                        reasoning_batcher = ReasoningBatcher::new(next_block_id(&mut block_counter));
                                                        in_thought = false;
                                                        
                                                        let call_id = format!("call_{:x}", std::time::SystemTime::now()
                                                            .duration_since(std::time::UNIX_EPOCH)
                                                            .map(|d| d.as_nanos())
                                                            .unwrap_or(0));
                                                        let name = function_call.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                                        let args = function_call.get("args").cloned().unwrap_or(serde_json::json!({}));
                                                        // Gemini 3+ includes thoughtSignature on functionCall parts (required for multi-turn)
                                                        let thought_sig = part.get("thoughtSignature")
                                                            .and_then(|v| v.as_str())
                                                            .map(|s| s.to_string());
                                                        
                                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputStart {
                                                            tool_call_id: call_id.clone(),
                                                            tool_name: name.clone(),
                                                        });
                                                        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                                                            tool_call_id: call_id,
                                                            tool_name: name,
                                                            input: args,
                                                            thought_signature: thought_sig,
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                        if let Some(finish_reason) = candidate.get("finishReason").and_then(|v| v.as_str()) {
                                            last_stop_reason = Some(match finish_reason {
                                                "STOP" | "END_TURN" => "end_turn".to_string(),
                                                "MAX_TOKENS" => "max_tokens".to_string(),
                                                other => other.to_lowercase(),
                                            });
                                            // Only break immediately for STOP/MAX_TOKENS; END_TURN can arrive
                                            // prematurely (Gemini bug) — keep draining to capture tool calls
                                            if finish_reason == "STOP" || finish_reason == "MAX_TOKENS" {
                                                stream_finished = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                                }
                                
                                if let Some(usage) = event.get("usageMetadata") {
                                    let prompt_tokens = usage.get("promptTokenCount")
                                        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                                        .unwrap_or(0);
                                    let candidate_tokens = usage.get("candidatesTokenCount")
                                        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                                        .unwrap_or(0);
                                    let cached = usage.get("cachedContentTokenCount")
                                        .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())));
                                    
                                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Usage {
                                        input_tokens: prompt_tokens,
                                        output_tokens: candidate_tokens,
                                        cache_creation_input_tokens: None,
                                        cache_read_input_tokens: None,
                                        openai_cached_tokens: None,
                                        cached_content_tokens: cached,
                                    });
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Error {
                        error_text: e.to_string(),
                    });
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
                    return;
                }
            }
        }

        text_batcher.close(&app_clone, &stream_id_clone);
        reasoning_batcher.close(&app_clone, &stream_id_clone);

        if let Some(ref reason) = last_stop_reason {
            emit_chunk(&app_clone, &stream_id_clone, StreamChunk::StopReason {
                reason: reason.clone(),
            });
        }
        
        // End-of-stream: extract text-based tool calls from full response (Gemini fallback)
        let has_text_tool_hints = !had_native_tool_call && (
            full_response.contains("batch") || full_response.contains("manage")
            || full_response.contains("task_complete") || full_response.contains("```")
            || full_response.contains("\"name\"")
            || (full_response.contains("tool") && (full_response.contains("params") || full_response.contains("exec") || full_response.contains("workspaces")))
        );
        if has_text_tool_hints {
            let (clean_text, text_calls) = extract_text_tool_calls(&full_response);
            if !text_calls.is_empty() {
                // Re-emit clean text as a fresh text block (replaces already-emitted text)
                emit_chunk(&app_clone, &stream_id_clone, StreamChunk::FinishStep);
                if !clean_text.trim().is_empty() {
                    let mut clean_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                    clean_batcher.push(&clean_text, &app_clone, &stream_id_clone);
                    clean_batcher.close(&app_clone, &stream_id_clone);
                }
                let base_nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                for (idx, tc) in text_calls.iter().enumerate() {
                    let call_id = format!("call_{:x}_{}", base_nanos, idx);
                    let tool_name_str = tc.get("tool").and_then(|v| v.as_str()).unwrap_or("batch");
                    let args = tc.get("params").cloned().unwrap_or(serde_json::json!({}));
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputStart {
                        tool_call_id: call_id.clone(),
                        tool_name: tool_name_str.to_string(),
                    });
                    emit_chunk(&app_clone, &stream_id_clone, StreamChunk::ToolInputAvailable {
                        tool_call_id: call_id,
                        tool_name: tool_name_str.to_string(),
                        input: args,
                        thought_signature: None,
                    });
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
        }
        
        emit_chunk(&app_clone, &stream_id_clone, StreamChunk::Done);
    });
    
    {
        let mut handles = stream_state.handles.lock().await;
        handles.insert(stream_id.clone(), handle);
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let state = app_cleanup.state::<ChatStreamState>();
            let handles = state.handles.lock().await;
            if let Some(h) = handles.get(&stream_id_cleanup) {
                if h.is_finished() {
                    drop(handles);
                    app_cleanup.state::<ChatStreamState>().handles.lock().await.remove(&stream_id_cleanup);
                    break;
                }
            } else {
                break;
            }
        }
    });
    
    Ok(())
}

#[cfg(test)]
mod responses_api_conversion_tests {
    use super::*;

    #[test]
    fn assistant_array_text_maps_to_output_text() {
        let messages = vec![ChatMessage {
            role: "assistant".to_string(),
            content: serde_json::json!([{ "type": "text", "text": "Hello" }]),
        }];
        let items = convert_messages_for_responses_api(&messages, None);
        assert_eq!(items.len(), 1);
        let content = items[0].get("content").unwrap();
        let arr = content.as_array().expect("array content");
        assert_eq!(arr[0].get("type").and_then(|t| t.as_str()), Some("output_text"));
        assert_eq!(arr[0].get("text").and_then(|t| t.as_str()), Some("Hello"));
    }

    #[test]
    fn user_array_text_maps_to_input_text() {
        let messages = vec![ChatMessage {
            role: "user".to_string(),
            content: serde_json::json!([{ "type": "text", "text": "Hi" }]),
        }];
        let items = convert_messages_for_responses_api(&messages, None);
        assert_eq!(items.len(), 1);
        let content = items[0].get("content").unwrap();
        let arr = content.as_array().expect("array content");
        assert_eq!(arr[0].get("type").and_then(|t| t.as_str()), Some("input_text"));
        assert_eq!(arr[0].get("text").and_then(|t| t.as_str()), Some("Hi"));
    }

    #[test]
    fn reasoning_body_none_includes_summary_auto() {
        let v = reasoning_body_for_responses_api("none");
        assert_eq!(v.get("effort").and_then(|x| x.as_str()), Some("none"));
        assert_eq!(v.get("summary").and_then(|x| x.as_str()), Some("auto"));
    }

    #[test]
    fn reasoning_body_high_includes_summary_auto() {
        let v = reasoning_body_for_responses_api("high");
        assert_eq!(v.get("effort").and_then(|x| x.as_str()), Some("high"));
        assert_eq!(v.get("summary").and_then(|x| x.as_str()), Some("auto"));
    }
}

#[cfg(test)]
mod atls_tools_provider_tests {
    use super::get_atls_tools;

    #[test]
    fn vertex_and_google_share_gemini_tool_format() {
        let g = get_atls_tools("google");
        let v = get_atls_tools("vertex");
        let vx = get_atls_tools("VERTEX");
        assert_eq!(g, v);
        assert_eq!(g, vx);
        assert!(g.to_string().contains("functionDeclarations"));
    }

    #[test]
    fn lmstudio_and_openai_share_chat_tools_format() {
        let o = get_atls_tools("openai");
        let l = get_atls_tools("lmstudio");
        assert_eq!(o, l);
        assert!(o.to_string().contains("\"type\":\"function\""));
    }

    #[test]
    fn batch_tool_schema_lists_steps_and_q() {
        let tools = get_atls_tools("openai");
        let s = tools.to_string();
        assert!(s.contains("steps"));
        assert!(s.contains("\"q\""));
        assert!(s.contains("version"));
    }
}
