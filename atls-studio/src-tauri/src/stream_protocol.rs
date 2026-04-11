use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Typed stream chunk protocol inspired by Vercel AI SDK.
///
/// All provider-specific streaming formats are normalized into these
/// discriminated variants before being emitted to the frontend via a
/// single `chat-chunk-{streamId}` Tauri event channel.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum StreamChunk {
    // ── Text lifecycle ──────────────────────────────────────────────
    #[serde(rename = "text_start")]
    TextStart { id: String },
    #[serde(rename = "text_delta")]
    TextDelta { id: String, delta: String },
    #[serde(rename = "text_end")]
    TextEnd { id: String },

    // ── Reasoning / thinking lifecycle ───────────────────────────────
    #[serde(rename = "reasoning_start")]
    ReasoningStart { id: String },
    #[serde(rename = "reasoning_delta")]
    ReasoningDelta { id: String, delta: String },
    #[serde(rename = "reasoning_end")]
    ReasoningEnd { id: String },

    // ── Tool call lifecycle ─────────────────────────────────────────
    #[serde(rename = "tool_input_start")]
    ToolInputStart {
        tool_call_id: String,
        tool_name: String,
    },
    #[serde(rename = "tool_input_delta")]
    ToolInputDelta {
        tool_call_id: String,
        input_text_delta: String,
    },
    #[serde(rename = "tool_input_available")]
    ToolInputAvailable {
        tool_call_id: String,
        tool_name: String,
        input: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        thought_signature: Option<String>,
    },

    // ── Session lifecycle ───────────────────────────────────────────
    #[serde(rename = "start_step")]
    #[allow(dead_code)] // Reserved for protocol
    StartStep,
    #[serde(rename = "finish_step")]
    FinishStep,

    // ── Usage / metadata ────────────────────────────────────────────
    #[serde(rename = "usage")]
    Usage {
        input_tokens: i64,
        output_tokens: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_creation_input_tokens: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cache_read_input_tokens: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        openai_cached_tokens: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cached_content_tokens: Option<i64>,
    },
    #[serde(rename = "stop_reason")]
    StopReason { reason: String },

    // ── Status (transient info like retry notices) ─────────────────
    #[serde(rename = "status")]
    Status { message: String },

    // ── Error ───────────────────────────────────────────────────────
    #[serde(rename = "error")]
    Error { error_text: String },

    // ── Terminal ─────────────────────────────────────────────────────
    #[serde(rename = "done")]
    Done,
}

/// Helper to emit a StreamChunk on the typed channel for a given stream_id.
pub fn emit_chunk(app: &AppHandle, stream_id: &str, chunk: StreamChunk) {
    let _ = app.emit(&format!("chat-chunk-{}", stream_id), &chunk);
}

/// Batched text emitter that accumulates text deltas and flushes them
/// periodically (16ms / 256 chars) to reduce IPC overhead.
pub struct TextBatcher {
    text_block_id: String,
    batch: String,
    last_emit: std::time::Instant,
    started: bool,
}

impl TextBatcher {
    pub fn new(text_block_id: String) -> Self {
        Self {
            text_block_id,
            batch: String::with_capacity(1024),
            last_emit: std::time::Instant::now(),
            started: false,
        }
    }

    /// Push text content. Returns true if a flush was performed.
    pub fn push(&mut self, text: &str, app: &AppHandle, stream_id: &str) -> bool {
        if !self.started {
            emit_chunk(app, stream_id, StreamChunk::TextStart {
                id: self.text_block_id.clone(),
            });
            self.started = true;
        }
        self.batch.push_str(text);
        let batch_interval = std::time::Duration::from_millis(16);
        if self.last_emit.elapsed() >= batch_interval || self.batch.len() > 256 {
            self.flush(app, stream_id);
            return true;
        }
        false
    }

    /// Flush any remaining batched text.
    pub fn flush(&mut self, app: &AppHandle, stream_id: &str) {
        if !self.batch.is_empty() {
            emit_chunk(app, stream_id, StreamChunk::TextDelta {
                id: self.text_block_id.clone(),
                delta: std::mem::take(&mut self.batch),
            });
            self.last_emit = std::time::Instant::now();
        }
    }

