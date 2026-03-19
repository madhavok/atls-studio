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
import { calculateCost } from '../stores/costStore';
import type { ContextUsage } from '../stores/appStore';
import { getTerminalStore } from '../stores/terminalStore';
import { chatDb, type TaskStatus as ChatTaskStatus } from './chatDb';
import { rateLimiter } from './rateLimiter';
import { streamChatForSwarm, ATLS_TOOL_REF, type AIConfig, type ChatMessage, type AIProvider } from './aiService';
import { toTOON } from '../utils/toon';

// ============================================================================
// Types
// ============================================================================

export interface OrchestratorConfig {
  model: string;
  provider: AIProvider;
  maxConcurrentAgents: number;
  autoApprove: boolean;
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
}

interface AgentExecution {
  taskId: string;
  abortController: AbortController;
  promise: Promise<void>;
}

// ============================================================================
// Orchestrator Prompts
// ============================================================================

const ORCHESTRATOR_SYSTEM_PROMPT = `You are a senior engineering lead decomposing a task for a team of specialist agents. Output ONLY valid JSON.

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
5. DETAILED DESCRIPTIONS: Include specific function names, patterns, and line-level guidance from the research. Each agent works alone with only its assigned context.
6. MINIMAL TASKS: Prefer fewer, well-scoped tasks over many tiny ones. Group related changes into one task when they touch the same files.
7. PRIORITY: Lower number = runs first (along with dependency ordering).
8. TASK COUNT: Aim for 2-5 tasks. If the request is simple, 1-2 tasks may suffice. More than 7 tasks usually means over-decomposition.

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
      "priority": 1
    }
  ]
}

CRITICAL: Output ONLY the raw JSON object. No markdown, no explanation, no code fences.`;

// ============================================================================
// Role-Specific Tool Documentation (minimal, focused)
// ============================================================================

