use crate::handlers::Handlers;
use crate::protocol::*;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, info, warn};

pub struct Transport {
    handlers: Handlers,
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

            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            debug!("Received: {}", line);

            // Parse JSON-RPC request
            let request: JsonRpcRequest = match serde_json::from_str(line) {
                Ok(req) => req,
                Err(e) => {
                    warn!("Failed to parse request: {}", e);
                    // Try to extract id from raw JSON for better error correlation
                    let id = serde_json::from_str::<serde_json::Value>(line)
                        .ok()
                        .and_then(|v| v.get("id").cloned())
                        .filter(|v| !v.is_null());
                    let response = JsonRpcResponse::error(
                        id,
                        -32700, // Parse error
                        format!("Parse error: {}", e),
                    );
                    self.write_response(&mut stdout, response).await?;
                    continue;
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
                continue;
            }

            // Handle initialize specially (must be first)
            if request.method == "initialize" {
                let response = self.handle_initialize(&request).await;
                self.write_response(&mut stdout, response).await?;
                initialized = true;
                continue;
            }

            if !initialized && request.method != "initialize" {
                let response = JsonRpcResponse::error(
                    request.id,
                    -32002, // Server not initialized
                    "Server not initialized. Call initialize first.".to_string(),
                );
                self.write_response(&mut stdout, response).await?;
                continue;
            }

            // Handle other requests
            let response = self.handle_request(&request).await;
            self.write_response(&mut stdout, response).await?;
        }

        Ok(())
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
