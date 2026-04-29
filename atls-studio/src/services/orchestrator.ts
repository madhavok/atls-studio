/**
 * Orchestrator Service
 * 
 * Manages swarm orchestration: task decomposition, file claims,
 * context distribution, and agent coordination.
 */

import { invoke } from '@tauri-apps/api/core';
import { atlsBatchQuery } from './toolHelpers';
import { useSwarmStore, type SwarmTask, type AgentRole, type ResearchResult } from '../stores/swarmStore';
import { useContextStore } from '../stores/contextStore';
import { useAppStore } from '../stores/appStore';
import { getTerminalStore } from '../stores/terminalStore';
import { chatDb, type TaskStatus as ChatTaskStatus } from './chatDb';
import { rateLimiter } from './rateLimiter';
import { BATCH_TOOL_REF, type AIConfig, type ChatMessage, type AIProvider } from './aiService';
import { streamChatForSwarm } from './swarmChat';
import { resolveModelSettings } from '../utils/modelSettings';
import { EDIT_DISCIPLINE } from '../prompts/editDiscipline';
import { toTOON } from '../utils/toon';
import { countTokensSync } from '../utils/tokenCounter';

/** Persisted in agent_stats for LLM usage not tied to a worker task row */
const SWARM_ORCHESTRATION_PLAN_TASK_ID = '__swarm_orchestration_plan__';
const SWARM_ORCHESTRATION_SYNTHESIS_TASK_ID = '__swarm_orchestration_synthesis__';

// ============================================================================
// Types
// ============================================================================

export interface OrchestratorConfig {
  model: string;
  provider: AIProvider;
  maxConcurrentAgents: number;
  autoApprove: boolean;
  enableSynthesis?: boolean;
}

export interface TaskPlan {
  tasks: PlannedTask[];
  summary: string;
  estimatedTokens: number;
  estimatedCost: number;
}

export interface PlannedTask {
  title: string;
  description: string;
  role: AgentRole;
  files: string[];
  contextNeeded: string[];
  dependencies: string[];
  priority: number;
  editTargets?: EditTarget[];
}

interface AgentExecution {
  taskId: string;
  abortController: AbortController;
  promise: Promise<void>;
}

// ============================================================================
// Research Digest Types (Context Compiler)
// ============================================================================

export interface EditTarget {
  file: string;
  symbol: string;
  kind: 'function' | 'class' | 'method' | 'export' | 'interface' | 'type' | 'block';
  lineRange?: [number, number];
  reason: string;
}

export interface FileDigest {
  path: string;
  smartHash: string;
  rawHash?: string;
  smartContent?: string;
  rawContent?: string;
  signatures: string[];
  imports: string[];
  importedBy: string[];
  editTargets: EditTarget[];
  relevanceScore: number;
}

export interface ResearchDigest {
  files: Map<string, FileDigest>;
  dependencyGraph: Map<string, string[]>;
  reverseDependencyGraph: Map<string, string[]>;
  editPlan: EditTarget[];
  projectProfile: string;
}

export interface TaskPacket {
  task: { title: string; description: string; role: AgentRole };
  ownership: { editable: string[]; readonly: string[] };
  content: {
    owned: Array<{ path: string; content: string; editTargets: EditTarget[] }>;
    references: Array<{ path: string; signatures: string }>;
    dependencies: Array<{ path: string; signatures: string }>;
  };
  context: {
    userRequest: string;
    dependencyResults: string;
    blackboard: Record<string, string>;
    projectContext: { os: string; shell: string; cwd: string } | null;
  };
  budget: { maxRounds: number; maxTokens: number };
}

// Default context budget per agent (tokens). Leaves room for system prompt + output.
const DEFAULT_AGENT_CONTEXT_BUDGET = 120_000;

function resolveApiKey(provider: AIProvider): string {
  const settings = useAppStore.getState().settings as unknown as Record<string, unknown>;
  switch (provider) {
    case 'anthropic': return (settings.anthropicApiKey as string) || '';
    case 'openai': return (settings.openaiApiKey as string) || '';
    case 'openrouter': return (settings.openrouterApiKey as string) || '';
    case 'google': return (settings.googleApiKey as string) || '';
    case 'vertex': return (settings.vertexAccessToken as string) || '';
    case 'lmstudio': return (settings.lmstudioBaseUrl as string) || 'http://localhost:1234';
    default: return '';
  }
}

// ============================================================================
// Orchestrator Prompts
// ============================================================================

const ORCHESTRATOR_SYSTEM_PROMPT = `You are a senior engineering lead decomposing a task for a team of specialist agents. Output ONLY valid JSON.

You will receive a RESEARCH DIGEST containing per-file symbol signatures, a dependency graph, and candidate edit targets. Use this structured data to make precise task assignments.

## Agent Roles
- coder: Implements features and refactors code. Uses batch + task_complete.
- debugger: Investigates and fixes bugs. Uses batch + task_complete.
- reviewer: Reviews code quality and correctness. Uses batch + task_complete (read-only behavior by prompt).
- tester: Writes and runs tests. Uses batch + task_complete.
- documenter: Creates and updates documentation. Uses batch + task_complete.

## Rules
1. EXCLUSIVE FILE OWNERSHIP: Each file appears in exactly ONE task's "files" array. No two agents may edit the same file.
2. DEPENDENCIES: If task B needs the output of task A, list A's title in B's "dependencies". Agents receive completed dependency results.
3. CONTEXT FILES: List read-only reference files in "contextNeeded" — agents can read these but not edit them.
4. USE REAL PATHS: Only reference files found in the research phase. Never invent paths.
5. DETAILED DESCRIPTIONS: Include specific function names, patterns, and line-level guidance from the research. Each agent works alone with only its assigned context. Reference the exact symbols and line ranges from the digest.
6. MINIMAL TASKS: Prefer fewer, well-scoped tasks over many tiny ones. Group related changes into one task when they touch the same files.
7. PRIORITY: Lower number = runs first (along with dependency ordering).
8. TASK COUNT: Aim for 2-5 tasks. If the request is simple, 1-2 tasks may suffice. More than 7 tasks usually means over-decomposition.
9. EDIT TARGETS: When the research digest provides specific symbols and line ranges, include them in editTargets so agents know exactly what to modify.
10. COUPLING: Files that import each other heavily should be in the same task when possible. Use the dependency graph to identify tightly-coupled clusters.

## JSON Format
{
  "summary": "1-2 sentence plan overview",
  "tasks": [
    {
      "title": "Unique task title (used as dependency reference)",
      "description": "Detailed instructions with specific code references, function names, patterns to follow. What to change and why.",
      "role": "coder|debugger|reviewer|tester|documenter",
      "files": ["path/to/file.ts"],
      "contextNeeded": ["path/to/reference.ts"],
      "dependencies": ["Title of prerequisite task"],
      "priority": 1,
      "editTargets": [
        {"file": "path/to/file.ts", "symbol": "functionName", "kind": "function", "lineRange": [10, 25], "reason": "Add validation logic"}
      ]
    }
  ]
}

CRITICAL: Output ONLY the raw JSON object. No markdown, no explanation, no code fences.`;

// ============================================================================
// Role-Specific Tool Documentation (minimal, focused)
// ============================================================================

const ROLE_TOOL_DOCS: Record<AgentRole, string> = {
  orchestrator: '',

  coder: `## Role: Coder
Tools: read.context, search.code, search.symbol, change.edit, change.refactor, change.rollback, session.bb.write/read, system.exec, verify.build/typecheck.
task_complete({summary, files_changed:[]}) → REQUIRED when done (do NOT call until verify.build succeeds or blocker).

Workflow:
1. Review pre-loaded context + SHARED KNOWLEDGE.
2. Plan, batch implementation, full-read before change.edit mutations.
3. Record key decisions: session.bb.write key:"impl-decisions".
4. task_complete with summary and files_changed.`,

  debugger: `## Role: Debugger
Tools: read.context, search.issues, search.code, change.edit, session.bb.write/read, system.exec, verify.build.
task_complete({summary, files_changed:[]}) → REQUIRED when done.

Workflow:
1. Reproduce: read context + run tests via exec.
2. Trace root cause: search.code + search.issues. Record: session.bb.write key:"root-cause".
3. Implement targeted fix, verify.build.
4. task_complete with root cause analysis and fix.`,

  reviewer: `## Role: Reviewer (READ-ONLY)
Tools: read.context, search.issues, search.code, session.bb.write/read.
task_complete({summary, issues_found:[]}) → REQUIRED.

Workflow:
1. Review pre-loaded files for correctness, security, performance, style.
2. Record findings: session.bb.write key:"review-findings".
3. task_complete with structured findings: [{file, line, severity, description}].`,

  tester: `## Role: Tester
Tools: read.context, change.edit, change.create, session.bb.read, system.exec, verify.build.
task_complete({summary, files_changed:[]}) → REQUIRED when done.

Workflow:
1. Read shared knowledge: session.bb.read key:"impl-decisions".
2. Write tests: happy path, edge cases, error conditions.
3. verify.build, then task_complete with coverage summary.`,

  documenter: `## Role: Documenter (NO exec)
Tools: read.context, change.edit, change.create, session.bb.read.
task_complete({summary, files_changed:[]}) → REQUIRED (no build gate).

Workflow:
1. Read shared knowledge: session.bb.read keys:["impl-decisions","review-findings"].
2. Write documentation: purpose, API surface, usage examples, edge cases, constraints.
   Dense — every sentence carries info. No boilerplate sections or padding. Examples over prose.
3. task_complete with summary.`,
};

// Swarm tool surface: executeToolCall / executeToolCallDetailed (batch + task_complete only).

// ============================================================================
// Orchestrator Class
// ============================================================================

