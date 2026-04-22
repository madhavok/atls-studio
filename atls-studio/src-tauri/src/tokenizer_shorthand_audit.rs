//! Full shorthand token audit (~2 min debug build; use cargo test full_shorthand_token_audit --release for faster). — loaded by `tokenizer.rs`.
//! Run: `cargo test full_shorthand_token_audit -- --nocapture`

use super::count_tokens_batch_inner;
use super::count_tokens_inner;
use super::test_models;

const OP_SHORTHAND: &[(&str, &str)] = &[
    ("search.code", "sc"),
    ("search.symbol", "sy"),
    ("search.usage", "su"),
    ("search.similar", "sv"),
    ("search.issues", "si"),
    ("search.patterns", "sp"),
    ("search.memory", "sm"),
    ("read.context", "rc"),
    ("read.shaped", "rs"),
    ("read.lines", "rl"),
    ("read.file", "rf"),
    ("analyze.deps", "ad"),
    ("analyze.calls", "ac"),
    ("analyze.structure", "at"),
    ("analyze.impact", "ai"),
    ("analyze.blast_radius", "ab"),
    ("analyze.extract_plan", "ax"),
    ("analyze.graph", "ag"),
    ("change.edit", "ce"),
    ("change.create", "cc"),
    ("change.delete", "cd"),
    ("change.refactor", "cf"),
    ("change.rollback", "cb"),
    ("change.split_module", "cm"),
    ("verify.build", "vb"),
    ("verify.test", "vt"),
    ("verify.lint", "vl"),
    ("verify.typecheck", "vk"),
    ("session.plan", "spl"),
    ("session.advance", "sa"),
    ("session.status", "ss"),
    ("session.pin", "pi"),
    ("session.unpin", "pu"),
    ("session.stage", "sg"),
    ("session.unstage", "ust"),
    ("session.compact", "pc"),
    ("session.unload", "ulo"),
    ("session.drop", "dro"),
    ("session.recall", "rec"),
    ("session.stats", "st"),
    ("session.debug", "db"),
    ("session.diagnose", "dg"),
    ("session.bb.write", "bw"),
    ("session.bb.read", "br"),
    ("session.bb.delete", "bd"),
    ("session.bb.list", "bl"),
    ("session.rule", "ru"),
    ("session.emit", "em"),
    ("session.shape", "sh"),
    ("session.load", "ld"),
    ("session.compact_history", "ch"),
    ("annotate.note", "nn"),
    ("annotate.link", "nk"),
    ("annotate.retype", "nr"),
    ("annotate.split", "ns"),
    ("annotate.merge", "nm"),
    ("annotate.design", "nd"),
    ("delegate.retrieve", "dr"),
    ("delegate.design", "dd"),
    ("delegate.code", "dc"),
    ("delegate.test", "dt"),
    ("system.exec", "xe"),
    ("system.git", "xg"),
    ("system.workspaces", "xw"),
    ("system.help", "xh"),
    ("intent.understand", "iu"),
    ("intent.edit", "ie"),
    ("intent.edit_multi", "im"),
    ("intent.investigate", "iv"),
    ("intent.diagnose", "id"),
    ("intent.survey", "srv"),
    ("intent.refactor", "ifr"),
    ("intent.create", "ic"),
    ("intent.test", "it"),
    ("intent.search_replace", "is"),
    ("intent.extract", "ix"),
];

#[test]
fn op_shorthand_short_codes_are_ascii_and_nonempty() {
    for (full, short) in OP_SHORTHAND {
        assert!(!full.is_empty(), "empty full name");
        assert!(!short.is_empty(), "empty short for {full}");
        assert!(
            short.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
            "short {:?} should be lowercase alphanumeric for {}",
            short,
            full
        );
    }
}

