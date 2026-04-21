/**
 * UHPP — Universal Hash Pointer Protocol.
 * Core syntax (always in system prompt) + advanced (available via system.help).
 */

export const HASH_PROTOCOL_CORE = `## UHPP — Universal Hash Pointer Protocol (v6)
h:XXXX = stable pointer for recall, discovery, review, and tool dataflow. Use anywhere: file params, content, content_hash, query, message, create.content, from_ref.
**One ref per work object.** Pass it where it fits — the runtime resolves the right identity (retention vs source revision) for each slot and follows forward chains automatically. Re-read only when you see \`[REMOVED]\`, \`[changed: pending refetch]\`, or \`[UNRECOVERABLE]\`. Diff trail: h:OLD..h:NEW.
Core: h:XXXX:source (path), h:XXXX:content (text), h:XXXX:15-22 (lines), h:XXXX:15-22,40-55 (ranges).
Shape: h:XXXX:sig, h:XXXX:fold, h:XXXX:dedent, h:XXXX:imports, h:XXXX:exports, h:XXXX:head(N), h:XXXX:tail(N), h:XXXX:grep(pat).
Compose: h:XXXX:15-30:dedent, h:XXXX:15-80:ex(30-40), h:XXXX:15-50:hl(22,25-27).
Symbols: h:XXXX:fn(name), h:XXXX:sym(Name), h:XXXX:cls(Name), h:XXXX:fn(name):sig. Overloads: fn(name#2). Use in remove_lines/extract.
Diff: h:OLD..h:NEW — unified diff (UI renders collapsible diff view).
Recency: h:$last (most recent), h:$last-1, h:$last-2. Works within batch requests.
CONTENT-AS-REF: create.content:"h:XXXX:fn(name):dedent" auto-resolves. from_ref/from_refs for explicit intent.
EXTRACT: refactor(extract:"fn(name)", from:"h:XXXX", to:"target.ts") — declarative, fully automatic.
BATCH EXTRACT: refactor(action:"extract",extractions:[{target_file,methods}]) — multi-target, same-target merges.
Advanced syntax (sets, search expressions, semantic shapes, full symbol kinds): xh topic:"uhpp"`;

export const HASH_PROTOCOL_ADVANCED = `## UHPP — Advanced Syntax
Semantic: h:XXXX:concept(auth), h:XXXX:pattern(error-handling), h:XXXX:if(has(TODO)).
SYMBOL KINDS: fn() cls() struct() trait() interface() protocol() enum() record() extension() mixin() impl() type() const() static() mod() macro() ctor() property() field() enum_member() operator() event() object() actor() union() sym(). Aliases: class→cls, ns→mod, variant→enum_member.
Sets: h:@sub:ID (subtask), h:@file=*.ts (glob), h:@edited, h:@pinned, h:@latest, h:@ws:name.
Diagnostic-only selectors (surface via \`db\`/\`st\`, not in normal flows): h:@dematerialized, h:@dormant, h:@stale.
Search: h:@search(auth), h:@search(auth):sig, h:@search(auth,limit=5,tier=high). Composable: h:@search(auth)&h:@file=*.rs.
Set Ops: + (union), & (intersect), - (diff). Ex: h:@edited+h:@file=*.ts, h:@all&h:@pinned.
Meta: h:XXXX:tokens, h:XXXX:meta, h:XXXX:lang (zero content cost).`;

/** @deprecated Use HASH_PROTOCOL_CORE for system prompt injection */
export const HASH_PROTOCOL_SPEC = HASH_PROTOCOL_CORE;
