use crate::handlers::Handlers;
use crate::protocol::*;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, info, warn};

pub struct Transport {
    handlers: Handlers,
}

pub(crate) enum ProcessLineOutcome {
    NoResponse,
    Respond(JsonRpcResponse),
}

impl Transport {
    pub fn new() -> Self {
        Self {
            handlers: Handlers::new(),
        }
    }

    pub async fn run(&mut self) -> io::Result<()> {
        let stdin = tokio::io::stdin();
        let mut stdin = BufReader::new(stdin);
        let mut stdout = tokio::io::stdout();
        let mut line = String::new();
        let mut initialized = false;

        loop {
            line.clear();
            let bytes_read = stdin.read_line(&mut line).await?;

            if bytes_read == 0 {
                // EOF
                break;
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            debug!("Received: {}", trimmed);

            match self.process_line(trimmed, &mut initialized).await? {
                ProcessLineOutcome::NoResponse => {}
                ProcessLineOutcome::Respond(response) => {
                    self.write_response(&mut stdout, response).await?;
                }
            }
        }

        Ok(())
    }

    /// Core JSON-RPC line handling (stdin/stdout-free for unit tests).
    pub(crate) async fn process_line(
        &mut self,
        line: &str,
        initialized: &mut bool,
    ) -> io::Result<ProcessLineOutcome> {
        if line.is_empty() {
            return Ok(ProcessLineOutcome::NoResponse);
        }

        let request: JsonRpcRequest = match serde_json::from_str(line) {
            Ok(req) => req,
            Err(e) => {
                warn!("Failed to parse request: {}", e);
                let id = serde_json::from_str::<serde_json::Value>(line)
                    .ok()
                    .and_then(|v| v.get("id").cloned())
                    .filter(|v| !v.is_null());
                let response = JsonRpcResponse::error(
                    id,
                    -32700, // Parse error
                    format!("Parse error: {}", e),
                );
                return Ok(ProcessLineOutcome::Respond(response));
            }
        };

        // JSON-RPC 2.0: notifications have no id and must not receive a response
        if request.id.is_none() {
            if request.method == "notifications/initialized" {
                debug!("Received initialized notification");
            } else if request.method.starts_with("notifications/") {
                debug!("Received notification: {}", request.method);
            } else {
                debug!("Received notification (no id): {}", request.method);
            }
            return Ok(ProcessLineOutcome::NoResponse);
        }

        // Handle initialize specially (must be first)
        if request.method == "initialize" {
            let response = self.handle_initialize(&request).await;
            *initialized = true;
            return Ok(ProcessLineOutcome::Respond(response));
        }

        if !*initialized && request.method != "initialize" {
            let response = JsonRpcResponse::error(
                request.id,
                -32002, // Server not initialized
                "Server not initialized. Call initialize first.".to_string(),
            );
            return Ok(ProcessLineOutcome::Respond(response));
        }

        let response = self.handle_request(&request).await;
        Ok(ProcessLineOutcome::Respond(response))
    }

    async fn handle_initialize(&mut self, request: &JsonRpcRequest) -> JsonRpcResponse {
        let params: InitializeParams = match request.params.as_ref() {
            Some(p) => match serde_json::from_value(p.clone()) {
                Ok(p) => p,
                Err(e) => {
                    return JsonRpcResponse::error(
                        request.id.clone(),
                        -32602, // Invalid params
                        format!("Invalid initialize params: {}", e),
                    );
                }
            },
            None => {
                return JsonRpcResponse::error(
                    request.id.clone(),
                    -32602, // Invalid params
                    "Missing initialize params".to_string(),
                );
            }
        };

        // Detect client type
        let client_name = params
            .client_info
            .as_ref()
            .map(|c| c.name.to_lowercase())
            .unwrap_or_default();

        if client_name.contains("cursor") {
            info!("Detected MCP client: Cursor");
        } else if client_name.contains("vscode") || client_name.contains("visual studio code") {
            info!("Detected MCP client: VS Code");
        } else {
            info!("Detected MCP client: unknown");
        }

        let result = InitializeResult {
            protocol_version: params.protocol_version,
            capabilities: Capabilities {
                tools: serde_json::json!({}),
            },
            server_info: ServerInfo {
                name: "atls".to_string(),
                version: "1.2.0".to_string(),
            },
        };

        JsonRpcResponse::success(request.id.clone(), serde_json::to_value(result).unwrap())
    }

    async fn handle_request(&mut self, request: &JsonRpcRequest) -> JsonRpcResponse {
        match request.method.as_str() {
            "tools/list" => {
                let tools = self.handlers.list_tools();
                let result = ListToolsResult { tools };
                JsonRpcResponse::success(
                    request.id.clone(),
                    serde_json::to_value(result).unwrap(),
                )
            }
            "tools/call" => {
                let params: CallToolParams = match request.params.as_ref() {
                    Some(p) => match serde_json::from_value(p.clone()) {
                        Ok(p) => p,
                        Err(e) => {
                            return JsonRpcResponse::error(
                                request.id.clone(),
                                -32602, // Invalid params
                                format!("Invalid callTool params: {}", e),
                            );
                        }
                    },
                    None => {
                        return JsonRpcResponse::error(
                            request.id.clone(),
                            -32602, // Invalid params
                            "Missing callTool params".to_string(),
                        );
                    }
                };

                match self.handlers.call_tool(&params.name, params.arguments).await {
                    Ok(result) => {
                        let call_tool_result = serde_json::json!({
                            "content": [{
                                "type": "text",
                                "text": serde_json::to_string(&result).unwrap_or_default()
                            }]
                        });
                        JsonRpcResponse::success(request.id.clone(), call_tool_result)
                    }
                    Err(e) => {
                        let error_result = serde_json::json!({
                            "content": [{
                                "type": "text",
                                "text": format!("Error: {}", e)
                            }],
                            "isError": true
                        });
                        JsonRpcResponse::success(request.id.clone(), error_result)
                    }
                }
            }
            _ => JsonRpcResponse::error(
                request.id.clone(),
                -32601, // Method not found
                format!("Unknown method: {}", request.method),
            ),
        }
    }

    async fn write_response(&mut self, stdout: &mut tokio::io::Stdout, response: JsonRpcResponse) -> io::Result<()> {
        let json = serde_json::to_string(&response)?;
        debug!("Sending: {}", json);
        stdout.write_all(json.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error(resp: &JsonRpcResponse, code: i32) {
        let err = resp.error.as_ref().expect("expected error");
        assert_eq!(err.code, code);
    }

    #[tokio::test]
    async fn parse_error_includes_id_when_present_in_raw_json() {
        let mut t = Transport::new();
        let mut init = false;
        // Valid JSON object but not a valid JsonRpcRequest (missing `method`).
        let line = r#"{"jsonrpc":"2.0","id":7}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        let ProcessLineOutcome::Respond(resp) = out else {
            panic!("expected response");
        };
        assert_error(&resp, -32700);
        assert_eq!(resp.id, Some(serde_json::json!(7)));
    }

    #[tokio::test]
    async fn notification_initialized_branch() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        assert!(matches!(out, ProcessLineOutcome::NoResponse));
    }

    #[tokio::test]
    async fn notification_other_notifications_prefix_branch() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","method":"notifications/foo"}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        assert!(matches!(out, ProcessLineOutcome::NoResponse));
    }

