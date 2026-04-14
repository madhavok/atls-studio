//! Selection boosts applied during search (`symbol_search_boost`).

use crate::db::Database;
use crate::query::QueryError;
use rusqlite::params;
use std::collections::HashMap;

/// Increment boost when a user selects a symbol from search results.
pub fn record_symbol_selection(db: &Database, symbol_id: i64, delta: f64) -> Result<(), QueryError> {
    let conn = db.conn();
    conn.execute(
        r#"
        INSERT INTO symbol_search_boost (symbol_id, boost)
        VALUES (?1, ?2)
        ON CONFLICT(symbol_id) DO UPDATE SET
            boost = symbol_search_boost.boost + excluded.boost,
            updated_at = unixepoch()
        "#,
        params![symbol_id, delta],
    )?;
    Ok(())
}

#[must_use]
pub fn load_boosts_for_symbols(db: &Database, symbol_ids: &[i64]) -> HashMap<i64, f64> {
    let conn = db.conn();
    load_boosts_with_conn(&conn, symbol_ids)
}

#[must_use]
pub fn load_boosts_with_conn(conn: &rusqlite::Connection, symbol_ids: &[i64]) -> HashMap<i64, f64> {
    if symbol_ids.is_empty() {
        return HashMap::new();
    }
    let mut out = HashMap::new();
    for &sid in symbol_ids {
        if let Ok(b) = conn.query_row(
            "SELECT boost FROM symbol_search_boost WHERE symbol_id = ?1",
            params![sid],
            |row| row.get::<_, f64>(0),
        ) {
            if b.abs() > f64::EPSILON {
                out.insert(sid, b);
            }
        }
    }
    out
}
