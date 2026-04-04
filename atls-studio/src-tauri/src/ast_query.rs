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
