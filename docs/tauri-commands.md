# Tauri command inventory

IPC command names registered in [`atls-studio/src-tauri/src/lib.rs`](../atls-studio/src-tauri/src/lib.rs) (`tauri::generate_handler![...]`). The list below is for navigation and `invoke('…')` lookup; behavior is documented per module in [tauri-backend.md](./tauri-backend.md).

**Note:** Command names are the Rust function names (snake_case) exposed to the frontend.

## File system

- `get_file_tree`, `read_file_contents`, `expand_file_glob`, `write_file_contents`, `write_design_file`, `delete_path`, `rename_path`, `create_file`, `create_folder`, `create_project_directory`, `add_to_atlsignore`, `remove_from_atlsignore`, `copy_path`, `read_file_as_base64`
- `read_file_signatures`, `compress_and_read_image`, `compress_image_bytes` (attachments)

## File watcher

- `start_file_watcher`, `stop_file_watcher`

## ATLS bridge

- `atls_init`, `atls_dispose`, `atls_add_root`, `atls_remove_root`, `atls_set_active_root`, `atls_get_roots`, `atls_save_workspace`, `atls_open_workspace`, `atls_get_workspaces`, `get_scan_status`, `get_issue_counts`, `find_issues`, `scan_project`, `get_focus_profiles`, `save_focus_profiles`

## Code intelligence

- `atls_search_code`, `atls_get_symbol_usage`, `atls_get_file_context`, `atls_diagnose_symbols`, `atls_get_project_profile`, `atls_get_database_stats`, `atls_get_language_health`, `atls_get_workspace_scripts`, `atls_batch_query`

## Search / legacy

- `search_text`, `search_files`, `get_symbol_usage`, `execute_command` (deprecated; prefer PTY)

## PTY terminal

- `spawn_pty`, `write_pty`, `resize_pty`, `kill_pty`, `is_pty_busy`, `write_agent_exec_ps1`, `remove_temp_file`

## AI execution

- `ai_execute`, `ai_execute_background`, `ai_get_background_output`, `ai_kill_background`

## Tokenizer (BPE)

- `count_tokens`, `count_tokens_batch`, `count_tool_def_tokens`

## AI streaming

- `stream_chat_anthropic`, `estimate_tool_def_tokens`, `stream_chat_openai`, `stream_chat_lmstudio`, `stream_chat_google`, `stream_chat_vertex` (implemented in `gemini_cache`; other stream handlers in `ai_streaming`), `cancel_chat_stream`, `cancel_all_chat_streams`

## Gemini cache

- `gemini_create_cache`, `gemini_refresh_cache`, `gemini_delete_cache`, `gemini_get_cache_name`

## Model lists

- `fetch_anthropic_models`, `fetch_openai_models`, `fetch_lmstudio_models`, `fetch_google_models`, `fetch_vertex_models`

## Chat database and session

- `chat_db_init`, `chat_db_close`, `chat_db_create_session`, `chat_db_get_sessions`, `chat_db_get_session`, `chat_db_update_session_title`, `chat_db_update_session_mode`, `chat_db_update_swarm_status`, `chat_db_update_context_usage`, `chat_db_delete_session`, `chat_db_add_message`, `chat_db_get_messages`, `chat_db_add_segments`, `chat_db_get_segments`, `chat_db_delete_segments`, `chat_db_replace_segments`, `chat_db_add_blackboard_entry`, `chat_db_get_blackboard_entries`, `chat_db_get_content_by_hash`, `chat_db_update_blackboard_pinned`, `chat_db_remove_blackboard_entries`, `chat_db_clear_blackboard`, `chat_db_create_task`, `chat_db_get_tasks`, `chat_db_get_task`, `chat_db_update_task_status`, `chat_db_update_task_result`, `chat_db_update_task_error`, `chat_db_update_task_stats`, `chat_db_record_agent_stats`, `chat_db_get_agent_stats`, `chat_db_get_session_total_stats`, `chat_db_set_note`, `chat_db_get_notes`, `chat_db_delete_note`, `chat_db_clear_notes`, `chat_db_save_archived_chunks`, `chat_db_get_archived_chunks`, `chat_db_clear_archived_chunks`, `chat_db_set_session_state`, `chat_db_get_session_state`, `chat_db_get_all_session_state`, `chat_db_set_session_state_batch`, `chat_db_save_memory_snapshot`, `chat_db_get_memory_snapshot`, `chat_db_delete_messages_after`, `chat_db_delete_messages_from`, `chat_db_delete_all_session_messages`, `chat_db_update_message_content`, `chat_db_save_staged_snippets`, `chat_db_get_staged_snippets`

## Hash / UHPP

- `scan_output_hash_refs`, `resolve_blackboard_display`, `resolve_hash_ref`, `resolve_temporal_ref`, `register_hash_content`, `batch_resolve_hash_refs`, `get_current_revisions`, `resolve_search_selector`, `chat_db_register_hash`, `chat_db_get_hash_entry`, `chat_db_get_session_hashes`

## Shadow versions (rollback)

- `chat_db_insert_shadow_version`, `chat_db_list_shadow_versions`, `chat_db_get_shadow_version`

When adding commands, update this file and the `generate_handler` block together.

**Maintenance:** The authoritative list is the `tauri::generate_handler![...]` macro invocation inside `.invoke_handler(...)` in [`lib.rs`](../atls-studio/src-tauri/src/lib.rs) (currently ~3289-3452). After editing Rust, diff the **contents of `generate_handler!`** against this file — searching for `invoke_handler` alone only finds the wrapper call; the command list lives inside the macro.
