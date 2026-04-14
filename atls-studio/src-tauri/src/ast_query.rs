pub(crate) fn parse_ast_condition(condition: &str) -> String {
    if condition.is_empty() {
        return "1=1".to_string();
    }

    let mut clauses: Vec<String> = Vec::new();

    let parts: Vec<&str> = condition.split(" and ").collect();

    for part in parts {
        let part = part.trim();

        let (is_negated, check) = if part.starts_with("not ") {
            (true, &part[4..])
        } else {
            (false, part)
        };

        let clause = if check.starts_with("name ") || check.starts_with("name=") {
            if check.contains("contains") {
                let val = extract_quoted_value(check).unwrap_or("");
                format!("name LIKE '%{}%'", val)
            } else if check.contains("starts_with") {
                let val = extract_quoted_value(check).unwrap_or("");
                format!("name LIKE '{}%'", val)
            } else if check.contains("ends_with") {
                let val = extract_quoted_value(check).unwrap_or("");
                format!("name LIKE '%{}'", val)
            } else {
                let val = extract_quoted_value(check)
                    .map(|v| format!("'{}'", v))
                    .unwrap_or_else(|| {
                        let eq_val = if check.contains('=') {
                            check.splitn(2, '=').nth(1).unwrap_or("").trim()
                        } else {
                            check.splitn(2, ' ').nth(1).unwrap_or("").trim()
                        };
                        format!("'{}'", eq_val)
                    });
                format!("name = {}", val)
            }
        } else if check.starts_with("kind ") || check.starts_with("kind=") {
            let val = extract_quoted_value(check)
                .map(|v| format!("'{}'", v))
                .unwrap_or_else(|| {
                    let eq_val = if check.contains('=') {
                        check.splitn(2, '=').nth(1).unwrap_or("").trim()
                    } else {
                        check.splitn(2, ' ').nth(1).unwrap_or("").trim()
                    };
                    format!("'{}'", eq_val)
                });
            format!("kind = {}", val)
        } else if check.starts_with("complexity ") || check.starts_with("complexity>") || check.starts_with("complexity<") || check.starts_with("complexity=") {
            let op_and_val = check.trim_start_matches("complexity").trim();
            let (op, val) = if op_and_val.starts_with(">") {
                (">", op_and_val[1..].trim())
            } else if op_and_val.starts_with("<") {
                ("<", op_and_val[1..].trim())
            } else if op_and_val.starts_with("=") {
                ("=", op_and_val[1..].trim())
            } else {
                (">", op_and_val)
            };
            format!("complexity {} {}", op, val)
        } else if check.starts_with("lines ") || check.starts_with("lines>") || check.starts_with("lines<") || check.starts_with("lines=") {
            let op_and_val = check.trim_start_matches("lines").trim();
            let (op, val) = if op_and_val.starts_with(">") {
                (">", op_and_val[1..].trim())
            } else if op_and_val.starts_with("<") {
                ("<", op_and_val[1..].trim())
            } else if op_and_val.starts_with("=") {
                ("=", op_and_val[1..].trim())
            } else {
                (">", op_and_val)
            };
            format!("line_count {} {}", op, val)
        } else if check.starts_with("file ") || check.starts_with("file=") {
            let val = extract_quoted_value(check)
                .map(|v| format!("'%{}%'", v))
                .unwrap_or_else(|| {
                    let eq_val = if check.contains('=') {
                        check.splitn(2, '=').nth(1).unwrap_or("").trim()
                    } else {
                        check.splitn(2, ' ').nth(1).unwrap_or("").trim()
                    };
                    format!("'%{}%'", eq_val)
                });
            format!("file_path LIKE {}", val)
        } else if check.starts_with("returns ") || check.starts_with("returns>") || check.starts_with("returns<") || check.starts_with("returns=") {
            if check.contains("contains") {
                let val = extract_quoted_value(check).unwrap_or("");
                format!(
                    "LOWER(COALESCE(json_extract(s.metadata, '$.return_type'), '')) LIKE LOWER('%{}%')",
                    val.replace('\'', "''")
                )
            } else {
                let op_and_val = check.trim_start_matches("returns").trim();
                let (op, val) = if op_and_val.starts_with('>') {
                    (">", op_and_val[1..].trim())
                } else if op_and_val.starts_with('<') {
                    ("<", op_and_val[1..].trim())
                } else if op_and_val.starts_with('=') {
                    ("=", op_and_val[1..].trim())
                } else {
                    ("=", op_and_val)
                };
                format!(
                    "LOWER(COALESCE(json_extract(s.metadata, '$.return_type'), '')) {} LOWER('{}')",
                    op,
                    val.replace('\'', "''")
                )
            }
        } else if check.starts_with("params ") || check.starts_with("params>") || check.starts_with("params<") || check.starts_with("params=") {
            let op_and_val = check.trim_start_matches("params").trim();
            let (op, val) = if op_and_val.starts_with('>') {
                (">", op_and_val[1..].trim())
            } else if op_and_val.starts_with('<') {
                ("<", op_and_val[1..].trim())
            } else if op_and_val.starts_with('=') {
                ("=", op_and_val[1..].trim())
            } else {
                (">", op_and_val)
            };
            if let Ok(n) = val.parse::<i32>() {
                format!(
                    "COALESCE(json_array_length(json_extract(s.metadata, '$.parameters')), 0) {} {}",
                    op, n
                )
            } else {
                format!("name LIKE '%{}%'", check)
            }
        } else {
            format!("name LIKE '%{}%'", check)
        };

        if is_negated {
            clauses.push(format!("NOT ({})", clause));
        } else {
            clauses.push(clause);
        }
    }

    if clauses.is_empty() {
        "1=1".to_string()
    } else {
        clauses.join(" AND ")
    }
}

