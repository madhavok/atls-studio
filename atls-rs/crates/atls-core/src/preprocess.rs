use std::path::Path;

/// Preprocess C/C++ source to strip macro invocations that confuse tree-sitter.
/// Returns `Some(preprocessed)` if any changes were made, `None` if content is clean.
pub fn preprocess_c_macros(content: &str, file_path: Option<&str>) -> Option<String> {
    let mut wrapper_macros: Vec<String> = Vec::new();
    let mut bare_macros: Vec<String> = Vec::new();

    collect_c_defines(content, &mut wrapper_macros, &mut bare_macros);

    if let Some(fp) = file_path {
        let dir = Path::new(fp).parent();
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("#include") {
                let rest = rest.trim();
                if rest.starts_with('"') {
                    let header_name = rest.trim_matches('"');
                    if let Some(parent) = dir {
                        let header_path = parent.join(header_name);
                        if let Ok(header_content) = std::fs::read_to_string(&header_path) {
                            collect_c_defines(&header_content, &mut wrapper_macros, &mut bare_macros);
                        }
                    }
                }
            }
        }
    }

    static C_BUILTINS: &[&str] = &[
        "sizeof", "typeof", "alignof", "offsetof", "_Alignof", "_Static_assert",
        "NULL", "EOF", "FILE", "TRUE", "FALSE", "BOOL",
    ];

    let re_wrapper = regex::Regex::new(r"\b([A-Z][A-Z0-9_]{2,})\(").ok();
    let re_bare_token = regex::Regex::new(r"\b([A-Z][A-Z0-9_]{2,})\b").ok();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            continue;
        }

        if let Some(ref re) = re_wrapper {
            for caps in re.captures_iter(trimmed) {
                let name = caps.get(1).unwrap().as_str();
                if name.len() >= 3
                    && !C_BUILTINS.iter().any(|b| b.eq_ignore_ascii_case(name))
                    && !wrapper_macros.contains(&name.to_string())
                    && (trimmed.starts_with(name)
                        || trimmed.starts_with(&format!("static {}", name))
                        || trimmed.starts_with(&format!("extern {}", name))
                        || trimmed.starts_with(&format!("inline {}", name))
                        || trimmed.contains(&format!("({}", name)))
                {
                    wrapper_macros.push(name.to_string());
                }
            }
        }

        if let Some(ref re) = re_bare_token {
            for caps in re.captures_iter(trimmed) {
                let name = caps.get(1).unwrap().as_str();
                let m = caps.get(1).unwrap();
                if name.len() >= 3
                    && !C_BUILTINS.iter().any(|b| b.eq_ignore_ascii_case(name))
                    && !bare_macros.contains(&name.to_string())
                    && !wrapper_macros.contains(&name.to_string())
                {
                    let before = &trimmed[..m.start()];
                    let after = &trimmed[m.end()..];
                    let before_is_type = before.trim().ends_with(|c: char| c.is_alphanumeric() || c == '*' || c == ' ');
                    let after_is_ident = after.trim_start().starts_with(|c: char| c.is_alphabetic() || c == '_' || c == '*');
                    if before_is_type && after_is_ident {
                        bare_macros.push(name.to_string());
                    }
                }
            }
        }
    }

    if wrapper_macros.is_empty() && bare_macros.is_empty() {
        return None;
    }

    let mut result = content.to_string();
    let mut changed = false;

    for macro_name in &wrapper_macros {
        let pattern = format!("{}(", macro_name);
        let mut new_result = String::with_capacity(result.len());
        for line in result.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                new_result.push_str(line);
                new_result.push('\n');
                continue;
            }
            let mut current = line.to_string();
            while let Some(pos) = current.find(&pattern) {
                let after_paren = pos + pattern.len();
                let mut depth = 1i32;
                let mut end = None;
                for (i, ch) in current[after_paren..].char_indices() {
                    match ch {
                        '(' => depth += 1,
                        ')' => {
                            depth -= 1;
                            if depth == 0 {
                                end = Some(after_paren + i);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                if let Some(close_pos) = end {
                    let inner = current[after_paren..close_pos].to_string();
                    current = format!("{}{}{}", &current[..pos], inner, &current[close_pos + 1..]);
                    changed = true;
                } else {
                    break;
                }
            }
            new_result.push_str(&current);
            new_result.push('\n');
        }
        if new_result.ends_with('\n') && !result.ends_with('\n') {
            new_result.pop();
        }
        result = new_result;
    }

    for macro_name in &bare_macros {
        let mut new_result = String::with_capacity(result.len());
        let paren_star = format!("({} *", macro_name);
        let star_macro = format!("* {} ", macro_name);
        let spaced = format!(" {} ", macro_name);
        for line in result.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('#') {
                new_result.push_str(line);
                new_result.push('\n');
                continue;
            }
            let mut current = line.to_string();
            let mut line_changed = false;
            if current.contains(&paren_star) {
                current = current.replace(&paren_star, "(*");
                line_changed = true;
            }
            if current.contains(&star_macro) {
                current = current.replace(&star_macro, "* ");
                line_changed = true;
            }
            if current.contains(&spaced) {
                current = current.replace(&spaced, " ");
                line_changed = true;
            }
            if line_changed {
                changed = true;
            }
            new_result.push_str(&current);
            new_result.push('\n');
        }
        if new_result.ends_with('\n') && !result.ends_with('\n') {
            new_result.pop();
        }
        result = new_result;
    }

    if changed { Some(result) } else { None }
}

