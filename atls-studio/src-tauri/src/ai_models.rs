use super::*;

/// Fetch available models from Google Vertex AI
#[tauri::command]
pub async fn fetch_vertex_models(access_token: String, _project_id: String, region: Option<String>) -> Result<Vec<AIModel>, String> {
    if access_token.trim().is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let region = region.unwrap_or_else(|| "us-central1".to_string());

    let known_models = vec![
        AIModel { id: "gemini-3.1-pro-preview-02-25".to_string(), name: "Gemini 3.1 Pro".to_string(), provider: "vertex".to_string(), context_window: Some(2097152) },
        AIModel { id: "gemini-3.0-pro-preview-02-05".to_string(), name: "Gemini 3.0 Pro".to_string(), provider: "vertex".to_string(), context_window: Some(2097152) },
        AIModel { id: "gemini-3.0-flash-preview-02-05".to_string(), name: "Gemini 3.0 Flash".to_string(), provider: "vertex".to_string(), context_window: Some(1048576) },
        AIModel { id: "gemini-2.5-pro-preview-05-06".to_string(), name: "Gemini 2.5 Pro".to_string(), provider: "vertex".to_string(), context_window: Some(1048576) },
        AIModel { id: "gemini-2.5-flash-preview-05-20".to_string(), name: "Gemini 2.5 Flash".to_string(), provider: "vertex".to_string(), context_window: Some(1048576) },
        AIModel { id: "gemini-2.0-flash".to_string(), name: "Gemini 2.0 Flash".to_string(), provider: "vertex".to_string(), context_window: Some(1048576) },
        AIModel { id: "gemini-2.0-flash-lite".to_string(), name: "Gemini 2.0 Flash Lite".to_string(), provider: "vertex".to_string(), context_window: Some(1048576) },
        AIModel { id: "gemini-1.5-pro".to_string(), name: "Gemini 1.5 Pro".to_string(), provider: "vertex".to_string(), context_window: Some(2097152) },
        AIModel { id: "gemini-1.5-flash".to_string(), name: "Gemini 1.5 Flash".to_string(), provider: "vertex".to_string(), context_window: Some(1048576) },
    ];

    // v1beta1 publisher-level list (not project-scoped)
    let url = format!(
        "https://{}-aiplatform.googleapis.com/v1beta1/publishers/google/models",
        region
    );

    let response = match client
        .get(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            eprintln!("[Vertex] Request failed, using known models: {}", e);
            return Ok(known_models);
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        eprintln!("[Vertex] API error {} ({}), using known models", status, body);
        return Ok(known_models);
    }

    let data: serde_json::Value = match response.json().await {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[Vertex] Parse error, using known models: {}", e);
            return Ok(known_models);
        }
    };

    let models_array = data.get("publisherModels")
        .and_then(|v| v.as_array());

    let models: Vec<AIModel> = match models_array {
        Some(arr) => {
            let fetched: Vec<AIModel> = arr
                .iter()
                .filter_map(|m| {
                    let name = m.get("name")?.as_str()?;
                    // Filter to Gemini models only
                    let model_id = vertex_model_id_from_publisher_name(name);
                    if !model_id.starts_with("gemini") {
                        return None;
                    }
                    let display_name = m.get("openSourceCategory")
                        .and_then(|_| None::<&str>)
                        .or_else(|| {
                            m.pointer("/versionId").and_then(|v| v.as_str())
                        })
                        .unwrap_or(model_id);

                    Some(AIModel {
                        id: model_id.to_string(),
                        name: display_name.to_string(),
                        provider: "vertex".to_string(),
                        context_window: None,
                    })
                })
                .collect();
            if fetched.is_empty() { known_models } else { fetched }
        }
        None => known_models,
    };

    Ok(models)
}

/// Last path segment from a Vertex publisher model resource name (e.g. `publishers/google/models/gemini-pro`).
pub(crate) fn vertex_model_id_from_publisher_name(name: &str) -> &str {
    name.split('/').last().unwrap_or(name)
}

// ============================================================================
// AI Provider Model Fetching (bypasses browser CORS)
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct AIModel {
    id: String,
    name: String,
    provider: String,
    context_window: Option<u32>,
}

#[tauri::command]
pub async fn fetch_anthropic_models(api_key: String) -> Result<Vec<AIModel>, String> {
    if api_key.trim().is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    
    let response = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error {}: {}", status, body));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    // Parse models from response
    let models_array = data.get("data")
        .or_else(|| data.get("models"))
        .and_then(|v| v.as_array())
        .ok_or("Invalid response format")?;

    let models: Vec<AIModel> = models_array
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?;
            let display_name = m.get("display_name")
                .or_else(|| m.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or(id);
            let context_window = m.get("context_window")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            
            Some(AIModel {
                id: id.to_string(),
                name: display_name.to_string(),
                provider: "anthropic".to_string(),
                context_window,
            })
        })
        .collect();

    Ok(models)
}

#[tauri::command]
pub async fn fetch_openai_models(api_key: String) -> Result<Vec<AIModel>, String> {
    if api_key.trim().is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    
    let response = client
        .get("https://api.openai.com/v1/models")
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("OpenAI API error {}: {}", status, body));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let models_array = data.get("data")
        .and_then(|v| v.as_array())
        .ok_or("Invalid response format")?;

    // Include all chat-capable models: gpt*, chatgpt*, o1*, o3*, o4*, gpt-oss*. Exclude non-chat (embeddings, image, audio, etc).
    let models: Vec<AIModel> = models_array
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?;
            if !is_openai_chat_model_id(id) {
                return None;
            }
            Some(AIModel {
                id: id.to_string(),
                name: format_openai_model_name(id),
                provider: "openai".to_string(),
                context_window: None,
            })
        })
        .collect();

    Ok(models)
}

