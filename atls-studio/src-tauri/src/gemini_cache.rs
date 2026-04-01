use super::*;
use crate::ai_streaming::{ChatMessage, convert_content_for_google, get_atls_tools, is_gemini3_model, inject_dummy_thought_signatures, validate_gemini_contents, log_gemini_contents_summary, retry_with_backoff, extract_text_tool_calls, MAX_RETRIES};

// ============================================================================
// Gemini Context Caching API
// ============================================================================

/// Create a Gemini CachedContent object containing system prompt + tool definitions.
/// Returns the cache name (e.g. "cachedContents/abc123") for use in subsequent requests.
/// When include_default_tools is true and tools is None, adds ATLS tool definitions (fixes native function calling).
#[tauri::command]
pub async fn gemini_create_cache(
    app: AppHandle,
    api_key: String,
    model: String,
    system_prompt: String,
    messages: Vec<ChatMessage>,
    tools: Option<serde_json::Value>,
    include_default_tools: Option<bool>,
    ttl_seconds: Option<u64>,
    provider: Option<String>,
    project_id: Option<String>,
    region: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let ttl = ttl_seconds.unwrap_or(3600);

    let contents: Vec<serde_json::Value> = messages
        .iter()
        .filter(|m| m.role != "system")
        .map(|m| {
            let role = if m.role == "assistant" { "model" } else { "user" };
            let parts = convert_content_for_google(&m.content);
            serde_json::json!({
                "role": role,
                "parts": parts,
            })
        })
        .collect();

    let mut body = serde_json::json!({
        "model": format!("models/{}", model),
        "systemInstruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": contents,
        "ttl": format!("{}s", ttl),
    });

    // Include tools: explicit tools param, or default ATLS tools when include_default_tools is true
    let tools_to_use = tools.or_else(|| {
        if include_default_tools == Some(true) {
            Some(get_atls_tools("google"))
        } else {
            None
        }
    });
    if let Some(t) = tools_to_use {
        body["tools"] = t;
        body["toolConfig"] = serde_json::json!({
            "functionCallingConfig": { "mode": "AUTO" }
        });
    }

    let is_vertex = provider.as_deref() == Some("vertex");

    let (_url, resp) = if is_vertex {
        let region = region.as_deref().unwrap_or("us-central1");
        let pid = project_id.as_deref().unwrap_or("");
        let vertex_url = format!(
            "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/cachedContents",
            region, pid, region
        );
        body["model"] = serde_json::json!(format!("publishers/google/models/{}", model));
        let r = client.post(&vertex_url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("gemini_create_cache request failed: {}", e))?;
        (vertex_url, r)
    } else {
        let google_url = format!(
            "https://generativelanguage.googleapis.com/v1beta/cachedContents?key={}",
            api_key
        );
        let r = client.post(&google_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("gemini_create_cache request failed: {}", e))?;
        (google_url, r)
    };

    let status = resp.status();
    let resp_body: serde_json::Value = resp.json().await
        .map_err(|e| format!("gemini_create_cache parse failed: {}", e))?;

    if !status.is_success() {
        return Err(format!("gemini_create_cache HTTP {}: {}", status, resp_body));
    }

    let cache_name = resp_body.get("name")
        .and_then(|n| n.as_str())
        .ok_or_else(|| format!("gemini_create_cache: no 'name' in response: {}", resp_body))?
        .to_string();

    let cache_state = app.state::<GeminiCacheState>();
    if is_vertex {
        *cache_state.vertex_cache.lock().await = Some(cache_name.clone());
    } else {
        *cache_state.google_cache.lock().await = Some(cache_name.clone());
    }

    Ok(cache_name)
}

/// Refresh TTL on an existing Gemini cached content.
#[tauri::command]
pub async fn gemini_refresh_cache(
    app: AppHandle,
    api_key: String,
    cache_name: Option<String>,
    ttl_seconds: Option<u64>,
    provider: Option<String>,
    project_id: Option<String>,
    region: Option<String>,
) -> Result<String, String> {
    let is_vertex = provider.as_deref() == Some("vertex");
    let cache_state = app.state::<GeminiCacheState>();

    let name = if let Some(n) = cache_name {
        n
    } else if is_vertex {
        cache_state.vertex_cache.lock().await.clone()
            .ok_or_else(|| "No active Vertex cache to refresh".to_string())?
    } else {
        cache_state.google_cache.lock().await.clone()
            .ok_or_else(|| "No active Google cache to refresh".to_string())?
    };

    let client = reqwest::Client::new();
    let ttl = ttl_seconds.unwrap_or(3600);

    let body = serde_json::json!({
        "ttl": format!("{}s", ttl),
    });

    let resp = if is_vertex {
        let region = region.as_deref().unwrap_or("us-central1");
        let pid = project_id.as_deref().unwrap_or("");
        let url = format!(
            "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/{}?updateMask=ttl",
            region, pid, region, name
        );
        client.patch(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("gemini_refresh_cache failed: {}", e))?
    } else {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/{}?key={}&updateMask=ttl",
            name, api_key
        );
        client.patch(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("gemini_refresh_cache failed: {}", e))?
    };

    let status = resp.status();
    if !status.is_success() {
        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        return Err(format!("gemini_refresh_cache HTTP {}: {}", status, resp_body));
    }

    Ok(name)
}