    #[tokio::test]
    async fn notification_other_no_id_branch() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","method":"$/progress"}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        assert!(matches!(out, ProcessLineOutcome::NoResponse));
    }

    #[tokio::test]
    async fn not_initialized_rejects_tools_list() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        let ProcessLineOutcome::Respond(resp) = out else {
            panic!("expected response");
        };
        assert_error(&resp, -32002);
    }

    #[tokio::test]
    async fn initialize_cursor_client_branch() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"Cursor"}}}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        let ProcessLineOutcome::Respond(resp) = out else {
            panic!("expected response");
        };
        assert!(resp.error.is_none());
        assert!(init);
    }

    #[tokio::test]
    async fn initialize_vscode_client_branch() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"Visual Studio Code"}}}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        let ProcessLineOutcome::Respond(resp) = out else {
            panic!("expected response");
        };
        assert!(resp.error.is_none());
    }

    #[tokio::test]
    async fn initialize_unknown_client_branch() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"Other"}}}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        let ProcessLineOutcome::Respond(resp) = out else {
            panic!("expected response");
        };
        assert!(resp.error.is_none());
    }

    #[tokio::test]
    async fn initialize_missing_params_errors() {
        let mut t = Transport::new();
        let mut init = false;
        let line = r#"{"jsonrpc":"2.0","id":0,"method":"initialize"}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        let ProcessLineOutcome::Respond(resp) = out else {
            panic!("expected response");
        };
        assert_error(&resp, -32602);
        assert!(init);
    }

    #[tokio::test]
    async fn unknown_method_after_init() {
        let mut t = Transport::new();
        let mut init = true;
        let line = r#"{"jsonrpc":"2.0","id":2,"method":"nope"}"#;
        let out = t.process_line(line, &mut init).await.unwrap();
        let ProcessLineOutcome::Respond(resp) = out else {
            panic!("expected response");
        };
        assert_error(&resp, -32601);
    }
}
