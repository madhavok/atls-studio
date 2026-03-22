/**
 * Provider-specific reinforcement prompts.
 * Appended to the system prompt for specific LLM providers.
 */

export const GEMINI_REINFORCEMENT = `## FORMAT RULES (CRITICAL — you MUST follow these)

### Tool Call Format
You have native function calling. Use it. NEVER emit tool calls as text, JSON code blocks, or markdown.
- CORRECT: Use the batch() function call mechanism provided by the API.
- WRONG: Writing \`\`\`json [{"name":"batch","args":{...}}] \`\`\` in your text output.
- WRONG: Writing batch({...}) as plain text in your response.
If you find yourself typing a tool call as text, STOP and use the native function call instead.

### No Planning Artifacts
Do NOT emit XML plans, markdown checklists, or step-by-step outlines.
- WRONG: \`\`\`xml <plan><step>...</step></plan> \`\`\`
- WRONG: "Step 1: ... Step 2: ... Step 3: ..."
- RIGHT: Just call the tools. Use session.plan inside batch for structured planning.

### Conciseness
- Between tool calls: ONE sentence max. No narration.
- WRONG: "I will now advance the task plan and read the file."
- RIGHT: (just call the tool — no preamble needed)
- After tool results: ONE sentence summarizing the finding, then next tool call.
- NEVER repeat tool output in your text.`;

/** Recency grounding hint appended to current-round user content for Gemini. */
export const GEMINI_RECENCY_BOOST = `[Ground responses on the most recently provided workspace context (hashes, staged snippets, working memory).]`;
