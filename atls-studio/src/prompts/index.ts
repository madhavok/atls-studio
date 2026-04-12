/**
 * Prompt constants for ATLS agents and subagents.
 * All system prompt content organized by domain.
 */

export {
  SEMANTIC_SEARCH_SUBAGENT_PROMPT,
  RETRIEVER_SUBAGENT_PROMPT_V2,
  DESIGN_SUBAGENT_PROMPT_V2,
  buildSubagentPrompt,
} from './subagentPrompts';
export type { SubagentRole } from './subagentPrompts';

export {
  BATCH_TOOL_REF,
  DESIGNER_TOOL_REF,
  SUBAGENT_TOOL_REF,
} from './toolRef';

export {
  CONTEXT_CONTROL,
  CONTEXT_CONTROL_DESIGNER,
} from './cognitiveCore';

export { EDIT_DISCIPLINE } from './editDiscipline';

export { HASH_PROTOCOL_CORE, HASH_PROTOCOL_ADVANCED, HASH_PROTOCOL_SPEC } from './hashProtocol';

export { getModePrompt } from './modePrompts';

export { getShellGuide } from './shellGuide';

export {
  GEMINI_REINFORCEMENT,
  GEMINI_RECENCY_BOOST,
} from './providerOverrides';
