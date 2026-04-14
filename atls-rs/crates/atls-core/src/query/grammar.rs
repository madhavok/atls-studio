//! PEG-based structured query tokenization (`key:value` pairs + free words).

use crate::query::structured::StructuredFilters;
use pest::iterators::Pair;
use pest::Parser;
use pest_derive::Parser;

#[derive(Parser)]
#[grammar_inline = r#"
WHITESPACE = _{ " " | "\t" | "\r" | "\n" }
ident = @{ (ASCII_ALPHA | "_" | "-")+ }
pair = { ident ~ ":" ~ value }
value = @{ (!(WHITESPACE) ~ ANY)+ }
word = @{ (!(WHITESPACE | ":") ~ ANY)+ }
item = { pair | word }
query = { item ~ (WHITESPACE+ ~ item)* }
"#]
struct QueryGrammar;

/// Parse using `pest`; on failure returns `None` so callers can fall back to the legacy splitter.
pub fn parse_structured_query_pest(input: &str) -> Option<StructuredFilters> {
    let top = QueryGrammar::parse(Rule::query, input.trim()).ok()?.into_iter().next()?;
    let mut out = StructuredFilters::default();
    let mut free: Vec<String> = Vec::new();
    let mut flat: Vec<Pair<'_, Rule>> = Vec::new();
    flatten_query(top, &mut flat);
    for p in flat {
        match p.as_rule() {
            Rule::pair => {
                let mut key: Option<&str> = None;
                let mut val: Option<&str> = None;
                for sub in p.into_inner() {
                    match sub.as_rule() {
                        Rule::ident => key = Some(sub.as_str()),
                        Rule::value => val = Some(sub.as_str()),
                        _ => {}
                    }
                }
                if let (Some(k), Some(v)) = (key, val) {
                    if !apply_pair(k, v, &mut out) {
                        free.push(format!("{}:{}", k, v));
                    }
                }
            }
            Rule::word => free.push(p.as_str().to_string()),
            _ => {}
        }
    }

    if !free.is_empty() {
        out.free_text = Some(free.join(" "));
    }
    Some(out)
}

fn flatten_query<'a>(pair: Pair<'a, Rule>, acc: &mut Vec<Pair<'a, Rule>>) {
    match pair.as_rule() {
        Rule::pair | Rule::word => acc.push(pair),
        Rule::WHITESPACE => {}
        _ => {
            for c in pair.into_inner() {
                flatten_query(c, acc);
            }
        }
    }
}

/// Returns `true` if the pair was a recognized structured key.
fn apply_pair(key: &str, val: &str, out: &mut StructuredFilters) -> bool {
    let kl = key.to_lowercase();
    if kl == "complexity" || kl == "cx" {
        if let Some(rest) = val.strip_prefix('>') {
            if let Ok(n) = rest.parse::<i32>() {
                out.complexity_min = Some(n);
            }
        } else if let Some(rest) = val.strip_prefix('<') {
            if let Ok(n) = rest.parse::<i32>() {
                out.complexity_max = Some(n);
            }
        } else if let Ok(n) = val.parse::<i32>() {
            out.complexity_min = Some(n);
        }
        return true;
    }
    if kl == "params" || kl == "param" {
        if let Some(rest) = val.strip_prefix('>') {
            if let Ok(n) = rest.parse::<i32>() {
                out.params_min = Some(n);
            }
        } else if let Some(rest) = val.strip_prefix('<') {
            if let Ok(n) = rest.parse::<i32>() {
                out.params_max = Some(n);
            }
        } else if let Ok(n) = val.parse::<i32>() {
            out.params_min = Some(n);
        }
        return true;
    }
    match kl.as_str() {
        "kind" | "k" => out.kind = Some(val.to_string()),
        "name" | "n" => out.name = Some(val.to_string()),
        "file" | "path" | "f" => out.file = Some(val.to_string()),
        "lang" | "language" => out.lang = Some(val.to_string()),
        "returns" | "return" => out.returns = Some(val.to_string()),
        "calls" | "call" => out.calls = Some(val.to_string()),
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::query::structured::parse_structured_query;

    #[test]
    fn pest_parses_filters_and_free_text() {
        assert_eq!(
            parse_structured_query_pest("name:foo").unwrap().name.as_deref(),
            Some("foo")
        );
        let f = parse_structured_query("kind:function name:foo auth handler");
        assert_eq!(f.kind.as_deref(), Some("function"));
        assert_eq!(f.name.as_deref(), Some("foo"));
        assert_eq!(f.free_text.as_deref(), Some("auth handler"));
    }
}