class OrchestratorService {
  private activeAgents: Map<string, AgentExecution> = new Map();
  private dispatchRevs: Map<string, number> = new Map();
  private _isRunning = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private completionInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Start orchestration for a user request
   */
  async start(
    sessionId: string,
    userRequest: string,
    projectPath: string,
    config: OrchestratorConfig
  ): Promise<void> {
    const swarmStore = useSwarmStore.getState();
    
    // Initialize swarm
    swarmStore.startSwarm(sessionId, userRequest);
    
    try {
      // CRITICAL: Initialize chat DB for the correct project FIRST
      // Without this, operations go to wrong database causing FK errors
      console.log('[Orchestrator] Initializing chat DB for project:', projectPath);
      const initSuccess = await chatDb.init(projectPath);
      const actualDbPath = chatDb.getProjectPath();
      if (!initSuccess || projectPath !== actualDbPath) {
        throw new Error(`Failed to initialize chat DB for ${projectPath}. Actual path: ${actualDbPath}`);
      }
      
      // Create session in database FIRST (before any tasks are created)
      console.log('[Orchestrator] Creating swarm session in database:', sessionId);
      try {
        await chatDb.createSession('swarm', userRequest.slice(0, 50) || 'Swarm Task', sessionId);
        
        // VERIFY: Read back session to confirm DB is correct
        const verifySession = await chatDb.getSession(sessionId);
        const sessionExists = !!verifySession;
        if (!sessionExists) {
          throw new Error(`Session ${sessionId} was not found after creation - DB may be misconfigured`);
        }
      } catch (sessionError: any) {
        throw sessionError;
      }
      await chatDb.updateSwarmStatus(sessionId, 'researching');
      
      // Phase 1: RESEARCH - Explore codebase to gather context
      console.log('[Orchestrator] Starting research phase...');
      swarmStore.setStatus('researching');
      const research = await this.researchCodebase(userRequest, projectPath, config);
      console.log(`[Orchestrator] Research complete: ${research.filesToModify.length} files to modify, ${research.filesForContext.length} context files`);
      
      // Store research in swarm store for UI display
      swarmStore.setResearch(research);
      
      // Persist research chunks to blackboard (survives app restarts mid-swarm)
      try {
        const contextStore = useContextStore.getState();
        const allChunks = contextStore.getAllChunks();
        for (const chunk of allChunks) {
          await chatDb.addBlackboardEntry(sessionId, chunk);
        }
        console.log(`[Orchestrator] Persisted ${allChunks.length} context chunks to blackboard`);
      } catch (e) {
        console.warn('[Orchestrator] Failed to persist blackboard:', e);
      }
      
      await chatDb.updateSwarmStatus(sessionId, 'planning');
      
      // Phase 2: Create plan based on research
      console.log('[Orchestrator] Creating plan from research...');
      swarmStore.setStatus('planning');
      const plan = await this.createPlan(userRequest, projectPath, config, research);
      
      if (!plan || plan.tasks.length === 0) {
        throw new Error('Failed to create a valid plan');
      }
      
      swarmStore.setPlan(plan.summary);
      
      // If auto-approve is off, wait for user approval
      if (!config.autoApprove) {
        console.log('[Orchestrator] Waiting for plan approval...');
        // The UI will call approvePlan() when user approves
        return;
      }
      
      // Phase 3: Execute plan
      await this.executePlan(sessionId, plan, projectPath, config);
      
    } catch (error: unknown) {
      console.error('[Orchestrator] Error:', error);
      swarmStore.resetSwarm();
      // Normalize to Error so callers always get a .message
      if (error instanceof Error) throw error;
      const msg = typeof error === 'string' ? error
        : (error && typeof error === 'object' && 'message' in error) ? String((error as any).message)
        : JSON.stringify(error) || 'Orchestrator failed';
      throw new Error(msg);
    }
  }