use atls_core::file::Language;
use atls_core::parser::languages::is_supported;
use atls_core::parser::{compile_query, execute_query, ParserRegistry};
use rusqlite::Connection;
use std::path::Path;

/// Run a tree-sitter query string over indexed files (disk read + parse). `file_filter` uses `f.path` from symbol SQL — normalized to `files.path`.
pub(crate) fn ast_query_treesitter_matches(
    project_root: &Path,
    conn: &Connection,
    file_filter: &str,
    language: &str,
    treesitter_query: &str,
    max_files: usize,
    max_total_matches: usize,
) -> Result<serde_json::Value, String> {
    let lang = Language::from_str(language);
    if lang == Language::Unknown || !is_supported(lang) {
        return Err(format!(
            "unsupported or unknown language for treesitter: {language}"
        ));
    }
    let q = compile_query(lang, treesitter_query).map_err(|e| e.to_string())?;
    let pred = file_filter.replace("f.path", "path");
    let sql = format!(
        "SELECT path FROM files WHERE ({}) AND LOWER(language) = LOWER(?) LIMIT ?",
        pred
    );
    let lang_db = language.to_string();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare files query: {e}"))?;
    let paths: Vec<String> = stmt
        .query_map(
            rusqlite::params![lang_db, max_files as i64],
            |row| row.get::<_, String>(0),
        )
        .map_err(|e| format!("query files: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let reg = ParserRegistry::new();
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut total = 0usize;
    for rel in paths {
        if total >= max_total_matches {
            break;
        }
        let abs = project_root.join(&rel);
        let Ok(src) = std::fs::read_to_string(&abs) else {
            continue;
        };
        let Ok(tree) = reg.parse(lang, &src) else {
            continue;
        };
        let Ok(qr) = execute_query(&q, &tree, src.as_bytes()) else {
            continue;
        };
        for m in qr.matches {
            if total >= max_total_matches {
                break;
            }
            let Some(cap) = m.get_offender() else {
                continue;
            };
            let line = cap.start_row as u32 + 1;
            out.push(serde_json::json!({
                "file": rel.replace('\\', "/"),
                "line": line,
                "byte_start": cap.start_byte,
                "byte_end": cap.end_byte,
            }));
            total += 1;
        }
    }

    Ok(serde_json::json!({
        "syntax_used": "treesitter",
        "language": language,
        "matches": out,
        "count": out.len(),
        "timed_out_hint": "Per-query timeout applies (see atls-core parser/query.rs)",
    }))
}

pub(crate) fn extract_quoted_value(s: &str) -> Option<&str> {
    let start = s.find('\'')?;
    let end = s[start + 1..].find('\'')?;
    Some(&s[start + 1..start + 1 + end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_condition_is_tautology() {
        assert_eq!(parse_ast_condition(""), "1=1");
    }

    #[test]
    fn extract_quoted_value_finds_first_pair() {
        assert_eq!(
            extract_quoted_value(r#"name contains 'foo'"#),
            Some("foo")
        );
        assert_eq!(extract_quoted_value("no quotes"), None);
    }

    #[test]
    fn parse_name_predicates() {
        assert_eq!(
            parse_ast_condition("name contains 'bar'"),
            "name LIKE '%bar%'"
        );
        assert_eq!(
            parse_ast_condition("name starts_with 'pre'"),
            "name LIKE 'pre%'"
        );
        assert_eq!(
            parse_ast_condition("name ends_with 'suf'"),
            "name LIKE '%suf'"
        );
        assert_eq!(
            parse_ast_condition("name = 'exact'"),
            "name = 'exact'"
        );
    }

    #[test]
    fn parse_kind_and_complexity() {
        assert_eq!(
            parse_ast_condition("kind = 'function'"),
            "kind = 'function'"
        );
        assert_eq!(
            parse_ast_condition("complexity > 5"),
            "complexity > 5"
        );
        assert_eq!(
            parse_ast_condition("lines < 100"),
            "line_count < 100"
        );
    }

    #[test]
    fn parse_file_and_fallback() {
        assert_eq!(
            parse_ast_condition("file = 'src/foo.rs'"),
            "file_path LIKE '%src/foo.rs%'"
        );
        assert_eq!(
            parse_ast_condition("unknown_token"),
            "name LIKE '%unknown_token%'"
        );
    }

    #[test]
    fn not_negates_clause() {
        let out = parse_ast_condition("not name contains 'x'");
        assert!(out.starts_with("NOT ("));
        assert!(out.contains("name LIKE '%x%'"));
    }

    #[test]
    fn multiple_and_joins() {
        let out = parse_ast_condition("kind = 'fn' and name contains 'foo'");
        assert_eq!(
            out,
            "kind = 'fn' AND name LIKE '%foo%'"
        );
    }
}