#[test]
fn full_shorthand_token_audit() {
    let providers = [
        ("anthropic", test_models::ANTHROPIC),
        ("openai", test_models::OPENAI),
        ("google", test_models::GOOGLE),
    ];
    let mut seen_short = std::collections::BTreeSet::new();
    let mut seen_full = std::collections::BTreeSet::new();
    for (full, short) in OP_SHORTHAND {
        assert!(seen_short.insert(*short), "duplicate short code {:?}", short);
        assert!(seen_full.insert(*full), "duplicate full op {:?}", full);
    }
    assert_eq!(OP_SHORTHAND.len(), 76);
    eprintln!("\n=== full_shorthand_token_audit: per-operation strings ===\n");
    eprintln!(
        "{:<28} {:>5} | {:>6} {:>6} {:>6} | {:>6} {:>6} {:>6} | {:>4} {:>4} {:>4}",
        "operation", "short", "cld_f", "oai_f", "g_f", "cld_s", "oai_s", "g_s", "dcl", "doa", "dg"
    );
    eprintln!("{}", "-".repeat(102));
    let full_strings: Vec<String> = OP_SHORTHAND.iter().map(|(f, _)| (*f).to_string()).collect();
    let short_strings: Vec<String> = OP_SHORTHAND.iter().map(|(_, s)| (*s).to_string()).collect();

    let tf_all: Vec<Vec<u32>> = providers
        .iter()
        .map(|(p, m)| count_tokens_batch_inner(p, m, &full_strings))
        .collect();
    let ts_all: Vec<Vec<u32>> = providers
        .iter()
        .map(|(p, m)| count_tokens_batch_inner(p, m, &short_strings))
        .collect();

    let mut sum_full = [0u64; 3];
    let mut sum_short = [0u64; 3];
    for (idx, (full, short)) in OP_SHORTHAND.iter().enumerate() {
        let tf = [tf_all[0][idx], tf_all[1][idx], tf_all[2][idx]];
        let ts = [ts_all[0][idx], ts_all[1][idx], ts_all[2][idx]];
        for i in 0..3 {
            sum_full[i] += tf[i] as u64;
            sum_short[i] += ts[i] as u64;
        }
        eprintln!(
            "{:<28} {:>5} | {:>6} {:>6} {:>6} | {:>6} {:>6} {:>6} | {:>4} {:>4} {:>4}",
            full, short, tf[0], tf[1], tf[2], ts[0], ts[1], ts[2],
            tf[0] as i32 - ts[0] as i32, tf[1] as i32 - ts[1] as i32, tf[2] as i32 - ts[2] as i32
        );
    }
    eprintln!("\n--- Sum over 76 op tokens (name only) ---");
    eprintln!("Claude:  full={} short={} delta={}", sum_full[0], sum_short[0], sum_full[0] - sum_short[0]);
    eprintln!("OpenAI:  full={} short={} delta={}", sum_full[1], sum_short[1], sum_full[1] - sum_short[1]);
    eprintln!("Google*: full={} short={} delta={}", sum_full[2], sum_short[2], sum_full[2] - sum_short[2]);
    const PARAM_LONG_3STEP: &str = concat!(
        "r1 read.context depth:2 file_paths:atls-studio/src/services type:tree\n",
        "r2 search.code limit:5 queries:executeUnifiedBatch\n",
        "r3 session.stats"
    );
    const PARAM_SHORT_3STEP: &str = concat!(
        "r1 rc depth:2 ps:atls-studio/src/services type:tree\n",
        "r2 sc limit:5 qs:executeUnifiedBatch\n",
        "r3 st"
    );
    eprintln!("\n=== Same 3-step semantics: canonical ops+params vs op+param shorthands ===\n");
    for (label, content) in [("long_keys", PARAM_LONG_3STEP), ("short_keys", PARAM_SHORT_3STEP)] {
        let c = count_tokens_inner("anthropic", test_models::ANTHROPIC, content);
        let o = count_tokens_inner("openai", test_models::OPENAI, content);
        let g = count_tokens_inner("google", test_models::GOOGLE, content);
        eprintln!("{:<12} chars={:>4} claude={:>3} openai={:>3} google*={:>3}", label, content.len(), c, o, g);
    }
    let long_3 = count_tokens_inner("anthropic", test_models::ANTHROPIC, PARAM_LONG_3STEP);
    let short_3 = count_tokens_inner("anthropic", test_models::ANTHROPIC, PARAM_SHORT_3STEP);
    assert!(short_3 < long_3, "expected shorthand 3-step fewer Claude tokens: {} vs {}", short_3, long_3);
    const Q_LONG: &str = r#"{"q":"r1 read.context depth:2 file_paths:atls-studio/src/services type:tree\nr2 search.code limit:5 queries:executeUnifiedBatch\nr3 session.stats"}"#;
    const Q_SHORT: &str = r#"{"q":"r1 rc depth:2 ps:atls-studio/src/services type:tree\nr2 sc limit:5 qs:executeUnifiedBatch\nr3 st"}"#;
    eprintln!("\n=== Wrapped in batch tool JSON `q` field ===\n");
    for (label, content) in [("q_long", Q_LONG), ("q_short", Q_SHORT)] {
        let c = count_tokens_inner("anthropic", test_models::ANTHROPIC, content);
        let o = count_tokens_inner("openai", test_models::OPENAI, content);
        let g = count_tokens_inner("google", test_models::GOOGLE, content);
        eprintln!("{:<10} chars={:>4} claude={:>3} openai={:>3} google*={:>3}", label, content.len(), c, o, g);
    }
    let q_long_tok = count_tokens_inner("anthropic", test_models::ANTHROPIC, Q_LONG);
    let q_short_tok = count_tokens_inner("anthropic", test_models::ANTHROPIC, Q_SHORT);
    assert!(q_short_tok < q_long_tok, "expected short q JSON fewer Claude tokens: {} vs {}", q_short_tok, q_long_tok);
    eprintln!("\n*google = calibrated heuristic (not native Gemini BPE)\n");
}
