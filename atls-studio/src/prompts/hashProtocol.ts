/**
 * UHPP — Universal Hash Pointer Protocol.
 * Core syntax for system prompt injection. Advanced features (temporal, pipeline,
 * extract_plan, split_match, dep_graph, fallback) live in BB/staged reference.
 */

export const HASH_PROTOCOL_SPEC = `## UHPP — Universal Hash Pointer Protocol (v6)
h:XXXX = stable pointer for recall, discovery, review, and tool dataflow. Use anywhere appropriate: file params, content, content_hash, query, message, description, create.content, from_ref.
**Mutation authority:** Hashes locate the latest target. One prior read (full or line-range) is sufficient — the system tracks live content. Forwarded or non-canonical hashes trigger backend errors; re-read on stale_hash. Diff trail: h:OLD..h:NEW.
Core: h:XXXX:source (path), h:XXXX:content (text), h:XXXX:15-22 (lines), h:XXXX:15-22,40-55 (ranges).
Shape: h:XXXX:sig, h:XXXX:fold, h:XXXX:dedent, h:XXXX:imports, h:XXXX:exports, h:XXXX:head(N), h:XXXX:tail(N), h:XXXX:grep(pat).
Semantic: h:XXXX:concept(auth), h:XXXX:pattern(error-handling), h:XXXX:if(has(TODO)).
Compose: h:XXXX:15-30:dedent, h:XXXX:15-80:ex(30-40), h:XXXX:15-50:hl(22,25-27).
Symbols: h:XXXX:fn(name), h:XXXX:sym(Name), h:XXXX:macro(name), h:XXXX:fn(name):sig. Overloads: fn(name#2). Use in remove_lines/extract.
SYMBOL KINDS: fn() cls() struct() trait() interface() protocol() enum() record() extension() mixin() impl() type() const() static() mod() macro() ctor() property() field() enum_member() operator() event() object() actor() union() sym(). Aliases: class→cls, ns→mod, variant→enum_member.
Diff: h:OLD..h:NEW — unified diff (UI renders collapsible diff view).
Sets: h:@sub:ID (subtask), h:@file=*.ts (glob), h:@edited, h:@latest, h:@ws:name.
Search: h:@search(auth), h:@search(auth):sig, h:@search(auth,limit=5,tier=high). Composable: h:@search(auth)&h:@file=*.rs.
Set Ops: + (union), & (intersect), - (diff). Ex: h:@edited+h:@file=*.ts, h:@all&h:@pinned.
Recency: h:$last (most recent), h:$last-1, h:$last-2. Works within batch requests.
Meta: h:XXXX:tokens, h:XXXX:meta, h:XXXX:lang (zero content cost).
CONTENT-AS-REF: create.content:"h:XXXX:fn(name):dedent" auto-resolves. from_ref/from_refs for explicit intent. For edits, treat ref content as discovery material — the system ensures edit targets match live file state.
EXTRACT: refactor(extract:"fn(name)", from:"h:XXXX", to:"target.ts") — declarative, fully automatic imports/exports/rewrites.
BATCH EXTRACT: refactor(action:"extract",extractions:[{target_file,methods}]) — multi-target, same-target merges.`;