/// Delete a Gemini cached content and clear state.
#[tauri::command]
pub async fn gemini_delete_cache(
    app: AppHandle,
    api_key: String,
    cache_name: Option<String>,
    provider: Option<String>,
    project_id: Option<String>,
    region: Option<String>,
) -> Result<(), String> {
    let is_vertex = provider.as_deref() == Some("vertex");
    let cache_state = app.state::<GeminiCacheState>();

    let name = if let Some(n) = cache_name {
        n
    } else if is_vertex {
        cache_state.vertex_cache.lock().await.take()
            .ok_or_else(|| "No active Vertex cache to delete".to_string())?
    } else {
        cache_state.google_cache.lock().await.take()
            .ok_or_else(|| "No active Google cache to delete".to_string())?
    };

    let client = reqwest::Client::new();

    let resp = if is_vertex {
        let region = region.as_deref().unwrap_or("us-central1");
        let pid = project_id.as_deref().unwrap_or("");
        let url = format!(
            "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/{}",
            region, pid, region, name
        );
        client.delete(&url)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| format!("gemini_delete_cache failed: {}", e))?
    } else {
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/{}?key={}",
            name, api_key
        );
        client.delete(&url)
            .send()
            .await
            .map_err(|e| format!("gemini_delete_cache failed: {}", e))?
    };

    let status = resp.status();
    if !status.is_success() {
        let resp_body: serde_json::Value = resp.json().await.unwrap_or_default();
        return Err(format!("gemini_delete_cache HTTP {}: {}", status, resp_body));
    }

    // Clear state
    if is_vertex {
        *cache_state.vertex_cache.lock().await = None;
    } else {
        *cache_state.google_cache.lock().await = None;
    }

    Ok(())
}

/// Get the current active Gemini cache name (if any).
#[tauri::command]
pub async fn gemini_get_cache_name(
    app: AppHandle,
    provider: Option<String>,
) -> Result<Option<String>, String> {
    let is_vertex = provider.as_deref() == Some("vertex");
    let cache_state = app.state::<GeminiCacheState>();

    if is_vertex {
        Ok(cache_state.vertex_cache.lock().await.clone())
    } else {
        Ok(cache_state.google_cache.lock().await.clone())
    }
}

/// Stream chat response from Google Vertex AI
/// Uses OAuth2 Bearer token auth and the aiplatform.googleapis.com endpoint.
/// Request/response format is identical to Google AI (Gemini).
#[tauri::command]
pub async fn stream_chat_vertex(
    app: AppHandle,
    access_token: String,
    project_id: String,
    region: Option<String>,
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
    let region = region.unwrap_or_else(|| "us-central1".to_string());

    // Convert to Gemini format — split functionResponse parts from text (same as Google path)
    let mut contents: Vec<serde_json::Value> = Vec::new();
    for m in messages.iter().filter(|m| m.role != "system") {
        let role = if m.role == "assistant" { "model" } else { "user" };
        let parts = convert_content_for_google(&m.content);

        if role == "user" {
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

    // Merge consecutive same-role messages (Gemini requires alternating roles)
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

    // Inject dynamic context: when cachedContent is active, systemInstruction is
    // forbidden, so append to last user message. Otherwise goes into systemInstruction.
    // Appended (not prepended) so the user's actual instruction has primacy position.
    if let Some(ref dyn_ctx) = dynamic_context {
        if !dyn_ctx.is_empty() && cached_content.is_some() {
            if let Some(last_user) = merged_contents.iter_mut().rev().find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user")) {
                if let Some(parts) = last_user.get_mut("parts").and_then(|p| p.as_array_mut()) {
                    parts.push(serde_json::json!({"text": dyn_ctx}));
                }
            }
        }
    }

    validate_gemini_contents("Vertex", &merged_contents);
    log_gemini_contents_summary("Vertex", &merged_contents, cached_content.is_some());

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
        "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/publishers/google/models/{}:streamGenerateContent?alt=sse",
        region, project_id, region, model
    );

    let body_str = body.to_string();
    let response = retry_with_backoff(MAX_RETRIES, Some(&app), Some(&stream_id), || {
        let client = client.clone();
        let url = url.clone();
        let body_str = body_str.clone();
        let access_token = access_token.clone();
        async move {
            let resp = client
                .post(&url)
                .header("Content-Type", "application/json")
                .header("Authorization", format!("Bearer {}", access_token))
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
                                // Vertex SSE can carry inline error objects (e.g. 400/403/429)
                                if let Some(err_obj) = event.get("error") {
                                    let code = err_obj.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
                                    let msg = err_obj.get("message").and_then(|v| v.as_str()).unwrap_or("Unknown Vertex error");
                                    let status = err_obj.get("status").and_then(|v| v.as_str()).unwrap_or("");
                                    let error_text = format!("Vertex API error {} ({}): {}", code, status, msg);
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
                                                            if !in_thought {
                                                                text_batcher.close(&app_clone, &stream_id_clone);
                                                                text_batcher = TextBatcher::new(next_block_id(&mut block_counter));
                                                                in_thought = true;
                                                            }
                                                            reasoning_batcher.push(text, &app_clone, &stream_id_clone);
                                                        } else {
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

                                        if let Some(finish_reason) = candidate.get("finishReason").and_then(|f| f.as_str()) {
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