const ROLE_TOOL_DOCS: Record<AgentRole, string> = {
  orchestrator: '',
  
  coder: `## Tools
- batch read.context type:"smart"| "full" file_paths:[...] → understand code
- batch search.code / search.symbol → locate code and symbols
- batch change.edit / change.refactor / change.rollback → modify code
- batch session.recall / session.stage / session.drop / session.compact → manage context
- batch session.bb.write / session.bb.read → shared blackboard
- batch system.exec / verify.build / verify.typecheck → run commands and verify (verify.build still required before task_complete)
- task_complete({summary, files_changed:[]}) → REQUIRED when done (do NOT call until verify.build succeeds or blocker)
- If any tool returns preview, paused, rollback, action_required, or confirm-needed state, STOP at that boundary. Resolve it, then continue the task if planned work remains. Do not call task_complete.

## Workflow
1. Review pre-loaded context + SHARED KNOWLEDGE below.
2. If you need deeper understanding: use read.context type:"full" or session.recall.
3. Plan the task, batch the related implementation work, and perform a canonical full read before any change.edit or manual refactor mutation inside batch.
4. For large refactors: analyze.impact before execute; finish the current implementation batch, then verify; rollback on failure.
5. Record key decisions with session.bb.write key:"impl-decisions".
6. Run verify.build near task completion or at a meaningful milestone. Verify earlier only for risky boundaries that could invalidate later work.
7. If the user gives new instructions or reports a bug/lint/build error, treat state as changed and re-evaluate before continuing.
8. task_complete with summary and files_changed list.`,

  debugger: `## Tools
- batch read.context type:"smart"| "full" file_paths:[...] → structural summary or full content
- batch search.issues / search.code → static analysis and search
- batch change.edit → targeted fixes
- batch session.recall / session.stage / session.bb.write / session.bb.read → shared context
- batch system.exec / verify.build → run and reproduce (verify.build still required before task_complete)
- task_complete({summary, files_changed:[]}) → REQUIRED when done (do NOT call until verify.build succeeds or blocker)
- If any tool returns preview, paused, rollback, action_required, or confirm-needed state, STOP at that boundary. Resolve it, then continue the task if planned work remains. Do not call task_complete.

## Workflow
1. Reproduce the bug: read context + run tests via exec.
2. Trace root cause: search.code + search.issues.
3. Record root cause with session.bb.write key:"root-cause".
4. Implement the full targeted fix before final verification when risk is low.
5. Run verify.build after the fix is in place; verify earlier only if the bug hunt crosses a risky boundary.
6. If the user reports a new bug or lint/build error, treat state as changed and re-evaluate before continuing.
7. task_complete with root cause analysis and fix description.`,

  reviewer: `## Tools
- batch read.context type:"smart" file_paths:[...] → structural summary
- batch search.issues / search.code → static analysis and pattern search
- batch session.stage / session.recall / session.bb.write / session.bb.read → focused review context
- task_complete({summary, issues_found:[]}) → REQUIRED: report findings
- If the scope changes mid-review, stop and re-evaluate before reporting completion.

## Workflow (READ-ONLY — you cannot write files)
1. Review pre-loaded files for correctness, security, performance, style.
2. Use search.issues for static analysis results.
3. Record findings with session.bb.write key:"review-findings".
4. task_complete with structured findings:
   - summary: overall assessment
   - issues_found: [{file, line, severity, description}]`,

  tester: `## Tools
- batch read.context type:"smart"| "full" file_paths:[...] → understand code and read test targets
- batch change.edit / change.create → write tests
- batch session.bb.read / session.recall / session.stage → load implementation notes
- batch system.exec / verify.build → run tests (verify.build still required before task_complete)
- task_complete({summary, files_changed:[]}) → REQUIRED when done (do NOT call until verify.build succeeds or blocker)
- If any tool returns preview, paused, rollback, action_required, or confirm-needed state, STOP at that boundary. Resolve it, then continue the task if planned work remains. Do not call task_complete.

## Workflow
1. Read shared knowledge with session.bb.read key:"impl-decisions".
2. Review pre-loaded context to understand the API/behavior to test.
3. Write the planned test coverage first: happy path, edge cases, error conditions.
4. Run verify.build after the test batch is ready; verify earlier only if the test harness or setup is risky.
5. If the user reports new failures or changed requirements, re-evaluate before continuing.
6. task_complete with coverage summary and any issues found.`,

  documenter: `## Tools
- batch read.context type:"smart" file_paths:[...] → understand structure
- batch change.edit / change.create → write documentation
- batch session.bb.read / session.recall / session.stage → load prior findings
- task_complete({summary, files_changed:[]}) → REQUIRED when done (documenter: no build gate)

## Workflow (NO exec — you cannot run commands)
1. Read shared knowledge with session.bb.read keys:["impl-decisions","review-findings"].
2. Review pre-loaded context for structure and API surface.
3. Write clear documentation: purpose, API, examples, edge cases.
4. task_complete with summary of what was documented.`,
};

// Note: Role-based tool enforcement is now in aiService.ts streamChatForSwarm()
// The ROLE_ALLOWED_TOOLS map there is the source of truth for runtime validation.

// ============================================================================
// Orchestrator Class
// ============================================================================

