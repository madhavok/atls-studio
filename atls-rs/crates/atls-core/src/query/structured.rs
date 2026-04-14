//! Explicit `key:value` filters plus optional free-text (`kind:function name:foo auth`).

/// Parsed `key:value` filters from an explicit query string.
#[derive(Debug, Default, Clone)]
pub struct StructuredFilters {
    pub kind: Option<String>,
    pub name: Option<String>,
    pub file: Option<String>,
    pub lang: Option<String>,
    pub returns: Option<String>,
    pub calls: Option<String>,
    pub complexity_min: Option<i32>,
    pub complexity_max: Option<i32>,
    /// Minimum / maximum parameter count from `metadata.parameters` JSON array.
    pub params_min: Option<i32>,
    pub params_max: Option<i32>,
    /// Remaining tokens that are not `known_key:value` pairs.
    pub free_text: Option<String>,
}

impl StructuredFilters {
    /// True when at least one structured field was parsed (excluding free-text only).
    pub fn has_structured_fields(&self) -> bool {
        self.kind.is_some()
            || self.name.is_some()
            || self.file.is_some()
            || self.lang.is_some()
            || self.returns.is_some()
            || self.calls.is_some()
            || self.complexity_min.is_some()
            || self.complexity_max.is_some()
            || self.params_min.is_some()
            || self.params_max.is_some()
    }
}

/// Parse `kind:function name:foo auth token` → structured + `free_text = "auth token"`.
pub fn parse_structured_query(input: &str) -> StructuredFilters {
    if let Some(parsed) = super::llm_query::try_llm_structured_query(input) {
        return parsed;
    }
    let legacy = legacy_parse_structured_query(input);
    if let Some(mut pest) = super::grammar::parse_structured_query_pest(input) {
        merge_structured_filters(&mut pest, &legacy);
        return pest;
    }
    legacy
}

fn merge_structured_filters(pest: &mut StructuredFilters, legacy: &StructuredFilters) {
    if pest.kind.is_none() {
        pest.kind = legacy.kind.clone();
    }
    if pest.name.is_none() {
        pest.name = legacy.name.clone();
    }
    if pest.file.is_none() {
        pest.file = legacy.file.clone();
    }
    if pest.lang.is_none() {
        pest.lang = legacy.lang.clone();
    }
    if pest.returns.is_none() {
        pest.returns = legacy.returns.clone();
    }
    if pest.calls.is_none() {
        pest.calls = legacy.calls.clone();
    }
    if pest.complexity_min.is_none() {
        pest.complexity_min = legacy.complexity_min;
    }
    if pest.complexity_max.is_none() {
        pest.complexity_max = legacy.complexity_max;
    }
    if pest.params_min.is_none() {
        pest.params_min = legacy.params_min;
    }
    if pest.params_max.is_none() {
        pest.params_max = legacy.params_max;
    }
    if pest.free_text.is_none() {
        pest.free_text = legacy.free_text.clone();
    }
}

fn legacy_parse_structured_query(input: &str) -> StructuredFilters {
    let mut out = StructuredFilters::default();
    let mut free: Vec<String> = Vec::new();

    for part in input.split_whitespace() {
        if let Some((k, v)) = part.split_once(':') {
            if v.is_empty() {
                free.push(part.to_string());
                continue;
            }
            let kl = k.to_lowercase();
            if kl == "complexity" || kl == "cx" {
                if let Some(rest) = v.strip_prefix('>') {
                    if let Ok(n) = rest.parse::<i32>() {
                        out.complexity_min = Some(n);
                    }
                } else if let Some(rest) = v.strip_prefix('<') {
                    if let Ok(n) = rest.parse::<i32>() {
                        out.complexity_max = Some(n);
                    }
                } else if let Ok(n) = v.parse::<i32>() {
                    out.complexity_min = Some(n);
                }
                continue;
            }
            match kl.as_str() {
                "kind" | "k" => out.kind = Some(v.to_string()),
                "name" | "n" => out.name = Some(v.to_string()),
                "file" | "path" | "f" => out.file = Some(v.to_string()),
                "lang" | "language" => out.lang = Some(v.to_string()),
                "returns" | "return" => out.returns = Some(v.to_string()),
                "calls" | "call" => out.calls = Some(v.to_string()),
                "params" | "param" => {
                    if let Some(rest) = v.strip_prefix('>') {
                        if let Ok(n) = rest.parse::<i32>() {
                            out.params_min = Some(n);
                        }
                    } else if let Some(rest) = v.strip_prefix('<') {
                        if let Ok(n) = rest.parse::<i32>() {
                            out.params_max = Some(n);
                        }
                    } else if let Ok(n) = v.parse::<i32>() {
                        out.params_min = Some(n);
                    }
                }
                _ => free.push(part.to_string()),
            }
        } else {
            free.push(part.to_string());
        }
    }

    if !free.is_empty() {
        out.free_text = Some(free.join(" "));
    }
    out
}