  /**
   * Research the codebase to gather context for the task
   * This is the critical phase that makes swarm effective
   */
  private async researchCodebase(
    userRequest: string,
    projectPath: string,
    _config: OrchestratorConfig
  ): Promise<ResearchResult> {
    const swarmStore = useSwarmStore.getState();
    
    // Get project context (OS, shell, CWD)
    const projectContext = await this.getProjectContext(projectPath);
    swarmStore.addResearchLog(`🔧 Project: ${projectPath}`);
    if (projectContext) {
      swarmStore.addResearchLog(`💻 OS: ${projectContext.os}, Shell: ${projectContext.shell}`);
    }
    
    // Default result in case research fails
    const defaultResult: ResearchResult = {
      filesToModify: [],
      filesForContext: [],
      patterns: [],
      dependencies: [],
      considerations: [],
      rawFindings: '',
      smartHashes: new Map(),
      rawHashes: new Map(),
      fileContents: new Map(),
      projectContext,
    };
    
    const contextStore = useContextStore.getState();
    
    try {
      // Step 1: Get project profile for structure overview (1 call)
      console.log('[Research] Getting project profile...');
      swarmStore.addResearchLog('📁 Getting project structure...');
      let projectProfileText = '';
      try {
        const profile = await invoke<any>('atls_get_project_profile');
        if (profile) {
          projectProfileText = `PROJECT STRUCTURE:
- Name: ${profile.proj}
- Languages: ${Object.keys(profile.stats?.langs || {}).join(', ')}
- Total Files: ${profile.stats?.files || 'unknown'}
- Modules/Directories: ${profile.arch?.mods?.slice(0, 20).join(', ') || 'unknown'}`;
          swarmStore.addResearchLog(`📊 Project: ${profile.proj || 'unknown'}`);
          swarmStore.addResearchLog(`🗂️ Files: ${profile.stats?.files || 'unknown'}, Languages: ${Object.keys(profile.stats?.langs || {}).slice(0, 3).join(', ')}`);
        }
      } catch (e) {
        console.warn('[Research] Could not get project profile:', e);
        swarmStore.addResearchLog(`⚠️ Could not load project profile`);
      }
      
      // Step 2: Semantic code search (1 call)
      console.log('[Research] Performing code search...');
      swarmStore.addResearchLog('🔍 Searching codebase for relevant files...');
      let searchResults: string[] = [];
      try {
        const sanitizedQuery = this.sanitizeFts5Query(userRequest);
        const semanticResults = await invoke<any>('atls_search_code', {
          query: sanitizedQuery,
          limit: 30
        });
        const resultsArray = semanticResults?.results || semanticResults;
        if (resultsArray && Array.isArray(resultsArray)) {
          searchResults = resultsArray.map((r: any) => r.file || r.path || r).filter(Boolean);
          console.log(`[Research] Code search found ${searchResults.length} relevant files`);
          swarmStore.addResearchLog(`✅ Code search: ${searchResults.length} matches`);
        }
      } catch (e) {
        console.warn('[Research] Code search failed:', e);
        swarmStore.addResearchLog(`⚠️ Code search unavailable: ${String(e).slice(0, 50)}`);
      }
      
      // Step 3: Batch keyword search (1 call with all keywords)
      console.log('[Research] Searching for keywords...');
      const keywords = this.extractKeywords(userRequest);
      swarmStore.addResearchLog(`🏷️ Keywords: ${keywords.slice(0, 5).join(', ')}`);
      const keywordFiles: string[] = [];
      
      // Batch all keywords into a single call
      const sanitizedKeywords = keywords.slice(0, 5)
        .map(kw => this.sanitizeFts5Query(kw))
        .filter(kw => kw && kw.length >= 2);
      
      if (sanitizedKeywords.length > 0) {
        try {
          const grepResults = await atlsBatchQuery('code_search', { queries: sanitizedKeywords, limit: 10 }) as Record<string, unknown> | null;
          if (grepResults) {
            const queryResults = grepResults.results || grepResults.matches || grepResults;
            if (Array.isArray(queryResults)) {
              for (const qr of queryResults) {
                const innerResults = qr.results || qr;
                if (Array.isArray(innerResults)) {
                  for (const r of innerResults) {
                    const file = r.file || r.path || '';
                    if (file) keywordFiles.push(file);
                  }
                }
              }
            }
          }
          swarmStore.addResearchLog(`✅ Keyword search: ${keywordFiles.length} total matches`);
        } catch (e) {
          console.warn('[Research] Batch keyword search failed:', e);
        }
      }
      
      // Step 4: Combine, deduplicate, and categorize
      const allFiles = [...new Set([...searchResults, ...keywordFiles])];
      const filesToRead = allFiles.slice(0, 20); // ATLS batch supports up to 20 files
      console.log(`[Research] Total unique files found: ${allFiles.length}`);
      swarmStore.addResearchLog(`📋 Found ${allFiles.length} unique relevant files`);
      
      // Step 5: ATLS batch context — smart summaries for ALL relevant files (1 call)
      console.log('[Research] Getting smart context for all files...');
      swarmStore.addResearchLog('📖 Loading structural summaries (ATLS context:smart)...');
      const smartHashes = new Map<string, string>();
      const fileContentsMap = new Map<string, string>();
      let smartContentForAnalysis: { path: string; content: string }[] = [];
      
      try {
        const smartResult = await atlsBatchQuery('context', { type: 'smart', file_paths: filesToRead }) as Record<string, unknown> | null;
        // Parse results — format varies by backend response shape
        const results = smartResult?.results || smartResult;
        if (results && typeof results === 'object') {
          // Handle array of { file, content } or map-like { file: content }
          const entries: [string, string][] = Array.isArray(results)
            ? results.map((r: any) => [r.file || r.path, r.content || r.result || toTOON(r)] as [string, string])
            : Object.entries(results);
          
          for (const [filePath, content] of entries) {
            if (!filePath || !content) continue;
            const contentStr = typeof content === 'string' ? content : toTOON(content);
            const hash = contextStore.addChunk(contentStr, 'smart', filePath);
            smartHashes.set(filePath, hash);
            // Also store for analysis below
            smartContentForAnalysis.push({ path: filePath, content: contentStr });
            const fileName = filePath.split(/[/\\]/).pop() || filePath;
            swarmStore.addResearchLog(`  📋 ${fileName} (smart)`);
          }
        }
        console.log(`[Research] Smart context loaded: ${smartHashes.size} files`);
        swarmStore.addResearchLog(`✅ Smart summaries: ${smartHashes.size} files`);
      } catch (e) {
        console.warn('[Research] Smart context batch failed, falling back to read_file:', e);
        swarmStore.addResearchLog(`⚠️ Smart context failed, using fallback reads`);
        // Fallback: read files individually
        const separator = projectPath.includes('\\') ? '\\' : '/';
        for (const filePath of filesToRead.slice(0, 10)) {
          try {
            let fullPath: string;
            if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) {
              fullPath = filePath;
            } else {
              const cleanPath = filePath.replace(/[/\\]/g, separator);
              fullPath = `${projectPath}${separator}${cleanPath}`;
            }
            const content = await invoke<string>('read_file_contents', { path: fullPath });
            if (content) {
              const truncated = content.slice(0, 5000);
              fileContentsMap.set(filePath, truncated);
              smartContentForAnalysis.push({ path: filePath, content: truncated });
            }
          } catch (e) { console.debug(`[Research] Could not read ${filePath}:`, e); }
        }
      }
      
      // Step 6: Categorize files (modify vs context)
      swarmStore.addResearchLog('🔬 Analyzing files and patterns...');
      const filesToModify: string[] = [];
      const filesForContext: string[] = [];
      
      for (const file of smartContentForAnalysis) {
        const matchScore = keywords.reduce((score, kw) => {
          return score + (file.content.toLowerCase().includes(kw.toLowerCase()) ? 1 : 0);
        }, 0);
        
        if (matchScore >= 2 || searchResults.slice(0, 5).includes(file.path)) {
          filesToModify.push(file.path);
        } else {
          filesForContext.push(file.path);
        }
      }
      swarmStore.addResearchLog(`  📝 Files to modify: ${filesToModify.length}`);
      swarmStore.addResearchLog(`  📚 Context files: ${filesForContext.length}`);
      
      // Step 7: ATLS batch context — raw content for files to modify (1 call)
      const rawHashes = new Map<string, string>();
      if (filesToModify.length > 0) {
        console.log('[Research] Getting raw content for files to modify...');
        swarmStore.addResearchLog('📖 Loading full content for edit targets (ATLS context:full)...');
        try {
          const rawResult = await atlsBatchQuery('context', { type: 'full', file_paths: filesToModify }) as Record<string, unknown> | null;
          const results = rawResult?.results || rawResult;
          if (results && typeof results === 'object') {
            const entries: [string, string][] = Array.isArray(results)
              ? results.map((r: any) => [r.file || r.path, r.content || r.result || ''] as [string, string])
              : Object.entries(results);
            
            for (const [filePath, content] of entries) {
              if (!filePath || !content) continue;
              const contentStr = typeof content === 'string' ? content : toTOON(content);
              const hash = contextStore.addChunk(contentStr, 'raw', filePath);
              rawHashes.set(filePath, hash);
              fileContentsMap.set(filePath, contentStr);
              const fileName = filePath.split(/[/\\]/).pop() || filePath;
              swarmStore.addResearchLog(`  📄 ${fileName} (raw)`);
            }
          }
          console.log(`[Research] Raw content loaded: ${rawHashes.size} files`);
          swarmStore.addResearchLog(`✅ Raw content: ${rawHashes.size} files`);
        } catch (e) {
          console.warn('[Research] Raw context batch failed:', e);
          swarmStore.addResearchLog(`⚠️ Raw context failed — agents will use read_file at runtime`);
        }
      }
      
      // Step 8: Build research digest with per-file symbol extraction
      let digest: ResearchDigest | undefined;
      try {
        swarmStore.addResearchLog('🔬 Building research digest (symbols, deps, edit targets)...');
        digest = this.buildResearchDigest(
          smartContentForAnalysis, filesToModify, filesForContext,
          smartHashes, rawHashes, fileContentsMap, keywords, projectProfileText,
        );
        swarmStore.addResearchLog(`  🔗 Dependency edges: ${Array.from(digest.dependencyGraph.values()).reduce((s, v) => s + v.length, 0)}`);
        swarmStore.addResearchLog(`  🎯 Edit targets: ${digest.editPlan.length}`);
        swarmStore.addResearchLog(`  📋 File digests: ${digest.files.size}`);
      } catch (digestError) {
        console.warn('[Research] Digest build failed (non-fatal):', digestError);
        swarmStore.addResearchLog(`⚠️ Digest build failed — agents will discover targets at runtime`);
      }

      // Build legacy rawFindings for backward compat
      const rawFindings = `
=== CODEBASE RESEARCH RESULTS ===

${projectProfileText}

FILES LIKELY TO MODIFY (${filesToModify.length}):
${filesToModify.map(f => `- ${f}`).join('\n') || '(none found - will need manual specification)'}

FILES FOR CONTEXT/REFERENCE (${filesForContext.length}):
${filesForContext.map(f => `- ${f}`).join('\n') || '(none found)'}

CONTEXT HASHES STORED:
- Smart summaries: ${smartHashes.size} files
- Raw content: ${rawHashes.size} files

SEARCH KEYWORDS USED: ${keywords.join(', ')}
`;

      const patterns = this.extractPatterns(smartContentForAnalysis);
      const dependencies = digest
        ? Array.from(digest.dependencyGraph.entries()).flatMap(([src, deps]) => deps.map(d => `${src} -> ${d}`))
        : [];

      swarmStore.addResearchLog(`✅ Research complete!`);
      swarmStore.addResearchLog(`───────────────────────`);
      swarmStore.addResearchLog(`📊 Summary: ${filesToModify.length} to modify, ${filesForContext.length} for context | ${smartHashes.size} smart + ${rawHashes.size} raw hashes stored`);
      
      return {
        filesToModify,
        filesForContext,
        patterns,
        dependencies,
        considerations: [],
        rawFindings,
        smartHashes,
        rawHashes,
        fileContents: fileContentsMap,
        projectContext,
        digest,
      };
      
    } catch (error) {
      console.error('[Research] Research phase failed:', error);
      swarmStore.addResearchLog(`❌ Research error: ${error}`);
      return defaultResult;
    }
  }

  // ============================================================================
  // Research Digest Builder
  // ============================================================================

  private buildResearchDigest(
    smartContent: { path: string; content: string }[],
    filesToModify: string[],
    filesForContext: string[],
    smartHashes: Map<string, string>,
    rawHashes: Map<string, string>,
    fileContents: Map<string, string>,
    keywords: string[],
    projectProfile: string,
  ): ResearchDigest {
    const files = new Map<string, FileDigest>();
    const depGraph = new Map<string, string[]>();
    const reverseDepGraph = new Map<string, string[]>();
    const modifySet = new Set(filesToModify);

    for (const { path, content } of smartContent) {
      const signatures = this.extractSignatures(content);
      const imports = this.extractImportPaths(content);
      const relevanceScore = keywords.reduce(
        (score, kw) => score + (content.toLowerCase().includes(kw.toLowerCase()) ? 1 : 0), 0,
      );

      depGraph.set(path, imports);
      for (const imp of imports) {
        const existing = reverseDepGraph.get(imp) || [];
        existing.push(path);
        reverseDepGraph.set(imp, existing);
      }

      const editTargets: EditTarget[] = [];
      if (modifySet.has(path)) {
        const rawContent = fileContents.get(path) || content;
        for (const sig of signatures) {
          const matchesKeyword = keywords.some(kw =>
            sig.toLowerCase().includes(kw.toLowerCase()),
          );
          if (matchesKeyword) {
            const lineRange = this.findSymbolLineRange(rawContent, sig);
            editTargets.push({
              file: path,
              symbol: sig.split(/[(\s{:]/)[0].replace(/^(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const|let|var)\s+/, '').trim(),
              kind: this.classifySignature(sig),
              lineRange: lineRange ?? undefined,
              reason: `Matches keywords: ${keywords.filter(kw => sig.toLowerCase().includes(kw.toLowerCase())).join(', ')}`,
            });
          }
        }
      }

      files.set(path, {
        path,
        smartHash: smartHashes.get(path) || '',
        rawHash: rawHashes.get(path),
        smartContent: content,
        rawContent: fileContents.get(path),
        signatures,
        imports,
        importedBy: [],
        editTargets,
        relevanceScore,
      });
    }

    // Populate reverse dependencies
    for (const [target, sources] of reverseDepGraph) {
      const digest = files.get(target);
      if (digest) digest.importedBy = sources;
    }

    const editPlan = Array.from(files.values()).flatMap(f => f.editTargets);

    return { files, dependencyGraph: depGraph, reverseDependencyGraph: reverseDepGraph, editPlan, projectProfile };
  }

  private extractSignatures(content: string): string[] {
    const sigs: string[] = [];
    const patterns = [
      /^export\s+(?:default\s+)?(?:async\s+)?function\s+\w+[^{]*/gm,
      /^export\s+(?:default\s+)?class\s+\w+[^{]*/gm,
      /^export\s+(?:default\s+)?interface\s+\w+[^{]*/gm,
      /^export\s+(?:default\s+)?type\s+\w+[^=]*/gm,
      /^export\s+const\s+\w+/gm,
      /^(?:async\s+)?function\s+\w+[^{]*/gm,
      /^class\s+\w+[^{]*/gm,
      /^interface\s+\w+[^{]*/gm,
      /^(?:pub\s+)?(?:async\s+)?fn\s+\w+[^{]*/gm,
      /^(?:pub\s+)?struct\s+\w+/gm,
      /^(?:pub\s+)?enum\s+\w+/gm,
      /^(?:pub\s+)?trait\s+\w+/gm,
    ];
    for (const pat of patterns) {
      for (const m of content.matchAll(pat)) {
        const sig = m[0].trim().slice(0, 120);
        if (!sigs.includes(sig)) sigs.push(sig);
      }
    }
    return sigs;
  }

  private extractImportPaths(content: string): string[] {
    const imports: string[] = [];
    const importMatches = content.matchAll(/from\s+['"](\.[^'"]+)['"]/g);
    for (const m of importMatches) {
      if (m[1] && !imports.includes(m[1])) imports.push(m[1]);
    }
    const useMatches = content.matchAll(/use\s+(?:crate|super)::([^;{]+)/g);
    for (const m of useMatches) {
      if (m[1] && !imports.includes(m[1])) imports.push(m[1].trim());
    }
    return imports;
  }

  private classifySignature(sig: string): EditTarget['kind'] {
    const lower = sig.toLowerCase();
    if (/\bclass\b/.test(lower)) return 'class';
    if (/\binterface\b/.test(lower)) return 'interface';
    if (/\btype\b/.test(lower)) return 'type';
    if (/\bfunction\b|\bfn\b/.test(lower)) return 'function';
    if (/\bmethod\b/.test(lower)) return 'method';
    if (/\bexport\b/.test(lower)) return 'export';
    return 'block';
  }

  private findSymbolLineRange(content: string, signature: string): [number, number] | null {
    const sigPrefix = signature.slice(0, 60);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(sigPrefix.split('(')[0].trim().split(' ').pop() || '')) {
        let depth = 0;
        let started = false;
        for (let j = i; j < lines.length; j++) {
          for (const ch of lines[j]) {
            if (ch === '{') { depth++; started = true; }
            else if (ch === '}') depth--;
          }
          if (started && depth <= 0) return [i + 1, j + 1];
        }
        return [i + 1, Math.min(i + 30, lines.length)];
      }
    }
    return null;
  }

  /**
   * Sanitize query for FTS5 to avoid syntax errors.
   */
  private sanitizeFts5Query(query: string): string {
    if (!query || typeof query !== 'string') {
      return '';
    }

    let out = '';
    let prevWasStripped = false;
    for (const ch of query) {
      if (/[\w-]/.test(ch)) {
        prevWasStripped = false;
        out += ch;
      } else if (!prevWasStripped && out.length > 0) {
        out += ' ';
        prevWasStripped = true;
      }
    }
    const sanitized = out.trim();

    if (!/[a-zA-Z0-9]{2,}/.test(sanitized)) {
      return '';
    }

    return sanitized;
  }

  private extractKeywords(request: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'need', 'want', 'make', 'add',
      'create', 'update', 'fix', 'change', 'modify', 'implement', 'we', 'i',
      'you', 'it', 'this', 'that', 'these', 'those', 'my', 'our', 'your'
    ]);
    
    const sanitized = this.sanitizeFts5Query(request);
    
    const words = sanitized
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    
    const identifiers = request.match(/[A-Z][a-z]+[A-Z][a-zA-Z]*/g) || [];
    const snakeCase = request.match(/[a-z]+_[a-z_]+/g) || [];
    
    return [...new Set([...words, ...identifiers.map(i => i.toLowerCase()), ...snakeCase])].slice(0, 10);
  }

  private extractPatterns(files: { path: string; content: string }[]): string[] {
    const patterns: string[] = [];
    for (const file of files) {
      const imports = file.content.match(/^import .+ from ['"].+['"]/gm) || [];
      const exports = file.content.match(/^export (default |const |function |class )/gm) || [];
      const classNames = file.content.match(/class \w+/g) || [];
      if (imports.length > 0) patterns.push(`Imports pattern in ${file.path}`);
      if (exports.length > 0) patterns.push(`Exports: ${exports.slice(0, 3).join(', ')}`);
      if (classNames.length > 0) patterns.push(`Classes: ${classNames.slice(0, 3).join(', ')}`);
    }
    return [...new Set(patterns)].slice(0, 10);
  }

  /**
   * Resume execution after plan approval
   */
  async resumeAfterApproval(
    sessionId: string,
    projectPath: string,
    config: OrchestratorConfig
  ): Promise<void> {
    const swarmStore = useSwarmStore.getState();
    
    if (!swarmStore.plan) {
      throw new Error('No plan to execute');
    }
    
    // Reconstruct plan from existing tasks
    const plan: TaskPlan = {
      tasks: swarmStore.tasks.map(t => ({
        title: t.title,
        description: t.description,
        role: t.assignedRole,
        files: t.fileClaims,
        contextNeeded: [],
        dependencies: t.dependencies,
        priority: 0,
      })),
      summary: swarmStore.plan,
      estimatedTokens: 0,
      estimatedCost: 0,
    };
    
    swarmStore.approvePlan();
    await this.executePlan(sessionId, plan, projectPath, config);
  }

  /**
   * Create a task plan using the orchestrator model
   */
  private async createPlan(
    userRequest: string,
    projectPath: string,
    config: OrchestratorConfig,
    research?: ResearchResult
  ): Promise<TaskPlan> {
    const swarmStore = useSwarmStore.getState();
    
    // Build rich context from research digest
    let researchContext = '';
    const digest = (research as ResearchResult & { digest?: ResearchDigest })?.digest;
    if (digest && digest.files.size > 0) {
      const fileDigests: string[] = [];
      for (const [path, fd] of digest.files) {
        const role = research!.filesToModify.includes(path) ? 'EDIT' : 'REF';
        const sigs = fd.signatures.length > 0 ? `\n  Signatures: ${fd.signatures.slice(0, 8).join('; ')}` : '';
        const deps = fd.imports.length > 0 ? `\n  Imports: ${fd.imports.slice(0, 6).join(', ')}` : '';
        const importedBy = fd.importedBy.length > 0 ? `\n  Imported by: ${fd.importedBy.slice(0, 4).join(', ')}` : '';
        const targets = fd.editTargets.length > 0
          ? `\n  Edit targets: ${fd.editTargets.map(t => `${t.symbol}(${t.kind}${t.lineRange ? `:${t.lineRange[0]}-${t.lineRange[1]}` : ''}) — ${t.reason}`).join('; ')}`
          : '';
        fileDigests.push(`- [${role}] ${path} (relevance:${fd.relevanceScore})${sigs}${deps}${importedBy}${targets}`);
      }

      const depEdges = Array.from(digest.dependencyGraph.entries())
        .filter(([, deps]) => deps.length > 0)
        .map(([src, deps]) => `  ${src} -> ${deps.join(', ')}`)
        .slice(0, 20);

      researchContext = `=== RESEARCH DIGEST ===

${digest.projectProfile}

=== FILE DIGESTS (${digest.files.size} files) ===
${fileDigests.join('\n')}

=== DEPENDENCY GRAPH ===
${depEdges.join('\n') || '(no cross-file dependencies detected)'}

=== CANDIDATE EDIT TARGETS (${digest.editPlan.length}) ===
${digest.editPlan.map(t => `- ${t.file}:${t.symbol}(${t.kind}${t.lineRange ? `:${t.lineRange[0]}-${t.lineRange[1]}` : ''}) — ${t.reason}`).join('\n') || '(none identified — agents will discover targets)'}
`;
    } else if (research && research.rawFindings) {
      researchContext = `
=== RESEARCH FINDINGS ===
${research.rawFindings}

=== FILES TO MODIFY ===
${research.filesToModify.map(f => `- ${f}`).join('\n') || 'No specific files identified - analyze based on request'}

=== CONTEXT/REFERENCE FILES ===
${research.filesForContext.map(f => `- ${f}`).join('\n') || 'None'}

=== PATTERNS FOUND ===
${research.patterns.join('\n') || 'None identified'}

=== DEPENDENCIES ===
${research.dependencies.join('\n') || 'None identified'}
`;
    } else {
      // Fallback to basic profile if no research
      try {
        const profile = await invoke<any>('atls_get_project_profile');
        if (profile) {
          researchContext = `Project: ${profile.proj}
Languages: ${Object.keys(profile.stats?.langs || {}).join(', ')}
Files: ${profile.stats?.files || 'unknown'}
Architecture: ${profile.arch?.mods?.join(', ') || 'unknown'}

NOTE: No detailed research available - you'll need to be more exploratory.`;
        }
      } catch (e) {
        console.warn('[Orchestrator] Could not get project profile:', e);
      }
    }
    
    // Build messages for orchestrator with full research context
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `${researchContext}

=== USER REQUEST ===
${userRequest}

=== INSTRUCTIONS ===
Based on the research above, create a detailed task plan. 
- Use the ACTUAL FILE PATHS found in research
- Each file can only be edited by ONE agent
- Include specific code patterns/functions found in your task descriptions
- Tasks should be detailed enough for an agent to work independently`,
      },
    ];
    
    // Call orchestrator model
    const appSettings = useAppStore.getState().settings;
    const planModelSettings = resolveModelSettings(
      appSettings.modelOutputSpeed, appSettings.modelThinking,
      config.model, config.provider, 4096,
    );
    const aiConfig: AIConfig = {
      provider: config.provider,
      model: config.model,
      apiKey: resolveApiKey(config.provider),
      maxTokens: 4096,
      temperature: 0.3,
      ...planModelSettings,
    };
    
    let planJson = '';
    let streamError: Error | null = null;
    
    console.log('[Orchestrator] Calling AI for plan with model:', config.model);
    
    const {
      sessionInputTokens: planInTok,
      sessionOutputTokens: planOutTok,
      sessionCostCents: planCostCents,
    } = await streamChatForSwarm(
      messages,
      aiConfig,
      ORCHESTRATOR_SYSTEM_PROMPT,
      projectPath,
      {
        onToken: (text: string) => {
          planJson += text;
          // Log progress periodically
          if (planJson.length % 500 === 0) {
            console.log(`[Orchestrator] Received ${planJson.length} chars...`);
          }
        },
        onToolCall: () => {},
        onToolResult: () => {},
        onDone: () => {
          console.log(`[Orchestrator] Stream complete, received ${planJson.length} chars`);
        },
        onError: (error: Error) => {
          console.error('[Orchestrator] Stream error:', error);
          streamError = error;
        },
      },
      { mode: 'planner', enableTools: false }
    );

    swarmStore.recordOrchestrationPlanUsage(planInTok, planOutTok, Math.round(planCostCents));
    const planSessionId = swarmStore.sessionId;
    if (planSessionId) {
      try {
        await chatDb.recordAgentStats(
          planSessionId,
          SWARM_ORCHESTRATION_PLAN_TASK_ID,
          config.model,
          Math.round(planInTok),
          Math.round(planOutTok),
          Math.round(planCostCents),
        );
      } catch (e) {
        console.warn('[Orchestrator] Could not persist plan-phase agent stats:', e);
      }
    }
    
    // Check for streaming errors
    if (streamError) {
      throw streamError;
    }
    
    // Check for empty response
    if (!planJson || planJson.trim().length === 0) {
      throw new Error('Orchestrator returned empty response - check API key and model configuration');
    }
    
    // Parse plan JSON - robust extraction with multiple strategies
    try {
      console.log('[Orchestrator] Raw plan response:', planJson.slice(0, 500));
      
      let parsed: any = null;
      
      // Strategy 1: Direct parse (model followed instructions and output raw JSON)
      // Strip leading/trailing whitespace only — cheapest and most reliable
      {
        const trimmed = planJson.trim();
        // Quick sanity check: starts with { and ends with }
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            parsed = JSON.parse(trimmed);
            console.log('[Orchestrator] Direct JSON parse succeeded');
          } catch (e) {
            console.debug('[Orchestrator] Direct JSON parse failed, trying extraction:', e);
          }
        }
      }
      
      // Strategy 2: Extract outermost JSON object using balanced-brace matching
      // This handles: preamble text { ... } trailing text
      // And avoids the old regex bug where ``` inside JSON strings matched code fences
      if (!parsed) {
        const firstBrace = planJson.indexOf('{');
        if (firstBrace !== -1) {
          // Find the matching closing brace (balanced)
          let depth = 0;
          let inString = false;
          let escaped = false;
          let lastBrace = -1;
          
          for (let i = firstBrace; i < planJson.length; i++) {
            const ch = planJson[i];
            if (escaped) {
              escaped = false;
              continue;
            }
            if (ch === '\\' && inString) {
              escaped = true;
              continue;
            }
            if (ch === '"') {
              inString = !inString;
              continue;
            }
            if (inString) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) {
                lastBrace = i;
                break;
              }
            }
          }
          
          if (lastBrace !== -1) {
            const extracted = planJson.slice(firstBrace, lastBrace + 1);
            try {
              parsed = JSON.parse(extracted);
              console.log('[Orchestrator] Balanced-brace extraction succeeded');
            } catch (e) {
              console.debug('[Orchestrator] Balanced-brace extraction failed:', e);
            }
          }
        }
      }
      
      // Strategy 3: Extract from markdown code fence (only top-level fences)
      // Match ``` at start-of-line to avoid matching fences inside JSON string values
      if (!parsed) {
        const fenceMatch = planJson.match(/^```(?:json)?\s*\n([\s\S]*?)\n```/m);
        if (fenceMatch && fenceMatch[1]) {
          try {
            parsed = JSON.parse(fenceMatch[1].trim());
            console.log('[Orchestrator] Code fence extraction succeeded');
          } catch (e) {
            console.debug('[Orchestrator] Code fence JSON parse failed:', e);
          }
        }
      }
      
      if (!parsed) {
        throw new Error('Could not extract valid JSON from response');
      }
      
      console.log('[Orchestrator] Parsed response, checking structure...');
      
      // Validate we have tasks
      if (!parsed.tasks || !Array.isArray(parsed.tasks)) {
        throw new Error('Response missing tasks array');
      }
      
      // Validate and convert to TaskPlan
      const tasks: PlannedTask[] = parsed.tasks.map((t: any) => ({
        title: t.title || 'Untitled Task',
        description: t.description || '',
        role: this.validateRole(t.role),
        files: Array.isArray(t.files) ? t.files : [],
        contextNeeded: Array.isArray(t.contextNeeded) ? t.contextNeeded : [],
        dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
        priority: typeof t.priority === 'number' ? t.priority : 0,
        editTargets: Array.isArray(t.editTargets)
          ? t.editTargets.map((et: any) => ({
              file: et.file || '',
              symbol: et.symbol || '',
              kind: et.kind || 'block',
              lineRange: Array.isArray(et.lineRange) && et.lineRange.length === 2
                ? et.lineRange as [number, number]
                : undefined,
              reason: et.reason || '',
            }))
          : undefined,
      }));
      
      if (tasks.length === 0) {
        throw new Error('No tasks in plan');
      }
      
      console.log(`[Orchestrator] Parsed ${tasks.length} tasks`);
      
      // Create tasks in swarm store with hash-seeded context
      const taskIdMap = new Map<string, string>();
      
      for (const task of tasks) {
        const agentConfig = swarmStore.agentConfigs.find(c => c.role === task.role);
        
        // Populate contextHashes from research: raw for owned files, smart for references
        const ownedHashes = task.files
          .map(f => research?.rawHashes?.get(f))
          .filter((h): h is string => !!h);
        const ctxHashes = (task.contextNeeded || [])
          .map(f => research?.smartHashes?.get(f))
          .filter((h): h is string => !!h);
        
        const taskId = swarmStore.addTask({
          title: task.title,
          description: task.description,
          assignedModel: agentConfig?.model || config.model,
          assignedProvider: agentConfig?.provider || config.provider,
          assignedRole: task.role,
          contextHashes: [...ownedHashes, ...ctxHashes],
          fileClaims: task.files,
          contextFiles: task.contextNeeded || [],
          dependencies: task.dependencies.map(dep => taskIdMap.get(dep) || dep),
        });
        
        taskIdMap.set(task.title, taskId);
        
        // Save to database with the SAME taskId to maintain foreign key consistency
        try {
          await chatDb.createTask(
            swarmStore.sessionId!,
            task.title,
            task.description,
            undefined,       // parentTaskId
            agentConfig?.model,
            task.role,
            [],              // contextHashes
            task.files,
            taskId           // CRITICAL: Pass the same taskId for FK consistency
          );
        } catch (dbError: any) {
          console.error('[Orchestrator] Failed to save task to DB:', dbError);
        }
      }
      
      return {
        tasks,
        summary: parsed.summary || 'Task plan created',
        estimatedTokens: 0,
        estimatedCost: 0,
      };
      
    } catch (e) {
      console.error('[Orchestrator] Failed to parse plan:', e);
      console.error('[Orchestrator] Raw response was:', planJson);
      
      // Fallback: Create a single task from the user request
      console.log('[Orchestrator] Creating fallback single-task plan');
      
      const fallbackTask: PlannedTask = {
        title: 'Execute User Request',
        description: userRequest,
        role: 'coder',
        files: [],
        contextNeeded: [],
        dependencies: [],
        priority: 1,
      };
      
      const agentConfig = swarmStore.agentConfigs.find(c => c.role === 'coder');
      
      swarmStore.addTask({
        title: fallbackTask.title,
        description: fallbackTask.description,
        assignedModel: agentConfig?.model || config.model,
        assignedProvider: agentConfig?.provider || config.provider,
        assignedRole: fallbackTask.role,
        contextHashes: [],
        fileClaims: [],
        contextFiles: [],
        dependencies: [],
      });
      
      return {
        tasks: [fallbackTask],
        summary: `Fallback plan (parsing failed): ${planJson.slice(0, 100)}...`,
        estimatedTokens: 0,
        estimatedCost: 0,
      };
    }
  }

  /**
   * Execute the task plan
   */
  private async executePlan(
    sessionId: string,
    _plan: TaskPlan,
    projectPath: string,
    config: OrchestratorConfig
  ): Promise<void> {
    const _swarmStore = useSwarmStore.getState();
    
    this._isRunning = true;
    await chatDb.updateSwarmStatus(sessionId, 'running');
    
    try {
      // Start polling for ready tasks
      this.pollInterval = setInterval(() => {
        this.processReadyTasks(projectPath, config);
      }, 1000);
      
      // Initial processing
      await this.processReadyTasks(projectPath, config);
      
      // Wait for completion
      await this.waitForCompletion();
    } finally {
      this.cleanup();
    }
    
    // Phase 4: Synthesis — orchestrator recap of all task results
    const postState = useSwarmStore.getState();
    const shouldSynthesize = (config.enableSynthesis ?? true) && postState.tasks.length > 1;
    if (shouldSynthesize && !postState.cancelRequested) {
      try {
        await this.synthesizeResults(sessionId, projectPath, config);
      } catch (synthError) {
        console.warn('[Orchestrator] Synthesis failed (non-fatal):', synthError);
      }
    }

    // Final status — sync UI store (DB was updated per-phase; swarm panel must leave synthesizing)
    const finalState = useSwarmStore.getState();
    const finalStatus = finalState.stats.failedTasks > 0 ? 'failed' : 'completed';
    useSwarmStore.getState().setStatus(finalStatus);
    await chatDb.updateSwarmStatus(sessionId, finalStatus);
  }

  // ============================================================================
  // Synthesis Phase
  // ============================================================================

  private static readonly SYNTHESIS_SYSTEM_PROMPT = `You are a senior engineering lead reviewing the results of a multi-agent swarm. Output ONLY valid JSON.

Summarize the swarm outcome for the developer. Be concise and actionable.

## JSON Format
{
  "summary": "1-3 sentence overview of what was accomplished",
  "filesChanged": ["list of files that were modified"],
  "risks": ["potential issues, regressions, or things to watch — omit if none"],
  "suggestedFollowUps": ["next steps the developer should consider — omit if none"],
  "openQuestions": ["unresolved items or ambiguities — omit if none"],
  "verdict": "success | partial | failed"
}

CRITICAL: Output ONLY the raw JSON object. No markdown, no explanation, no code fences.`;

  private async synthesizeResults(
    sessionId: string,
    _projectPath: string,
    config: OrchestratorConfig,
  ): Promise<void> {
    const swarmStore = useSwarmStore.getState();
    swarmStore.setStatus('synthesizing');
    await chatDb.updateSwarmStatus(sessionId, 'synthesizing');

    console.log('[Orchestrator] Starting synthesis phase...');

    const tasks = swarmStore.tasks;
    const planSummary = swarmStore.plan || '';

    // Build structured task results for the synthesis model
    const taskSummaries = tasks.map(t => {
      const filesChanged = t.fileClaims.join(', ') || 'none';
      const result = t.result ? t.result.slice(0, 1200) : '(no result)';
      const error = t.error ? `Error: ${t.error}` : '';
      return `### ${t.title} (${t.assignedRole}) — ${t.status}
Files: ${filesChanged}
${error}
${result}`;
    }).join('\n\n');

    // Collect blackboard entries
    const contextStore = useContextStore.getState();
    const bbEntries = contextStore.listBlackboardEntries();
    const bbSection = bbEntries.length > 0
      ? `\n## Blackboard\n${bbEntries.map(e => `${e.key}: ${e.preview}`).join('\n')}`
      : '';

    const s = swarmStore.stats;
    const statsLine = `Tasks: ${s.completedTasks} completed, ${s.failedTasks} failed | Tokens (workers+plan): ${s.totalTokensUsed} | Cost (workers+plan): $${(s.totalCostCents / 100).toFixed(4)} | Plan phase: ${s.planPhaseTokens} tok / $${(s.planPhaseCostCents / 100).toFixed(4)}`;

    const userMessage = `## Plan
${planSummary}

## Task Results
${taskSummaries}
${bbSection}

## Stats
${statsLine}

## Original User Request
${swarmStore.userRequest || '(unknown)'}

Synthesize the swarm outcome.`;

    // Use the orchestrator model (or a cheaper one if available)
    const synthAppSettings = useAppStore.getState().settings;
    const synthModelSettings = resolveModelSettings(
      synthAppSettings.modelOutputSpeed, synthAppSettings.modelThinking,
      config.model, config.provider, 2048,
    );
    const synthConfig: AIConfig = {
      provider: config.provider,
      model: config.model,
      apiKey: resolveApiKey(config.provider),
      maxTokens: 2048,
      temperature: 0.2,
      ...synthModelSettings,
    };

    let synthJson = '';
    let synthError: Error | null = null;

    const {
      sessionInputTokens: synthInTok,
      sessionOutputTokens: synthOutTok,
      sessionCostCents: synthCostCents,
    } = await streamChatForSwarm(
      [{ role: 'user', content: userMessage }],
      synthConfig,
      OrchestratorService.SYNTHESIS_SYSTEM_PROMPT,
      _projectPath,
      {
        onToken: (text: string) => { synthJson += text; },
        onToolCall: () => {},
        onToolResult: () => {},
        onDone: () => {
          console.log(`[Orchestrator] Synthesis stream complete, ${synthJson.length} chars`);
        },
        onError: (error: Error) => {
          console.error('[Orchestrator] Synthesis stream error:', error);
          synthError = error;
        },
      },
      { mode: 'planner', enableTools: false },
    );

    swarmStore.recordOrchestrationSynthesisUsage(synthInTok, synthOutTok, Math.round(synthCostCents));
    if (sessionId) {
      try {
        await chatDb.recordAgentStats(
          sessionId,
          SWARM_ORCHESTRATION_SYNTHESIS_TASK_ID,
          config.model,
          Math.round(synthInTok),
          Math.round(synthOutTok),
          Math.round(synthCostCents),
        );
      } catch (e) {
        console.warn('[Orchestrator] Could not persist synthesis agent stats:', e);
      }
    }

    if (synthError) {
      console.warn('[Orchestrator] Synthesis stream failed:', synthError);
      return;
    }

    if (!synthJson.trim()) {
      console.warn('[Orchestrator] Synthesis returned empty response');
      return;
    }

    // Parse the synthesis JSON (same robust extraction as createPlan)
    let parsed: any = null;
    const trimmed = synthJson.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try { parsed = JSON.parse(trimmed); } catch { /* fall through */ }
    }
    if (!parsed) {
      const firstBrace = synthJson.indexOf('{');
      const lastBrace = synthJson.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try { parsed = JSON.parse(synthJson.slice(firstBrace, lastBrace + 1)); } catch { /* fall through */ }
      }
    }

    if (parsed) {
      const synthesis = [
        `**${parsed.verdict === 'success' ? 'Completed' : parsed.verdict === 'partial' ? 'Partially Completed' : 'Failed'}**`,
        '',
        parsed.summary || '',
        '',
        parsed.filesChanged?.length ? `**Files changed:** ${parsed.filesChanged.join(', ')}` : '',
        parsed.risks?.length ? `**Risks:** ${parsed.risks.join('; ')}` : '',
        parsed.suggestedFollowUps?.length ? `**Suggested follow-ups:** ${parsed.suggestedFollowUps.join('; ')}` : '',
        parsed.openQuestions?.length ? `**Open questions:** ${parsed.openQuestions.join('; ')}` : '',
      ].filter(Boolean).join('\n');

      swarmStore.setSynthesis(synthesis);
      console.log('[Orchestrator] Synthesis stored:', synthesis.slice(0, 200));

      // Persist synthesis to context store + DB blackboard
      try {
        const ctxStore = useContextStore.getState();
        const synthHash = ctxStore.addChunk(synthesis, 'result', 'orchestrator:synthesis');
        const synthChunk = ctxStore.getAllChunks().find(c => c.hash === synthHash);
        if (synthChunk) {
          await chatDb.addBlackboardEntry(sessionId, synthChunk);
        }
      } catch (e) {
        console.warn('[Orchestrator] Could not persist synthesis to DB:', e);
      }
    } else {
      // Fallback: store raw text
      swarmStore.setSynthesis(synthJson.trim());
      console.warn('[Orchestrator] Synthesis JSON parse failed, stored raw text');
    }
  }

  /**
   * Process tasks that are ready to run
   */
  private async processReadyTasks(
    projectPath: string,
    config: OrchestratorConfig
  ): Promise<void> {
    const swarmStore = useSwarmStore.getState();
    
    // Check if cancelled
    if (swarmStore.cancelRequested) {
      this._isRunning = false;
      return;
    }
    
    // Check if paused
    if (swarmStore.status === 'paused') {
      return;
    }
    
    // Get ready tasks
    const readyTasks = swarmStore.getReadyTasks();
    const runningTasks = swarmStore.getRunningTasks();
    
    // Calculate available slots
    const availableSlots = config.maxConcurrentAgents - runningTasks.length;
    
    if (availableSlots <= 0 || readyTasks.length === 0) {
      return;
    }
    
    // Start tasks up to available slots
    const tasksToStart = readyTasks.slice(0, availableSlots);
    
    for (const task of tasksToStart) {
      this.dispatchRevs.set(task.id, useContextStore.getState().getCurrentRev());
      this.startAgent(task, projectPath, config);
    }
  }

  /**
   * Start an agent for a task
   */
  private async startAgent(
    task: SwarmTask,
    projectPath: string,
    config: OrchestratorConfig
  ): Promise<void> {
    const swarmStore = useSwarmStore.getState();
    const abortController = new AbortController();
    
    // Update task status
    swarmStore.updateTaskStatus(task.id, 'running');
    
    const execution: AgentExecution = {
      taskId: task.id,
      abortController,
      promise: this.runAgent(task, projectPath, config, abortController.signal),
    };
    
    this.activeAgents.set(task.id, execution);
    
    // Handle completion
    execution.promise
      .then(() => {
        this.activeAgents.delete(task.id);
      })
      .catch((error) => {
        console.error(`[Orchestrator] Agent ${task.id} error:`, error);
        this.activeAgents.delete(task.id);
      });
  }

  /**
   * Run an agent for a task with full iteration loop
   * Agent will iterate until task_complete is called or max iterations reached
   */
  private async runAgent(
    task: SwarmTask,
    projectPath: string,
    _config: OrchestratorConfig,
    _signal: AbortSignal
  ): Promise<void> {
    const swarmStore = useSwarmStore.getState();
    
    // Check rate limit - retry with exponential backoff
    let acquired = false;
    try {
      acquired = await rateLimiter.acquire(task.assignedProvider, 30000);
    } catch (e) {
      console.error(`[Agent] Rate limiter error for task ${task.id}:`, e);
      acquired = false;
    }
    
    if (!acquired) {
      // Rate limit timeout - put back in queue for retry if under limit
      const currentRetryCount = task.retryCount || 0;
      const maxRetries = task.maxRetries ?? 10;
      console.log(`[Agent] Task ${task.id} rate limit timeout (retry ${currentRetryCount}/${maxRetries})`);
      
      if (currentRetryCount < maxRetries - 1) { // -1 because updateTaskError will increment
        // Exponential backoff with jitter to avoid thundering herd
        // Base: 5s, doubles each retry, max 60s, plus random jitter 0-5s
        const baseDelay = 5000;
        const maxDelay = 60000;
        const exponentialDelay = Math.min(baseDelay * Math.pow(2, currentRetryCount), maxDelay);
        const jitter = Math.random() * 5000; // 0-5s random jitter
        const totalDelay = exponentialDelay + jitter;
        
        console.log(`[Agent] Task ${task.id} requeuing for retry, waiting ${(totalDelay/1000).toFixed(1)}s...`);
        // updateTaskError increments retryCount automatically
        swarmStore.updateTaskError(task.id, `Rate limit, retry ${currentRetryCount + 1}/${maxRetries} in ${Math.round(totalDelay/1000)}s`);
        
        // Wait with backoff before setting to pending
        await new Promise(resolve => setTimeout(resolve, totalDelay));
        
        swarmStore.updateTaskStatus(task.id, 'pending');
        console.log(`[Agent] Task ${task.id} set to pending after backoff`);
        return; // Don't call release() - we never acquired!
      }
      // Max retries exceeded
      console.log(`[Agent] Task ${task.id} max retries exceeded, marking as failed`);
      swarmStore.updateTaskError(task.id, 'Rate limit timeout after max retries');
      swarmStore.updateTaskStatus(task.id, 'failed');
      return; // Don't call release() - we never acquired!
    }
    
    // We acquired - now the finally block should release
    let agentTerminalId: string | null = null;
    const agentLabel = `${task.assignedRole}-${task.id.slice(0, 6)}`;
    
    try {
      // Create a DEDICATED terminal for this agent (isolated shell state)
      // Background=true prevents stealing user's active terminal focus
      const terminalStore = getTerminalStore();
      const needsTerminal = ['coder', 'debugger', 'tester'].includes(task.assignedRole);
      if (needsTerminal) {
        try {
          agentTerminalId = await terminalStore.createTerminal(projectPath, {
            background: true,
            name: `Agent: ${agentLabel}`,
            isAgent: true,
          });
          // Brief settle time for PTY initialization
          await new Promise(resolve => setTimeout(resolve, 100));
          console.log(`[Agent:${agentLabel}] Created dedicated terminal: ${agentTerminalId}`);
        } catch (termError) {
          console.warn(`[Agent:${agentLabel}] Could not create terminal, will use fallback:`, termError);
        }
      }
      
      // Get research results from store (contains pre-loaded file contents)
      const research = swarmStore.research;
      
      // Gather completed dependency results for inter-agent context
      const dependencyResults = this.gatherDependencyResults(task, swarmStore.tasks);
      
      // Build layered prompt: Layer 1 (system) + Layer 3 (context)
      const { systemPrompt, contextBlock } = this.buildAgentPrompt(
        task, research, projectPath, dependencyResults, 15
      );
      
      // 4-layer message structure (matching chat agent architecture):
      // Layer 1: systemPrompt (passed via config — cached, high attention)
      // Layer 3: contextBlock (injected before task message)
      // Layer 4: task execution message (peak attention)
      const messages: ChatMessage[] = [
        // Layer 3: Context from blackboard
        { role: 'user', content: contextBlock },
        { role: 'assistant', content: 'Context loaded. Ready to execute task.' },
        // Layer 4: Task execution (peak attention position)
        {
          role: 'user',
          content: `Execute your task now. Batch the planned implementation work first. Verify at a milestone or near the end unless the boundary is risky. Call task_complete only after final verification or a real blocker.`,
        },
      ];
      
      // AI config — use per-agent speed/thinking overrides when set, else main settings
      const agentSettings = useAppStore.getState().settings;
      const agentCfg = swarmStore.agentConfigs.find(c => c.role === task.assignedRole);
      const agentModelSettings = resolveModelSettings(
        agentCfg?.outputSpeed ?? agentSettings.modelOutputSpeed,
        agentCfg?.thinking ?? agentSettings.modelThinking,
        task.assignedModel, task.assignedProvider, 8192,
      );
      const aiConfig: AIConfig = {
        provider: task.assignedProvider,
        model: task.assignedModel,
        apiKey: resolveApiKey(task.assignedProvider),
        maxTokens: 8192,
        temperature: 0.4,
        ...agentModelSettings,
      };
      
      // Stream chat with tools — per-round cost in costStore + rateLimiter; main chat context bar/round counter skipped by default (affectMainChatMetrics false).
      const toolCallNames = new Map<string, string>();
      const {
        taskCompleted,
        taskStatus,
        result,
        taskCompleteSummary,
        sessionInputTokens,
        sessionOutputTokens,
        sessionCostCents,
      } = await streamChatForSwarm(
        messages,
        aiConfig,
        systemPrompt,
        projectPath,
        {
          onToken: (text: string) => {
            swarmStore.appendToTaskMessage(task.id, text);
          },
          onToolCall: (toolCall: import('./aiService').ToolCallEvent) => {
            toolCallNames.set(toolCall.id, toolCall.name);
            swarmStore.addTaskMessage(task.id, {
              role: 'tool',
              content: `Calling ${toolCall.name}...`,
              toolName: toolCall.name,
            });
          },
          onToolResult: (id: string, toolResult: string) => {
            const name = toolCallNames.get(id) ?? 'unknown';
            const displayResult = toolResult.length > 500 
              ? toolResult.slice(0, 500) + '...[truncated]' 
              : toolResult;
            swarmStore.addTaskMessage(task.id, {
              role: 'tool',
              content: displayResult,
              toolName: name,
              toolResult: displayResult,
            });
          },
          onDone: () => {
            console.log(`[Agent:${agentLabel}] Stream completed`);
          },
          onError: (error: Error) => {
            throw error;
          },
        },
        { 
          mode: 'agent', 
          enableTools: true,
          maxIterations: 15,  // Up to 15 tool rounds per agent (increased for complex tasks)
          maxAutoContinues: 3, // Auto-continue up to 3 times if no task_complete
          swarmTerminalId: agentTerminalId || undefined,
          agentRole: task.assignedRole,
          taskId: task.id,
          fileClaims: task.fileClaims, // File ownership enforcement
          swarmSessionId: swarmStore.sessionId || undefined,
        }
      );
      
      // Update task with results (sessionCostCents is sum of cache-aware per-round costs from streamChatForSwarm)
      swarmStore.updateTaskResult(task.id, taskCompleteSummary || result);
      swarmStore.updateTaskStats(
        task.id,
        sessionInputTokens + sessionOutputTokens,
        Math.round(sessionCostCents),
      );
      
      // Post-completion freshness: bump workspace rev and reconcile owned files against disk
      useContextStore.getState().bumpWorkspaceRev();
      const claimedFiles = task.fileClaims || [];
      if (claimedFiles.length > 0) {
        try {
          const diskRevisions = await invoke<Record<string, string | null>>('get_current_revisions', { paths: claimedFiles });
          for (const file of claimedFiles) {
            const diskHash = diskRevisions[file];
            if (diskHash) {
              useContextStore.getState().reconcileSourceRevision(file, diskHash);
            }
          }
        } catch (e) {
          console.warn('[orchestrator] disk revision lookup failed, falling back to awareness:', e);
          for (const file of claimedFiles) {
            const awareness = useContextStore.getState().getAwareness(file);
            if (awareness) {
              useContextStore.getState().reconcileSourceRevision(file, awareness.snapshotHash);
            }
          }
        }
      }
      this.dispatchRevs.delete(task.id);
      
      // Distinguish explicit completion from blocked/incomplete agent exits
      const finalStatus: ChatTaskStatus = taskCompleted
        ? 'completed'
        : (taskStatus === 'awaiting_input' ? 'awaiting_input' : 'failed');
      swarmStore.updateTaskStatus(task.id, finalStatus);
      
      if (!taskCompleted) {
        console.log(`[Agent:${agentLabel}] Finished without explicit task_complete (iteration limit reached)`);
      }
      
      console.log(`[Agent:${agentLabel}] Done: ${sessionInputTokens + sessionOutputTokens} tokens, $${(sessionCostCents / 100).toFixed(4)}`);
      
      // Record stats to database (non-fatal if fails)
      try {
        await chatDb.recordAgentStats(
          swarmStore.sessionId!,
          task.id,
          task.assignedModel,
          Math.round(sessionInputTokens),
          Math.round(sessionOutputTokens),
          Math.round(sessionCostCents),
        );
      } catch (statsError: unknown) {
        const errorMsg = statsError instanceof Error ? statsError.message : String(statsError);
        console.warn(`[Agent:${agentLabel}] Failed to record stats:`, errorMsg);
      }
      
      try {
        await chatDb.updateTaskStatus(task.id, finalStatus);
        await chatDb.updateTaskResult(task.id, taskCompleteSummary || result);
      } catch (dbError: any) {
        console.warn(`[Agent:${agentLabel}] Failed to update DB:`, dbError.message);
      }
      
    } catch (error: any) {
      console.error(`[Agent:${agentLabel}] Failed:`, error);
      
      // Handle rate limit errors with exponential backoff
      if (error.message?.includes('429') || error.message?.includes('rate limit')) {
        rateLimiter.recordRateLimitError(task.assignedProvider);
        
        const retryMaxRetries = task.maxRetries ?? 10;
        if ((task.retryCount || 0) < retryMaxRetries - 1) {
          const currentRetryCount = task.retryCount || 0;
          const baseDelay = 5000;
          const maxDelay = 60000;
          const exponentialDelay = Math.min(baseDelay * Math.pow(2, currentRetryCount), maxDelay);
          const jitter = Math.random() * 5000;
          const totalDelay = exponentialDelay + jitter;
          
          console.log(`[Agent:${agentLabel}] Rate limited, waiting ${(totalDelay/1000).toFixed(1)}s before retry...`);
          swarmStore.updateTaskError(task.id, `Rate limited, retry ${currentRetryCount + 1}/${retryMaxRetries} in ${Math.round(totalDelay/1000)}s`);
          
          await new Promise(resolve => setTimeout(resolve, totalDelay));
          swarmStore.updateTaskStatus(task.id, 'pending');
          return;
        }
      }
      
      // Mark as failed
      swarmStore.updateTaskError(task.id, error.message || 'Unknown error');
      swarmStore.updateTaskStatus(task.id, 'failed');
      await chatDb.updateTaskStatus(task.id, 'failed');
      await chatDb.updateTaskError(task.id, error.message || 'Unknown error');
      
    } finally {
      rateLimiter.release(task.assignedProvider);
      
      // Clean up dedicated agent terminal
      if (agentTerminalId) {
        try {
          const terminalStore = getTerminalStore();
          await terminalStore.closeTerminal(agentTerminalId);
          console.log(`[Agent:${agentLabel}] Closed dedicated terminal`);
        } catch (termCleanupError) {
          console.warn(`[Agent:${agentLabel}] Terminal cleanup failed:`, termCleanupError);
        }
      }
    }
  }

  /**
   * Wait for all tasks to complete
   */
  private async waitForCompletion(): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const state = useSwarmStore.getState();
        
        // Check if cancelled (any mode — graceful or immediate)
        if (state.cancelRequested) {
          clearInterval(checkInterval);
          this.completionInterval = null;
          resolve();
          return;
        }
        
        // Check if all done
        const pending = state.tasks.filter(t => t.status === 'pending').length;
        const running = state.tasks.filter(t => t.status === 'running').length;
        
        if (pending === 0 && running === 0) {
          clearInterval(checkInterval);
          this.completionInterval = null;
          resolve();
        }
      }, 1000);
      this.completionInterval = checkInterval;
    });
  }

  /**
   * Clean up intervals and active agents
   */
  private cleanup(): void {
    this._isRunning = false;
    
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.completionInterval) {
      clearInterval(this.completionInterval);
      this.completionInterval = null;
    }
    
    // Cancel any remaining agents
    for (const [_taskId, execution] of this.activeAgents) {
      execution.abortController.abort();
    }
    this.activeAgents.clear();
    this.dispatchRevs.clear();
  }

  /**
   * Cancel the current swarm
   */
  cancel(mode: 'graceful' | 'immediate'): void {
    const swarmStore = useSwarmStore.getState();
    swarmStore.cancelSwarm(mode);
    
    if (mode === 'immediate') {
      this.cleanup();
    }
  }

  /**
   * Get project context (OS, shell, CWD) for agents
   */
  private async getProjectContext(projectPath: string): Promise<{ cwd: string; os: string; shell: string } | null> {
    try {
      // Detect OS
      const isWindows = projectPath.includes('\\') || projectPath.match(/^[A-Za-z]:/);
      const os = isWindows ? 'windows' : (projectPath.startsWith('/Users/') ? 'macos' : 'linux');
      
      // Default shell based on OS
      const shell = isWindows ? 'powershell' : (os === 'macos' ? 'zsh' : 'bash');
      
      return {
        cwd: projectPath,
        os,
        shell,
      };
    } catch (e) {
      console.warn('[Orchestrator] Could not determine project context:', e);
      return null;
    }
  }

  /**
   * Gather results from completed dependency tasks for inter-agent context
   */
  private gatherDependencyResults(task: SwarmTask, allTasks: SwarmTask[]): string {
    if (!task.dependencies || task.dependencies.length === 0) return '';
    
    const depResults: string[] = [];
    for (const depId of task.dependencies) {
      const depTask = allTasks.find(t => t.id === depId);
      if (depTask && depTask.status === 'completed' && depTask.result) {
        depResults.push(`### ${depTask.title} (${depTask.assignedRole})
Files changed: ${depTask.fileClaims.join(', ') || 'none'}
Result: ${depTask.result.slice(0, 1500)}`);
      }
    }

    // Include blackboard entries written by dependency tasks (keyed by taskId prefix)
    const contextStore = useContextStore.getState();
    const bbEntries = contextStore.listBlackboardEntries();
    const depBbEntries = bbEntries.filter(e => {
      return task.dependencies?.some(depId => e.key.startsWith(depId.slice(0, 8)));
    });
    if (depBbEntries.length > 0) {
      depResults.push(`### Shared Knowledge from Dependencies\n${depBbEntries.map(e => `${e.key}: ${e.preview}`).join('\n')}`);
    }
    
    return depResults.length > 0 
      ? `\n## COMPLETED DEPENDENCY RESULTS\nThese tasks completed before yours. Their changes are already on disk.\n\n${depResults.join('\n\n')}`
      : '';
  }

  /**
   * Build agent prompt as a 4-layer architecture (matching chat agent structure).
   * Now acts as a context compiler: inlines full content for owned files,
   * signatures for references, and specific edit targets with line ranges.
   * Uses token budget to progressively degrade when context is too large.
   */
  private buildAgentPrompt(
    task: SwarmTask,
    research: ResearchResult | null,
    projectPath: string,
    dependencyResults?: string,
    maxIterations?: number
  ): { systemPrompt: string; contextBlock: string } {
    const role = task.assignedRole;
    const roleDocs = ROLE_TOOL_DOCS[role] || ROLE_TOOL_DOCS.coder;
    const toolDocs = `${BATCH_TOOL_REF}

${roleDocs}`;
    
    const ROLE_IDENTITY: Record<AgentRole, string> = {
      orchestrator: '',
      coder: 'You are an expert software engineer. You write clean, well-structured, production-quality code that follows existing patterns in the codebase.',
      debugger: 'You are an expert debugger and systems analyst. You methodically investigate issues, identify root causes, and implement targeted, defensive fixes.',
      reviewer: 'You are a senior code reviewer focused on correctness, security, performance, and maintainability. You provide specific, actionable feedback.',
      tester: 'You are a test engineer who writes comprehensive, focused tests. You cover happy paths, edge cases, error conditions, and integration boundaries.',
      documenter: 'You are a technical writer who creates clear, accurate documentation with examples. You focus on what developers need to know.',
    };

    const ctx = research?.projectContext;
    let shellBlock = '';
    if (ctx?.shell === 'powershell' || ctx?.os === 'windows') {
      shellBlock = `OS: Windows | Shell: PowerShell | CWD: ${ctx?.cwd || projectPath}
Shell rules: Use PowerShell cmdlets for system operations only.
  Build → cargo build, npm run build | Packages → npm install, pip install
  Git → git status, git diff, git log | Env → $env:VAR | path sep → \\
Code operations: use ATLS tools for reads/search/edits; do not use Get-Content or Select-String on code files.
${EDIT_DISCIPLINE}`;
    } else if (ctx?.os === 'macos' || ctx?.shell === 'zsh') {
      shellBlock = `OS: macOS | Shell: zsh | CWD: ${ctx?.cwd || projectPath}
Shell rules: Standard Unix commands (ls, cat, grep, cd, pwd).
${EDIT_DISCIPLINE}`;
    } else {
      shellBlock = `OS: Linux | Shell: bash | CWD: ${ctx?.cwd || projectPath}
Shell rules: Standard Unix commands (ls, cat, grep, cd, pwd).
${EDIT_DISCIPLINE}`;
    }
    
    const patternsInfo = research?.patterns?.length 
      ? `\nCodebase patterns: ${research.patterns.slice(0, 5).join('; ')}`
      : '';

    const budgetLine = maxIterations 
      ? `\n## BUDGET\n- You have ~${maxIterations} tool rounds. Plan efficiently. File content is pre-loaded below — start implementing immediately.`
      : '';

    // ─── LAYER 1: System prompt (role + tools + rules) ───
    const systemPrompt = `${ROLE_IDENTITY[role] || ROLE_IDENTITY.coder}
You are part of a coordinated agent swarm. Focus ONLY on your assigned task.

## ENVIRONMENT
${shellBlock}${patternsInfo}

${toolDocs}

## CRITICAL RULES
1. SCOPE: Only do what your task describes. Other agents handle other parts.
2. OWNERSHIP: Only write to files in your ownership list. Read any file you need.
3. PATHS: Always use ABSOLUTE paths for all file operations.
4. PRE-LOADED CONTEXT: Your owned files are pre-loaded below with full content. Do NOT re-read them unless you suspect they changed on disk. Start implementing immediately.
5. VERIFICATION: Batch related implementation work first, then verify at a milestone or near task completion unless the boundary is risky.
6. COMPLETION: Do NOT call task_complete until verify.build completes successfully OR you hit a blocker. If blocked, call task_complete with the blocker reason. Include files_changed array.
7. CONFIRMATION BOUNDARIES: If any tool returns preview, paused, rollback, action_required, or confirm-needed state, stop at that boundary. Resolve it, then continue the task if planned work remains.
8. STATE CHANGES: If the user reports a bug, lint/build error, or any new instruction, assume state changed and re-evaluate before continuing or completing.
9. QUALITY: Follow existing code patterns. Add error handling. No placeholder/TODO code.
10. OUTPUT: No narration or filler. Lead with summary. Bullets over paragraphs. Code over prose. Every token costs money.${budgetLine}`;

    // ─── LAYER 3: Context block — hydrated task packet ───
    const contextStore = useContextStore.getState();
    const swarmStore = useSwarmStore.getState();
    const userRequest = swarmStore.userRequest || '';
    const digest = (research as ResearchResult & { digest?: ResearchDigest })?.digest;

    // Token budget for context block (reserve room for system prompt + output)
    const contextBudget = DEFAULT_AGENT_CONTEXT_BUDGET;
    let tokensUsed = 0;

    const budgetLog: string[] = [];
    const trackTokens = (label: string, content: string): number => {
      const tk = countTokensSync(content);
      tokensUsed += tk;
      budgetLog.push(`${label}: ${(tk / 1000).toFixed(1)}k`);
      return tk;
    };

    // --- Build task header ---
    const taskHeader = `## CONTEXT

## ORIGINAL USER REQUEST
${userRequest}

## YOUR TASK: ${task.title}
${task.description}

## FILE OWNERSHIP
You may ONLY write to these files: ${task.fileClaims.length > 0 ? task.fileClaims.join(', ') : '(none assigned — use judgment based on task description)'}`;
    trackTokens('task-header', taskHeader);

    // --- Build edit targets section ---
    let editTargetsSection = '';
    const taskEditTargets = digest
      ? task.fileClaims.flatMap(f => digest.files.get(f)?.editTargets || [])
      : [];
    if (taskEditTargets.length > 0) {
      editTargetsSection = `\n## EDIT TARGETS (specific locations to modify)\n${taskEditTargets.map(t =>
        `- ${t.file}:${t.symbol}(${t.kind}${t.lineRange ? `:${t.lineRange[0]}-${t.lineRange[1]}` : ''}) — ${t.reason}`
      ).join('\n')}`;
      trackTokens('edit-targets', editTargetsSection);
    }

    // --- Inline owned file content (full raw content, budget-aware) ---
    let ownedFilesSection = '';
    if (task.fileClaims.length > 0) {
      const ownedParts: string[] = [];
      for (const filePath of task.fileClaims) {
        const rawContent = research?.fileContents?.get(filePath);
        const fd = digest?.files.get(filePath);

        if (rawContent && (tokensUsed + countTokensSync(rawContent)) < contextBudget) {
          // Full content fits — inline it
          const fileBlock = `### ${filePath} [EDIT]\n\`\`\`\n${rawContent}\n\`\`\``;
          trackTokens(`owned:${filePath.split(/[/\\]/).pop()}`, fileBlock);
          ownedParts.push(fileBlock);
        } else if (fd?.smartContent && (tokensUsed + countTokensSync(fd.smartContent)) < contextBudget) {
          // Degrade to signatures
          const sigBlock = `### ${filePath} [EDIT — signatures only, load full with read.context]\n${fd.smartContent}`;
          trackTokens(`owned-sig:${filePath.split(/[/\\]/).pop()}`, sigBlock);
          ownedParts.push(sigBlock);
        } else {
          // Degrade to hash ref
          const hash = research?.rawHashes?.get(filePath) || research?.smartHashes?.get(filePath);
          const ref = hash ? `h:${hash}` : 'load on demand';
          ownedParts.push(`### ${filePath} [EDIT — ${ref}, load with read.context type:"full"]`);
        }
      }
      if (ownedParts.length > 0) {
        ownedFilesSection = `\n## YOUR FILES (pre-loaded content)\n${ownedParts.join('\n\n')}`;
      }
    }
    
    // --- Inline reference file signatures (budget-aware) ---
    let refFilesSection = '';
    if (task.contextFiles && task.contextFiles.length > 0) {
      const refParts: string[] = [];
      for (const filePath of task.contextFiles) {
        if (task.fileClaims.includes(filePath)) continue;
        const fd = digest?.files.get(filePath);

        if (fd?.signatures.length && (tokensUsed + countTokensSync(fd.signatures.join('\n'))) < contextBudget) {
          const sigBlock = `### ${filePath} [READ-ONLY]\nSignatures: ${fd.signatures.join('; ')}`;
          trackTokens(`ref:${filePath.split(/[/\\]/).pop()}`, sigBlock);
          refParts.push(sigBlock);
        } else if (fd?.smartContent && (tokensUsed + countTokensSync(fd.smartContent)) < contextBudget) {
          const smartBlock = `### ${filePath} [READ-ONLY]\n${fd.smartContent}`;
          trackTokens(`ref-smart:${filePath.split(/[/\\]/).pop()}`, smartBlock);
          refParts.push(smartBlock);
        } else {
          const hash = research?.smartHashes?.get(filePath);
          refParts.push(`### ${filePath} [READ-ONLY — ${hash ? `h:${hash}` : 'load on demand'}]`);
        }
      }
      if (refParts.length > 0) {
        refFilesSection = `\n## REFERENCE FILES (read-only)\n${refParts.join('\n\n')}`;
      }
    }

    // --- Dependency context: signatures of files that import/are-imported-by owned files ---
    let depContextSection = '';
    if (digest && tokensUsed < contextBudget * 0.85) {
      const depPaths = new Set<string>();
      for (const filePath of task.fileClaims) {
        const fd = digest.files.get(filePath);
        if (fd) {
          for (const imp of fd.imports) depPaths.add(imp);
          for (const ib of fd.importedBy) depPaths.add(ib);
        }
      }
      // Remove files already shown
      for (const fp of task.fileClaims) depPaths.delete(fp);
      for (const fp of (task.contextFiles || [])) depPaths.delete(fp);

      const depParts: string[] = [];
      for (const depPath of depPaths) {
        if (tokensUsed >= contextBudget * 0.9) break;
        const fd = digest.files.get(depPath);
        if (fd?.signatures.length) {
          const line = `- ${depPath}: ${fd.signatures.slice(0, 5).join('; ')}`;
          trackTokens(`dep:${depPath.split(/[/\\]/).pop()}`, line);
          depParts.push(line);
        }
      }
      if (depParts.length > 0) {
        depContextSection = `\n## DEPENDENCY CONTEXT (signatures of related files)\n${depParts.join('\n')}`;
      }
    }

    // --- Blackboard ---
    let blackboardSection = '';
    const bbEntries = contextStore.listBlackboardEntries();
    if (bbEntries.length > 0) {
      const bbLines = bbEntries.map(e => `${e.key}: ${e.preview}`).join('\n');
      blackboardSection = `\n## SHARED KNOWLEDGE (blackboard — persists across agents)\n${bbLines}`;
      trackTokens('blackboard', blackboardSection);
    }

    // --- Compressed chunk index ---
    let compressedIndex = '';
    if (tokensUsed < contextBudget * 0.95) {
      const allChunks = contextStore.getAllChunks();
      const compressedRefs = allChunks
        .filter(c => c.type === 'result' || c.type === 'call')
        .map(c => `[-> ${c.shortHash}, ${c.tokens}tk | ${c.source || c.type}]`);
      if (compressedRefs.length > 0) {
        compressedIndex = `\n## COMPRESSED (use batch session.recall to retrieve)\n${compressedRefs.join('\n')}`;
        trackTokens('compressed-index', compressedIndex);
      }
    }

    // --- Budget summary for observability ---
    const budgetSummary = `\n<!-- Hydration budget: ${(tokensUsed / 1000).toFixed(1)}k / ${(contextBudget / 1000).toFixed(0)}k tokens | ${budgetLog.join(' | ')} -->`;

    const contextBlock = `${taskHeader}
${editTargetsSection}
${ownedFilesSection}
${refFilesSection}
${depContextSection}
${blackboardSection}
${compressedIndex}
${dependencyResults || ''}
${budgetSummary}`;

    console.log(`[Orchestrator] Hydration for ${task.title}: ${(tokensUsed / 1000).toFixed(1)}k tokens (${budgetLog.length} blocks)`);

    return { systemPrompt, contextBlock };
  }

  /**
   * Validate and normalize role
   */
  private validateRole(role: string): AgentRole {
    const validRoles: AgentRole[] = ['orchestrator', 'coder', 'debugger', 'reviewer', 'tester', 'documenter'];
    const normalized = role?.toLowerCase() as AgentRole;
    return validRoles.includes(normalized) ? normalized : 'coder';
  }
}

// Export singleton instance
export const orchestrator = new OrchestratorService();

// Export types
export type { OrchestratorService };