/// Returns true if the file extension indicates C/C++ family.
pub fn is_c_family(ext: &str) -> bool {
    matches!(ext, "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hxx" | "hh")
}

fn collect_c_defines(content: &str, wrapper_macros: &mut Vec<String>, bare_macros: &mut Vec<String>) {
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("#define ") {
            let rest = rest.trim_start();
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if name.len() >= 3
                && name.chars().next().map_or(false, |c| c.is_uppercase())
                && name.chars().all(|c| c.is_uppercase() || c.is_ascii_digit() || c == '_')
            {
                let after_name = &rest[name.len()..];
                if after_name.starts_with('(') {
                    if !wrapper_macros.contains(&name) {
                        wrapper_macros.push(name);
                    }
                } else if !bare_macros.contains(&name) {
                    bare_macros.push(name);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wrapper_macro_expansion() {
        let input = r#"
#define CJSON_PUBLIC(type) type
CJSON_PUBLIC(cJSON *) cJSON_Parse(const char *value);
"#;
        let result = preprocess_c_macros(input, None).unwrap();
        assert!(result.contains("cJSON * cJSON_Parse"), "Expected expanded macro, got: {}", result);
        // #define line is preserved, but the usage line should not have the macro call
        let non_define_lines: Vec<&str> = result.lines()
            .filter(|l| !l.trim().starts_with('#') && !l.trim().is_empty())
            .collect();
        assert!(non_define_lines.iter().all(|l| !l.contains("CJSON_PUBLIC(")),
            "Non-preprocessor lines should not contain CJSON_PUBLIC(: {:?}", non_define_lines);
    }

    #[test]
    fn test_no_macros_returns_none() {
        let input = "int main() { return 0; }";
        assert!(preprocess_c_macros(input, None).is_none());
    }

    #[test]
    fn test_bare_macro_removal() {
        let input = r#"
#define CJSON_CDECL
void CJSON_CDECL some_func(void);
"#;
        let result = preprocess_c_macros(input, None).unwrap();
        // #define line is preserved, but the usage line should not have the macro
        let func_line = result.lines().find(|l| l.contains("some_func")).unwrap();
        assert!(!func_line.contains("CJSON_CDECL"), "Function line should not contain CJSON_CDECL: {}", func_line);
    }

    #[test]
    fn test_preprocessor_lines_untouched() {
        let input = r#"
#define CJSON_PUBLIC(type) __declspec(dllexport) type
#ifdef CJSON_PUBLIC
#endif
CJSON_PUBLIC(int) get_value(void);
"#;
        let result = preprocess_c_macros(input, None).unwrap();
        assert!(result.contains("#define CJSON_PUBLIC"));
        assert!(result.contains("#ifdef CJSON_PUBLIC"));
    }
}
