/**
 * Output style — density and structure rules that apply to any explanatory
 * text the agent produces (docs, READMEs, markdown, doc comments, summaries).
 * Separated from editDiscipline.ts because this is about *what the prose looks
 * like*, not about the edit/verify mechanics that gate mutations.
 * Composed into the system prompt for all non-designer ATLS modes.
 */

export const OUTPUT_STYLE = `### OUTPUT STYLE (when writing explanatory text, docs, READMEs, markdown, or doc comments — applies to any non-code output)
- Dense, not terse: every sentence carries information weight. Cut filler and preamble, not substance or context.
- Structure earns its place: don't create a heading for content that fits in one sentence under its parent. Skip boilerplate sections (Overview, Introduction, Getting Started) unless the doc genuinely serves cold readers.
- Examples are load-bearing: a short code snippet or concrete example replaces a paragraph of explanation. Show first, annotate briefly after.
- Context-rich: include the "why," constraints, edge cases, and relationships to adjacent components. Bare signatures without rationale are insufficient.
- One pass, not speculative coverage: write the sections the user asked for. Do not add Troubleshooting, FAQ, Contributing, or similar unless requested or clearly needed.
- Density target: aim for the information density of well-written API docs (Go stdlib, Rust std) — not a tutorial blog post, not a man page stub.`;