/// Whether an OpenAI `/v1/models` id should appear in the chat model picker.
pub(crate) fn is_openai_chat_model_id(id: &str) -> bool {
    let is_chat = id.contains("gpt")
        || id.contains("chatgpt")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4");
    let is_non_chat = id.contains("embedding")
        || id.contains("whisper")
        || id.contains("tts-")
        || id.contains("davinci")
        || id.contains("babbage")
        || id.contains("dall-e")
        || id.contains("gpt-image")
        || id.contains("text-moderation")
        || id.contains("omni-moderation")
        || id.contains("codex-mini")
        || id.starts_with("sora");
    is_chat && !is_non_chat
}

pub(crate) fn format_openai_model_name(id: &str) -> String {
    id.replace("gpt-", "GPT-")
        .replace("-turbo", " Turbo")
        .replace("-preview", " Preview")
}

#[tauri::command]
pub async fn fetch_lmstudio_models(base_url: String) -> Result<Vec<AIModel>, String> {
    if base_url.trim().is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let base = base_url.trim_end_matches('/');

    // Try native LM Studio API first (/api/v1/models) — includes context window info
    let native_url = format!("{}/api/v1/models", base);
    if let Ok(resp) = client.get(&native_url).send().await {
        if resp.status().is_success() {
            if let Ok(data) = resp.json::<serde_json::Value>().await {
                if let Some(models_array) = data.get("models").and_then(|v| v.as_array()) {
                    let models: Vec<AIModel> = models_array
                        .iter()
                        .filter_map(|m| {
                            if m.get("type").and_then(|v| v.as_str()) != Some("llm") {
                                return None;
                            }
                            let id = m.get("key").and_then(|v| v.as_str())
                                .or_else(|| m.get("id").and_then(|v| v.as_str()))?;
                            let display = m.get("display_name").and_then(|v| v.as_str())
                                .unwrap_or(id);
                            let ctx = m.get("max_context_length").and_then(|v| v.as_u64())
                                .map(|v| v as u32);
                            Some(AIModel {
                                id: id.to_string(),
                                name: display.to_string(),
                                provider: "lmstudio".to_string(),
                                context_window: ctx,
                            })
                        })
                        .collect();
                    if !models.is_empty() {
                        return Ok(models);
                    }
                }
            }
        }
    }

    // Fallback: OpenAI-compatible /v1/models (no context window info)
    let compat_url = format!("{}/v1/models", base);
    let response = client
        .get(&compat_url)
        .send()
        .await
        .map_err(|e| format!("LM Studio connection failed ({}): {}", compat_url, e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("LM Studio API error {}: {}", status, body));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let models_array = data.get("data")
        .and_then(|v| v.as_array())
        .ok_or("Invalid response format")?;

    let models: Vec<AIModel> = models_array
        .iter()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?;
            Some(AIModel {
                id: id.to_string(),
                name: id.to_string(),
                provider: "lmstudio".to_string(),
                context_window: None,
            })
        })
        .collect();

    Ok(models)
}

#[tauri::command]
pub async fn fetch_google_models(api_key: String) -> Result<Vec<AIModel>, String> {
    if api_key.trim().is_empty() {
        return Ok(vec![]);
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={}",
        api_key
    );
    
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Google API error {}: {}", status, body));
    }

    let data: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let models_array = data.get("models")
        .and_then(|v| v.as_array())
        .ok_or("Invalid response format")?;

    let models: Vec<AIModel> = models_array
        .iter()
        .filter_map(|m| {
            let name = m.get("name")?.as_str()?;
            let display_name = m.get("displayName")?.as_str()?;
            
            // Only include models that support generateContent
            let methods = m.get("supportedGenerationMethods")
                .and_then(|v| v.as_array())?;
            
            if !methods.iter().any(|m| m.as_str() == Some("generateContent")) {
                return None;
            }
            
            let context_window = m.get("inputTokenLimit")
                .and_then(|v| v.as_u64())
                .map(|v| v as u32);
            
            Some(AIModel {
                id: name.replace("models/", ""),
                name: display_name.to_string(),
                provider: "google".to_string(),
                context_window,
            })
        })
        .collect();

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vertex_model_id_from_publisher_name_trims_prefix() {
        assert_eq!(
            vertex_model_id_from_publisher_name("publishers/google/models/gemini-pro"),
            "gemini-pro"
        );
        assert_eq!(
            vertex_model_id_from_publisher_name("gemini-flash"),
            "gemini-flash"
        );
    }

    #[test]
    fn is_openai_chat_model_id_accepts_chat_and_rejects_embeddings() {
        assert!(is_openai_chat_model_id("gpt-4o"));
        assert!(is_openai_chat_model_id("o1-preview"));
        assert!(!is_openai_chat_model_id("text-embedding-3-small"));
        assert!(!is_openai_chat_model_id("dall-e-3"));
    }

    #[test]
    fn format_openai_model_name_inserts_title_case_segments() {
        assert_eq!(
            format_openai_model_name("gpt-4-turbo-preview").as_str(),
            "GPT-4 Turbo Preview"
        );
    }
}
