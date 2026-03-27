use super::*;

// ============================================================================
// Chat Database Commands
// ============================================================================

#[tauri::command]
pub async fn chat_db_init(project_path: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    state.init(&project_path)
}

#[tauri::command]
pub async fn chat_db_close(state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    state.close()
}

#[tauri::command]
pub async fn chat_db_create_session(
    id: String, 
    title: String, 
    mode: String, 
    is_swarm: bool,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::create_session(&state, &id, &title, &mode, is_swarm)
}

#[tauri::command]
pub async fn chat_db_get_sessions(limit: i64, state: tauri::State<'_, ChatDbState>) -> Result<Vec<chat_db::DbSession>, String> {
    chat_db::get_sessions(&state, limit)
}

#[tauri::command]
pub async fn chat_db_get_session(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Option<chat_db::DbSession>, String> {
    chat_db::get_session(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_update_session_title(session_id: String, title: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::update_session_title(&state, &session_id, &title)
}

#[tauri::command]
pub async fn chat_db_update_session_mode(session_id: String, mode: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::update_session_mode(&state, &session_id, &mode)
}

#[tauri::command]
pub async fn chat_db_update_swarm_status(session_id: String, status: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::update_swarm_status(&state, &session_id, &status)
}

#[tauri::command]
pub async fn chat_db_update_context_usage(
    session_id: String,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cost_cents: Option<f64>,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::update_context_usage(&state, &session_id, input_tokens, output_tokens, total_tokens, cost_cents.unwrap_or(0.0))
}

#[tauri::command]
pub async fn chat_db_delete_session(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::delete_session(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_add_message(
    id: String,
    session_id: String,
    role: String,
    content: String,
    agent_id: Option<String>,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::add_message(&state, &id, &session_id, &role, &content, agent_id.as_deref())
}

#[tauri::command]
pub async fn chat_db_get_messages(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Vec<chat_db::DbMessage>, String> {
    chat_db::get_messages(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_add_segments(
    message_id: String, 
    segments: Vec<chat_db::SegmentInput>,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::add_segments(&state, &message_id, segments)
}

#[tauri::command]
pub async fn chat_db_get_segments(message_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Vec<chat_db::DbSegment>, String> {
    chat_db::get_segments(&state, &message_id)
}

#[tauri::command]
pub async fn chat_db_add_blackboard_entry(
    session_id: String,
    hash: String,
    short_hash: String,
    entry_type: String,
    source: Option<String>,
    content: String,
    tokens: i64,
    pinned: bool,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::add_blackboard_entry(&state, &session_id, &hash, &short_hash, &entry_type, source.as_deref(), &content, tokens, pinned)
}

#[tauri::command]
pub async fn chat_db_get_blackboard_entries(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Vec<chat_db::DbBlackboardEntry>, String> {
    chat_db::get_blackboard_entries(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_get_content_by_hash(
    session_id: String,
    hash: String,
    state: tauri::State<'_, ChatDbState>
) -> Result<Option<(String, Option<String>)>, String> {
    chat_db::get_content_by_hash(&state, &session_id, &hash)
}

#[tauri::command]
pub async fn chat_db_update_blackboard_pinned(
    session_id: String, 
    short_hash: String, 
    pinned: bool,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::update_blackboard_pinned(&state, &session_id, &short_hash, pinned)
}

#[tauri::command]
pub async fn chat_db_remove_blackboard_entries(
    session_id: String, 
    short_hashes: Vec<String>,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::remove_blackboard_entries(&state, &session_id, short_hashes)
}

#[tauri::command]
pub async fn chat_db_clear_blackboard(
    session_id: String, 
    keep_pinned: bool,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::clear_blackboard(&state, &session_id, keep_pinned)
}

#[tauri::command]
pub async fn chat_db_create_task(
    id: String,
    session_id: String,
    parent_task_id: Option<String>,
    title: String,
    description: Option<String>,
    assigned_model: Option<String>,
    assigned_role: Option<String>,
    context_hashes: Option<String>,
    file_claims: Option<String>,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::create_task(
        &state, &id, &session_id, parent_task_id.as_deref(), &title, 
        description.as_deref(), assigned_model.as_deref(), assigned_role.as_deref(),
        context_hashes.as_deref(), file_claims.as_deref()
    )
}

#[tauri::command]
pub async fn chat_db_get_tasks(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Vec<chat_db::DbTask>, String> {
    chat_db::get_tasks(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_get_task(task_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Option<chat_db::DbTask>, String> {
    chat_db::get_task(&state, &task_id)
}

#[tauri::command]
pub async fn chat_db_update_task_status(task_id: String, status: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::update_task_status(&state, &task_id, &status)
}

#[tauri::command]
pub async fn chat_db_update_task_result(task_id: String, result: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::update_task_result(&state, &task_id, &result)
}

#[tauri::command]
pub async fn chat_db_update_task_error(task_id: String, error: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::update_task_error(&state, &task_id, &error)
}

#[tauri::command]
pub async fn chat_db_update_task_stats(task_id: String, tokens_used: i64, cost_cents: i64, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::update_task_stats(&state, &task_id, tokens_used, cost_cents)
}

#[tauri::command]
pub async fn chat_db_record_agent_stats(
    session_id: String,
    task_id: String,
    model: String,
    input_tokens: i64,
    output_tokens: i64,
    cost_cents: i64,
    state: tauri::State<'_, ChatDbState>
) -> Result<(), String> {
    chat_db::record_agent_stats(&state, &session_id, &task_id, &model, input_tokens, output_tokens, cost_cents)
}

#[tauri::command]
pub async fn chat_db_get_agent_stats(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Vec<chat_db::DbAgentStats>, String> {
    chat_db::get_agent_stats(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_get_session_total_stats(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<chat_db::TotalStats, String> {
    chat_db::get_session_total_stats(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_set_note(session_id: String, key: String, content: String, note_state: Option<String>, file_path: Option<String>, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::set_blackboard_note(&state, &session_id, &key, &content, note_state.as_deref(), file_path.as_deref())
}

#[tauri::command]
pub async fn chat_db_get_notes(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<Vec<chat_db::DbBlackboardNote>, String> {
    chat_db::get_blackboard_notes(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_delete_note(session_id: String, key: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::delete_blackboard_note(&state, &session_id, &key)
}

#[tauri::command]
pub async fn chat_db_clear_notes(session_id: String, state: tauri::State<'_, ChatDbState>) -> Result<(), String> {
    chat_db::clear_blackboard_notes(&state, &session_id)
}

// ============================================================================
// Archived Chunks Persistence
// ============================================================================

#[tauri::command]
pub async fn chat_db_save_archived_chunks(
    session_id: String,
    chunks: Vec<chat_db::ArchivedChunkInput>,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::save_archived_chunks(&state, &session_id, chunks)
}

#[tauri::command]
pub async fn chat_db_get_archived_chunks(
    session_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Vec<chat_db::DbArchivedChunk>, String> {
    chat_db::get_archived_chunks(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_clear_archived_chunks(
    session_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::clear_archived_chunks(&state, &session_id)
}

// ============================================================================
// Session State Persistence
// ============================================================================

#[tauri::command]
pub async fn chat_db_set_session_state(
    session_id: String,
    key: String,
    value: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::set_session_state(&state, &session_id, &key, &value)
}

#[tauri::command]
pub async fn chat_db_get_session_state(
    session_id: String,
    key: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Option<String>, String> {
    chat_db::get_session_state(&state, &session_id, &key)
}

#[tauri::command]
pub async fn chat_db_get_all_session_state(
    session_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Vec<chat_db::DbSessionState>, String> {
    chat_db::get_all_session_state(&state, &session_id)
}

#[tauri::command]
pub async fn chat_db_set_session_state_batch(
    session_id: String,
    entries: Vec<(String, String)>,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::set_session_state_batch(&state, &session_id, entries)
}

#[tauri::command]
pub async fn chat_db_save_memory_snapshot(
    session_id: String,
    snapshot_json: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::save_memory_snapshot(&state, &session_id, &snapshot_json)
}

#[tauri::command]
pub async fn chat_db_get_memory_snapshot(
    session_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Option<String>, String> {
    chat_db::get_memory_snapshot(&state, &session_id)
}

// ============================================================================
// Message Edit / Restore
// ============================================================================

#[tauri::command]
pub async fn chat_db_delete_messages_after(
    session_id: String,
    message_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<i64, String> {
    chat_db::delete_messages_after(&state, &session_id, &message_id)
}

#[tauri::command]
pub async fn chat_db_delete_messages_from(
    session_id: String,
    message_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<i64, String> {
    chat_db::delete_messages_from(&state, &session_id, &message_id)
}

#[tauri::command]
pub async fn chat_db_update_message_content(
    message_id: String,
    content: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::update_message_content(&state, &message_id, &content)
}

// ============================================================================
// Staged Snippets Persistence
// ============================================================================

#[tauri::command]
pub async fn chat_db_save_staged_snippets(
    session_id: String,
    snippets: Vec<chat_db::StagedSnippetInput>,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::save_staged_snippets(&state, &session_id, snippets)
}

#[tauri::command]
pub async fn chat_db_get_staged_snippets(
    session_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Vec<chat_db::DbStagedSnippet>, String> {
    chat_db::get_staged_snippets(&state, &session_id)
}

// ============================================================================
// HPP v3: Hash Registry Persistence
// ============================================================================

#[tauri::command]
pub async fn chat_db_register_hash(
    session_id: String,
    hash: String,
    source: Option<String>,
    tokens: i64,
    lang: Option<String>,
    line_count: i64,
    symbol_count: Option<i64>,
    chunk_type: Option<String>,
    subtask_id: Option<String>,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    let short_hash = if hash.len() >= hash_resolver::SHORT_HASH_LEN { hash[..hash_resolver::SHORT_HASH_LEN].to_string() } else { hash.clone() };
    chat_db::register_hash(
        &state, &session_id, &hash, &short_hash,
        source.as_deref(), tokens, lang.as_deref(),
        line_count, symbol_count, chunk_type.as_deref(), subtask_id.as_deref(),
    )
}

#[tauri::command]
pub async fn chat_db_get_hash_entry(
    session_id: String,
    hash: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Option<chat_db::DbHashRegistryEntry>, String> {
    chat_db::get_hash_registry_entry(&state, &session_id, &hash)
}

#[tauri::command]
pub async fn chat_db_get_session_hashes(
    session_id: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Vec<chat_db::DbHashRegistryEntry>, String> {
    chat_db::get_session_hash_registry(&state, &session_id)
}

// ============================================================================
// Shadow Version Commands (hash forwarding rollback)
// ============================================================================

#[tauri::command]
pub async fn chat_db_insert_shadow_version(
    session_id: String,
    source_path: String,
    hash: String,
    content: String,
    replaced_by: Option<String>,
    state: tauri::State<'_, ChatDbState>,
) -> Result<(), String> {
    chat_db::insert_shadow_version(
        &state,
        &session_id,
        &source_path,
        &hash,
        &content,
        replaced_by.as_deref(),
    )
}

#[tauri::command]
pub async fn chat_db_list_shadow_versions(
    session_id: String,
    source_path: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Vec<chat_db::DbShadowVersion>, String> {
    chat_db::list_shadow_versions(&state, &session_id, &source_path)
}

#[tauri::command]
pub async fn chat_db_get_shadow_version(
    session_id: String,
    hash: String,
    state: tauri::State<'_, ChatDbState>,
) -> Result<Option<chat_db::DbShadowVersion>, String> {
    chat_db::get_shadow_version(&state, &session_id, &hash)
}
