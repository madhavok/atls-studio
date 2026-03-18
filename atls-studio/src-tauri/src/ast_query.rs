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