class OrchestratorService {
  private activeAgents: Map<string, AgentExecution> = new Map();
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
      
    } catch (error) {
      console.error('[Orchestrator] Error:', error);
      swarmStore.resetSwarm();
      throw error;
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
          } catch { /* skip unreadable */ }
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
      
      // Step 8: Build research summary
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
      
      // Extract patterns and dependencies from available content
      const patternable = smartContentForAnalysis.map(f => ({
        path: f.path,
        content: f.content,
        summary: f.content.split('\n').slice(0, 50).join('\n'),
      }));
      const patterns = this.extractPatterns(patternable);
      const dependencies = this.extractDependencies(patternable);
      swarmStore.addResearchLog(`  🔗 Patterns found: ${patterns.length}`);
      swarmStore.addResearchLog(`  📦 Dependencies tracked: ${dependencies.length}`);
      
      // Final summary
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
      };
      
    } catch (error) {
      console.error('[Research] Research phase failed:', error);
      swarmStore.addResearchLog(`❌ Research error: ${error}`);
      return defaultResult;
    }
  }

  /**
   * Sanitize query for FTS5 to avoid syntax errors.
   * Mirrors the Rust `sanitize_fts_input` in atls-core/query/search.rs:
   * keeps alphanumeric, underscore, hyphen; collapses everything else
   * into single spaces so `<CloseIcon>` -> `CloseIcon`, `foo::bar` -> `foo bar`.
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

  /**
   * Extract relevant keywords from user request
   */
  private extractKeywords(request: string): string[] {
    // Remove common words and extract meaningful terms
    const stopWords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'need', 'want', 'make', 'add',
      'create', 'update', 'fix', 'change', 'modify', 'implement', 'we', 'i',
      'you', 'it', 'this', 'that', 'these', 'those', 'my', 'our', 'your'
    ]);
    
    // Sanitize for FTS5 first
    const sanitized = this.sanitizeFts5Query(request);
    
    const words = sanitized
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    
    // Also extract potential identifiers (camelCase, snake_case, etc.)
    const identifiers = request.match(/[A-Z][a-z]+[A-Z][a-zA-Z]*/g) || [];
    const snakeCase = request.match(/[a-z]+_[a-z_]+/g) || [];
    
    return [...new Set([...words, ...identifiers.map(i => i.toLowerCase()), ...snakeCase])].slice(0, 10);
  }

  /**
   * Extract code patterns from file contents
   */
  private extractPatterns(files: { path: string; content: string }[]): string[] {
    const patterns: string[] = [];
    
    for (const file of files) {
      // Look for common patterns
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
   * Extract dependencies between files
   */
  private extractDependencies(files: { path: string; content: string }[]): string[] {
    const deps: string[] = [];
    
    for (const file of files) {
      const localImports = file.content.match(/from ['"]\.\.?\/.+['"]/g) || [];
      for (const imp of localImports.slice(0, 3)) {
        deps.push(`${file.path} imports ${imp}`);
      }
    }
    
    return deps.slice(0, 10);
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
    
    // Build rich context from research
    let researchContext = '';
    if (research && research.rawFindings) {
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
    const aiConfig: AIConfig = {
      provider: config.provider,
      model: config.model,
      apiKey: '', // Will be filled from settings
      maxTokens: 4096,
      temperature: 0.3,
    };
    
    let planJson = '';
    let streamError: Error | null = null;
    
    console.log('[Orchestrator] Calling AI for plan with model:', config.model);
    
    await streamChatForSwarm(
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
        onUsageUpdate: (usage: ContextUsage) => {
          const cost = calculateCost(config.provider, config.model, usage.inputTokens, usage.outputTokens);
          console.log(`[Orchestrator] Plan cost: ${usage.inputTokens + usage.outputTokens} tokens, $${(cost / 100).toFixed(4)}`);
        },
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
          } catch {
            // JSON is malformed, fall through to extraction strategies
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
            } catch {
              // Still malformed, fall through
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
          } catch {
            // Content inside fence isn't valid JSON
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
    
    // Start polling for ready tasks
    this.pollInterval = setInterval(() => {
      this.processReadyTasks(projectPath, config);
    }, 1000);
    
    // Initial processing
    await this.processReadyTasks(projectPath, config);
    
    // Wait for completion
    await this.waitForCompletion();
    
    // Cleanup
    this.cleanup();
    
    // Final status
    const finalState = useSwarmStore.getState();
    const finalStatus = finalState.stats.failedTasks > 0 ? 'failed' : 'completed';
    await chatDb.updateSwarmStatus(sessionId, finalStatus);
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
      console.log(`[Agent] Task ${task.id} rate limit timeout (retry ${currentRetryCount}/${task.maxRetries})`);
      
      if (currentRetryCount < task.maxRetries - 1) { // -1 because updateTaskError will increment
        // Exponential backoff with jitter to avoid thundering herd
        // Base: 5s, doubles each retry, max 60s, plus random jitter 0-5s
        const baseDelay = 5000;
        const maxDelay = 60000;
        const exponentialDelay = Math.min(baseDelay * Math.pow(2, currentRetryCount), maxDelay);
        const jitter = Math.random() * 5000; // 0-5s random jitter
        const totalDelay = exponentialDelay + jitter;
        
        console.log(`[Agent] Task ${task.id} requeuing for retry, waiting ${(totalDelay/1000).toFixed(1)}s...`);
        // updateTaskError increments retryCount automatically
        swarmStore.updateTaskError(task.id, `Rate limit, retry ${currentRetryCount + 1}/${task.maxRetries} in ${Math.round(totalDelay/1000)}s`);
        
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
      
      // AI config
      const aiConfig: AIConfig = {
        provider: task.assignedProvider,
        model: task.assignedModel,
        apiKey: '', // Will be filled from settings
        maxTokens: 8192,
        temperature: 0.4, // Slightly lower for more deterministic agent behavior
      };
      
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      
      // Stream chat with tools - uses internal iteration loop
      const toolCallNames = new Map<string, string>();
      const { taskCompleted, taskStatus, result, taskCompleteSummary } = await streamChatForSwarm(
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
          onUsageUpdate: (usage: ContextUsage) => {
            totalInputTokens = usage.inputTokens;
            totalOutputTokens = usage.outputTokens;
            rateLimiter.recordSuccess(task.assignedProvider, usage.inputTokens, usage.outputTokens);
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
        }
      );
      
      // Update task with results (cost recording handled per-round inside streamChatForSwarm)
      const cost = calculateCost(task.assignedProvider, task.assignedModel, totalInputTokens, totalOutputTokens);
      swarmStore.updateTaskResult(task.id, taskCompleteSummary || result);
      swarmStore.updateTaskStats(task.id, totalInputTokens + totalOutputTokens, cost);
      
      // Distinguish explicit completion from blocked/incomplete agent exits
      const finalStatus: ChatTaskStatus = taskCompleted
        ? 'completed'
        : (taskStatus === 'awaiting_input' ? 'awaiting_input' : 'failed');
      swarmStore.updateTaskStatus(task.id, finalStatus);
      
      if (!taskCompleted) {
        console.log(`[Agent:${agentLabel}] Finished without explicit task_complete (iteration limit reached)`);
      }
      
      console.log(`[Agent:${agentLabel}] Done: ${totalInputTokens + totalOutputTokens} tokens, $${(cost / 100).toFixed(4)}`);
      
      // Record stats to database (non-fatal if fails)
      try {
        await chatDb.recordAgentStats(
          swarmStore.sessionId!,
          task.id,
          task.assignedModel,
          Math.round(totalInputTokens),
          Math.round(totalOutputTokens),
          Math.round(cost)
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
        
        if (task.retryCount < task.maxRetries) {
          const currentRetryCount = task.retryCount || 0;
          const baseDelay = 5000;
          const maxDelay = 60000;
          const exponentialDelay = Math.min(baseDelay * Math.pow(2, currentRetryCount), maxDelay);
          const jitter = Math.random() * 5000;
          const totalDelay = exponentialDelay + jitter;
          
          console.log(`[Agent:${agentLabel}] Rate limited, waiting ${(totalDelay/1000).toFixed(1)}s before retry...`);
          swarmStore.updateTaskError(task.id, `Rate limited, retry ${currentRetryCount + 1}/${task.maxRetries} in ${Math.round(totalDelay/1000)}s`);
          
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
      }, 500);
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
   * Returns { systemPrompt, contextBlock } so the caller can inject Layer 3 separately.
   * 
   * Layer 1 (systemPrompt): Role + tools + rules + environment (CACHED, high attention)
   * Layer 3 (contextBlock): Task + owned files + reference summaries + dependency results
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
    const toolDocs = `${ATLS_TOOL_REF}

${roleDocs}`;
    
    // Role-specific identity and expertise
    const ROLE_IDENTITY: Record<AgentRole, string> = {
      orchestrator: '',
      coder: 'You are an expert software engineer. You write clean, well-structured, production-quality code that follows existing patterns in the codebase.',
      debugger: 'You are an expert debugger and systems analyst. You methodically investigate issues, identify root causes, and implement targeted, defensive fixes.',
      reviewer: 'You are a senior code reviewer focused on correctness, security, performance, and maintainability. You provide specific, actionable feedback.',
      tester: 'You are a test engineer who writes comprehensive, focused tests. You cover happy paths, edge cases, error conditions, and integration boundaries.',
      documenter: 'You are a technical writer who creates clear, accurate documentation with examples. You focus on what developers need to know.',
    };

    // Project context with shell-specific guidance
    const ctx = research?.projectContext;
    let shellBlock = '';
    const commonDiscipline = `Ref discipline: default to read_shaped(..., shape:"sig") for planning only; before any change.edit, re-read the exact target in the same batch with read.context(type:"full") or read.file, then gather read.lines anchors with context_lines:3 if helpful; never mutate from shaped, stale, or suspect refs.
Speed discipline: batch reconnaissance together, keep mutation batches single-target, use shell/system only for builds/git/packages or bulk mechanical moves, and verify once per structural phase or final milestone.
Workflow discipline: BB entries are the source of truth for long-running task status and plans; if working-memory task headers conflict with BB or the latest verification result, BB plus latest verification win and stale headers must be regenerated or ignored.
Condition discipline: do not rely on undocumented or unsupported conditions such as all_steps_ok; prefer step_ok chains and explicit verification gates. Do not use readonly mode for any batch that might mutate or exec.`;
    if (ctx?.shell === 'powershell' || ctx?.os === 'windows') {
      shellBlock = `OS: Windows | Shell: PowerShell | CWD: ${ctx?.cwd || projectPath}
Shell rules: Use PowerShell cmdlets for system operations only.
  Build → cargo build, npm run build
  Packages → npm install, pip install
  Git → git status, git diff, git log
  Processes → Get-Process, Stop-Process
  Env → $env:VAR        path sep → \\        newline → \`r\`n
Code operations: use ATLS tools for reads/search/edits; do not use Get-Content or Select-String on code files.
${commonDiscipline}`;
    } else if (ctx?.os === 'macos' || ctx?.shell === 'zsh') {
      shellBlock = `OS: macOS | Shell: zsh | CWD: ${ctx?.cwd || projectPath}
Shell rules: Standard Unix commands (ls, cat, grep, cd, pwd).
${commonDiscipline}`;
    } else {
      shellBlock = `OS: Linux | Shell: bash | CWD: ${ctx?.cwd || projectPath}
Shell rules: Standard Unix commands (ls, cat, grep, cd, pwd).
${commonDiscipline}`;
    }
    
    const patternsInfo = research?.patterns?.length 
      ? `\nCodebase patterns: ${research.patterns.slice(0, 5).join('; ')}`
      : '';

    // Budget awareness
    const budgetLine = maxIterations 
      ? `\n## BUDGET\n- You have ~${maxIterations} tool rounds. Plan efficiently.`
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
4. VERIFICATION: Run impact_analysis before modifying existing code. Batch related implementation work first, then verify at a milestone or near task completion unless the boundary is risky.
5. COMPLETION: Do NOT call task_complete until verify.build completes successfully OR you hit a blocker. If blocked, call task_complete with the blocker reason. Include files_changed array. This is a completion gate, not an instruction to verify after every small edit.
6. CONFIRMATION BOUNDARIES: If any tool returns preview, paused, rollback, action_required, or confirm-needed state, stop at that boundary. Resolve it, then continue the task if planned work remains. Never batch later side effects or task_complete after it.
7. STATE CHANGES: If the user reports a bug, lint/build error, or any new instruction, assume state changed and re-evaluate before continuing or completing.
8. EFFICIENCY: Use pre-loaded context below. Use ATLS batch tools for additional reads.
9. QUALITY: Follow existing code patterns. Add error handling. No placeholder/TODO code.
10. OUTPUT: No narration or filler. Lead with summary. Bullets over paragraphs. Code over prose. Every token costs money.${budgetLine}`;

    // ─── LAYER 3: Context block (task + files from blackboard) ───
    const contextStore = useContextStore.getState();
    const swarmStore = useSwarmStore.getState();
    const userRequest = swarmStore.userRequest || '';
    
    const allChunks = contextStore.getAllChunks();
    const describeHash = (hash: string | undefined, label: string, fallbackPath: string): string => {
      if (!hash) return `- ${fallbackPath} (${label}, load on demand)`;
      const chunk = allChunks.find(c => c.shortHash === hash);
      const tokenText = chunk ? `${(chunk.tokens / 1000).toFixed(1)}k tk` : 'tokens unknown';
      const source = chunk?.source || fallbackPath;
      return `- h:${hash} ${source} (${label}, ${tokenText})`;
    };

    // Build owned files section as a lightweight manifest.
    let ownedFilesSection = '';
    if (task.fileClaims.length > 0) {
      const ownedParts: string[] = [];
      for (const filePath of task.fileClaims) {
        const hash = research?.rawHashes?.get(filePath);
        ownedParts.push(describeHash(hash, 'owned', filePath));
      }
      if (ownedParts.length > 0) {
        ownedFilesSection = `\n## YOUR FILES (preloaded manifests; load bodies on demand)\n${ownedParts.join('\n')}`;
      }
    }
    
    // Build reference files section as a lightweight manifest.
    let refFilesSection = '';
    if (task.contextFiles && task.contextFiles.length > 0) {
      const refParts: string[] = [];
      for (const filePath of task.contextFiles) {
        if (task.fileClaims.includes(filePath)) continue;
        const hash = research?.smartHashes?.get(filePath);
        refParts.push(describeHash(hash, 'reference', filePath));
      }
      if (refParts.length > 0) {
        refFilesSection = `\n## REFERENCE FILES (read-only manifests; do NOT write to these)\n${refParts.join('\n')}`;
      }
    }

    // Build blackboard section from contextStore
    let blackboardSection = '';
    const bbEntries = contextStore.listBlackboardEntries();
    if (bbEntries.length > 0) {
      const bbLines = bbEntries.map(e => `${e.key}: ${e.preview}`).join('\n');
      blackboardSection = `\n## SHARED KNOWLEDGE (blackboard — persists across agents)\n${bbLines}`;
    }

    // Build compressed chunk index for recall
    let compressedIndex = '';
    const compressedRefs = allChunks
      .filter(c => c.type === 'result' || c.type === 'call')
      .map(c => `[-> ${c.shortHash}, ${c.tokens}tk | ${c.source || c.type}]`);
    if (compressedRefs.length > 0) {
      compressedIndex = `\n## COMPRESSED (use batch session.recall to retrieve)\n${compressedRefs.join('\n')}`;
    }

    const contextBlock = `## CONTEXT

## ORIGINAL USER REQUEST
${userRequest}

## YOUR TASK: ${task.title}
${task.description}

## FILE OWNERSHIP
You may ONLY write to these files: ${task.fileClaims.length > 0 ? task.fileClaims.join(', ') : '(none assigned — use judgment based on task description)'}
Use the preloaded manifests below first. Load full content only when needed for the next concrete step.
${ownedFilesSection}
${refFilesSection}
${blackboardSection}
${compressedIndex}
${dependencyResults || ''}`;

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