    /// Close the text block (flush + emit TextEnd). Returns whether it was started.
    pub fn close(&mut self, app: &AppHandle, stream_id: &str) -> bool {
        if self.started {
            self.flush(app, stream_id);
            emit_chunk(app, stream_id, StreamChunk::TextEnd {
                id: self.text_block_id.clone(),
            });
            self.started = false;
            return true;
        }
        false
    }

    pub fn started(&self) -> bool {
        self.started
    }
}

/// Batched reasoning emitter (same pattern as TextBatcher but for reasoning blocks).
pub struct ReasoningBatcher {
    block_id: String,
    batch: String,
    last_emit: std::time::Instant,
    started: bool,
}

impl ReasoningBatcher {
    pub fn new(block_id: String) -> Self {
        Self {
            block_id,
            batch: String::with_capacity(1024),
            last_emit: std::time::Instant::now(),
            started: false,
        }
    }

    pub fn push(&mut self, text: &str, app: &AppHandle, stream_id: &str) {
        if !self.started {
            emit_chunk(app, stream_id, StreamChunk::ReasoningStart {
                id: self.block_id.clone(),
            });
            self.started = true;
        }
        self.batch.push_str(text);
        let batch_interval = std::time::Duration::from_millis(16);
        if self.last_emit.elapsed() >= batch_interval || self.batch.len() > 256 {
            self.flush(app, stream_id);
        }
    }

    pub fn flush(&mut self, app: &AppHandle, stream_id: &str) {
        if !self.batch.is_empty() {
            emit_chunk(app, stream_id, StreamChunk::ReasoningDelta {
                id: self.block_id.clone(),
                delta: std::mem::take(&mut self.batch),
            });
            self.last_emit = std::time::Instant::now();
        }
    }

    pub fn close(&mut self, app: &AppHandle, stream_id: &str) -> bool {
        if self.started {
            self.flush(app, stream_id);
            emit_chunk(app, stream_id, StreamChunk::ReasoningEnd {
                id: self.block_id.clone(),
            });
            self.started = false;
            return true;
        }
        false
    }

    pub fn started(&self) -> bool {
        self.started
    }
}

/// Generate a unique block ID using nanosecond timestamp + counter.
pub fn next_block_id(counter: &mut u32) -> String {
    *counter += 1;
    format!("blk_{}_{}", 
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
        counter
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_chunk_text_delta_serde_round_trip() {
        let c = StreamChunk::TextDelta {
            id: "t1".to_string(),
            delta: "hi".to_string(),
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v.get("type").and_then(|x| x.as_str()), Some("text_delta"));
        assert_eq!(v.get("id").and_then(|x| x.as_str()), Some("t1"));
    }

    #[test]
    fn next_block_id_increments_counter() {
        let mut n = 0u32;
        let a = next_block_id(&mut n);
        let b = next_block_id(&mut n);
        assert_ne!(a, b);
        assert_eq!(n, 2);
        assert!(a.starts_with("blk_"));
    }

    #[test]
    fn stream_chunk_usage_omits_optional_token_fields_when_none() {
        let c = StreamChunk::Usage {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
            openai_cached_tokens: None,
            cached_content_tokens: None,
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v.get("type"), Some(&serde_json::json!("usage")));
        assert_eq!(v.get("input_tokens"), Some(&serde_json::json!(1)));
        assert!(!v.as_object().unwrap().contains_key("cache_creation_input_tokens"));
    }

    #[test]
    fn stream_chunk_tool_input_available_serializes_input_json() {
        let c = StreamChunk::ToolInputAvailable {
            tool_call_id: "c1".to_string(),
            tool_name: "batch".to_string(),
            input: serde_json::json!({"q": "x"}),
            thought_signature: None,
        };
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v.get("type"), Some(&serde_json::json!("tool_input_available")));
        assert!(!v.as_object().unwrap().contains_key("thought_signature"));
        assert_eq!(v.pointer("/input/q"), Some(&serde_json::json!("x")));
    }

    #[test]
    fn stream_chunk_done_and_error_serialize() {
        let d = serde_json::to_value(&StreamChunk::Done).unwrap();
        assert_eq!(d.get("type"), Some(&serde_json::json!("done")));
        let e = StreamChunk::Error {
            error_text: "oops".to_string(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v.get("type"), Some(&serde_json::json!("error")));
        assert_eq!(v.get("error_text"), Some(&serde_json::json!("oops")));
    }
}
