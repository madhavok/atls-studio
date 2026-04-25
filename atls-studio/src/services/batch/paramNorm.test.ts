import { describe, expect, it } from 'vitest';
import {
  coerceFilePathsArray,
  expandCommaSeparatedFilePaths,
  normalizeHashRefsToStrings,
  normalizeStepParams,
} from './paramNorm';

describe('normalizeStepParams', () => {
  // -----------------------------------------------------------------------
  // Global aliases
  // -----------------------------------------------------------------------

  describe('global file path aliases', () => {
    it('normalizes "file" → "file_path" (singular op)', () => {
      const out = normalizeStepParams('change.edit', { file: 'src/a.ts' });
      expect(out.file_path).toBe('src/a.ts');
      expect(out.file).toBeUndefined();
    });

    it('normalizes "file" → "file_paths" (array op via promotion)', () => {
      const out = normalizeStepParams('search.code', { file: 'src/a.ts', queries: ['x'] });
      expect(out.file_paths).toEqual(['src/a.ts']);
      expect(out.file).toBeUndefined();
      expect(out.file_path).toBeUndefined();
    });

    it('normalizes "f" → "file_path"', () => {
      const out = normalizeStepParams('change.edit', { f: 'src/b.ts' });
      expect(out.file_path).toBe('src/b.ts');
      expect(out.f).toBeUndefined();
    });

    it('normalizes "path" → "file_path" (Cline/Aider/Claude convention)', () => {
      const out = normalizeStepParams('read.lines', { path: 'src/c.ts', lines: '1-10' });
      expect(out.file_path).toBe('src/c.ts');
      expect(out.path).toBeUndefined();
    });

    it('normalizes "target_file" → "file_path" (Cursor convention)', () => {
      const out = normalizeStepParams('change.edit', { target_file: 'src/d.ts' });
      expect(out.file_path).toBe('src/d.ts');
      expect(out.target_file).toBeUndefined();
    });

    it('normalizes "source_file" → "file_path" (singular op)', () => {
      const out = normalizeStepParams('change.edit', { source_file: 'src/e.ts' });
      expect(out.file_path).toBe('src/e.ts');
      expect(out.source_file).toBeUndefined();
    });

    it('preserves "source_file" for change.refactor (rewire_consumers needs it)', () => {
      const out = normalizeStepParams('change.refactor', { source_file: 'src/e.ts' });
      expect(out.source_file).toBe('src/e.ts');
      expect(out.file_paths).toBeUndefined();
    });

    it('preserves "source_file" for intent.test (not promoted to file_paths)', () => {
      const out = normalizeStepParams('intent.test', { source_file: 'src/foo.ts' });
      expect(out.source_file).toBe('src/foo.ts');
      expect(out.file_path).toBeUndefined();
      expect(out.file_paths).toBeUndefined();
    });

    it('preserves both source_file and target_file for intent.extract (global alias collision)', () => {
      const out = normalizeStepParams('intent.extract', {
        source_file: 'h:8aecc6',
        sn: 'close_old_connections',
        target_file: '_test_atls/extracted.py',
      });
      expect(out.source_file).toBe('h:8aecc6');
      expect(out.target_file).toBe('_test_atls/extracted.py');
      expect(out.symbol_names).toEqual(['close_old_connections']);
      expect(out.file_path).toBeUndefined();
    });

    it('maps file_paths[0] to file_path for change.refactor when file_path missing (extract_methods)', () => {
      const out = normalizeStepParams('change.refactor', {
        action: 'extract',
        ps: 'src/lib.rs',
        symbol_names: ['foo'],
      });
      expect(out.file_paths).toEqual(['src/lib.rs']);
      expect(out.file_path).toBe('src/lib.rs');
    });

    it('promotes sn + target_file into extractions for change.refactor extract', () => {
      const out = normalizeStepParams('change.refactor', {
        action: 'extract',
        ps: 'src/big.py',
        sn: 'Calculator',
        target_file: 'src/calc.py',
      });
      expect(out.extractions).toEqual([{ target_file: 'src/calc.py', methods: ['Calculator'] }]);
    });

    it('does not promote extractions when already present', () => {
      const existing = [{ target_file: 'src/x.py', methods: ['foo'] }];
      const out = normalizeStepParams('change.refactor', {
        action: 'extract',
        ps: 'src/big.py',
        sn: 'bar',
        target_file: 'src/y.py',
        extractions: existing,
      });
      expect(out.extractions).toBe(existing);
    });

    it('fills old_name from symbol_names for change.refactor rename', () => {
      const out = normalizeStepParams('change.refactor', {
        action: 'rename',
        sn: 'greet',
        new_name: 'say_hello',
      });
      expect(out.old_name).toBe('greet');
      expect(out.new_name).toBe('say_hello');
    });

    it('does not overwrite existing canonical "file_path"', () => {
      const out = normalizeStepParams('change.edit', { file_path: 'canonical.ts', file: 'alias.ts' });
      expect(out.file_path).toBe('canonical.ts');
    });
  });

  describe('global symbol aliases', () => {
    it('normalizes "symbol" → "symbol_names"', () => {
      const out = normalizeStepParams('analyze.blast_radius', { symbol: 'Foo' });
      expect(out.symbol_names).toEqual(['Foo']);
      expect(out.symbol).toBeUndefined();
    });

    it('normalizes "symbol_name" → "symbol_names"', () => {
      const out = normalizeStepParams('search.usage', { symbol_name: 'Bar' });
      expect(out.symbol_names).toEqual(['Bar']);
      expect(out.symbol_name).toBeUndefined();
    });

    it('normalizes "name" → "symbol_names" for analyze.calls', () => {
      const out = normalizeStepParams('analyze.calls', { name: 'doWork' });
      expect(out.symbol_names).toEqual(['doWork']);
      expect(out.name).toBeUndefined();
    });

    it('normalizes "query" → "symbol_names" for analyze.calls', () => {
      const out = normalizeStepParams('analyze.calls', { query: 'handleRequest' });
      expect(out.symbol_names).toEqual(['handleRequest']);
      expect(out.query).toBeUndefined();
    });
  });

  describe('annotate.note aliases', () => {
    it('normalizes content → note for annotate.note', () => {
      const out = normalizeStepParams('annotate.note', {
        hash: 'h:abc123',
        content: 'my note text',
      });
      expect(out.note).toBe('my note text');
      expect(out.content).toBeUndefined();
    });
  });

  describe('session.rule aliases', () => {
    it('normalizes hash → key for session.rule', () => {
      const out = normalizeStepParams('session.rule', {
        hash: 'h:42a831',
        content: 'rule body',
      });
      expect(out.key).toBe('h:42a831');
      expect(out.hash).toBeUndefined();
      expect(out.content).toBe('rule body');
    });
  });

  describe('global edit content aliases (cross-IDE)', () => {
    it('normalizes "old_str" → "old" (Claude)', () => {
      const out = normalizeStepParams('change.edit', { old_str: 'before', new_str: 'after' });
      expect(out.old).toBe('before');
      expect(out.new).toBe('after');
      expect(out.old_str).toBeUndefined();
      expect(out.new_str).toBeUndefined();
    });

    it('normalizes "old_string" → "old" (Cursor)', () => {
      const out = normalizeStepParams('change.edit', { old_string: 'x', new_string: 'y' });
      expect(out.old).toBe('x');
      expect(out.new).toBe('y');
    });

    it('normalizes "original_lines" → "old" (Aider)', () => {
      const out = normalizeStepParams('change.edit', { original_lines: 'a', updated_lines: 'b' });
      expect(out.old).toBe('a');
      expect(out.new).toBe('b');
    });
  });

  describe('global misc aliases', () => {
    it('normalizes "command" → "cmd"', () => {
      const out = normalizeStepParams('system.exec', { command: 'npm test' });
      expect(out.cmd).toBe('npm test');
      expect(out.command).toBeUndefined();
    });

    it('normalizes "contents" → "content"', () => {
      const out = normalizeStepParams('session.bb.write', { key: 'k', contents: 'v' });
      expect(out.content).toBe('v');
      expect(out.contents).toBeUndefined();
    });

    it('normalizes "refs" → "hashes"', () => {
      const out = normalizeStepParams('session.pin', { refs: ['h:abc'] });
      expect(out.hashes).toEqual(['h:abc']);
      expect(out.refs).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Op-specific aliases
  // -----------------------------------------------------------------------

  describe('search.code op-specific', () => {
    it('normalizes "query" → "queries"', () => {
      const out = normalizeStepParams('search.code', { query: 'auth' });
      expect(out.queries).toEqual(['auth']);
      expect(out.query).toBeUndefined();
    });

    it('does not promote "query" for non-search.code ops', () => {
      const out = normalizeStepParams('search.symbol', { query: 'Foo' });
      expect(out.queries).toBeUndefined();
      // search.symbol maps query → symbol_names
      expect(out.symbol_names).toEqual(['Foo']);
    });
  });

  describe('search.memory op-specific', () => {
    it('normalizes "limit" → "max_results"', () => {
      const out = normalizeStepParams('search.memory', { query: 'cache', limit: 5 });
      expect(out.max_results).toBe(5);
      expect(out.limit).toBeUndefined();
    });
  });

  describe('search.issues op-specific', () => {
    it('normalizes "sf" → "severity" (backend reads `severity`, not `severity_filter`)', () => {
      const out = normalizeStepParams('search.issues', { sf: 'warn' });
      expect(out.severity).toBe('warn');
      expect(out.sf).toBeUndefined();
      expect(out.severity_filter).toBeUndefined();
    });

    it('normalizes "mode" → "issue_mode"', () => {
      const out = normalizeStepParams('search.issues', { mode: 'correctness' });
      expect(out.issue_mode).toBe('correctness');
      expect(out.mode).toBeUndefined();
    });
  });

  describe('search.patterns op-specific', () => {
    it('promotes scalar "patterns" → array', () => {
      const out = normalizeStepParams('search.patterns', { patterns: 'TODO' });
      expect(out.patterns).toEqual(['TODO']);
    });

    it('splits comma-separated "patterns" → array', () => {
      const out = normalizeStepParams('search.patterns', { patterns: 'singleton,factory' });
      expect(out.patterns).toEqual(['singleton', 'factory']);
    });

    it('leaves array "patterns" untouched', () => {
      const out = normalizeStepParams('search.patterns', { patterns: ['a', 'b'] });
      expect(out.patterns).toEqual(['a', 'b']);
    });

    it('does not promote scalar patterns for other ops', () => {
      const out = normalizeStepParams('change.refactor', { patterns: 'TODO' });
      expect(out.patterns).toBe('TODO');
    });
  });

  describe('search.symbol op-specific', () => {
    it('normalizes "name" → "symbol_names"', () => {
      const out = normalizeStepParams('search.symbol', { name: 'MyClass' });
      expect(out.symbol_names).toEqual(['MyClass']);
      expect(out.name).toBeUndefined();
    });

    it('normalizes "query" → "symbol_names"', () => {
      const out = normalizeStepParams('search.symbol', { query: 'doThing' });
      expect(out.symbol_names).toEqual(['doThing']);
      expect(out.query).toBeUndefined();
    });
  });

  describe('analyze.impact / blast_radius op-specific', () => {
    it('normalizes "from" → "file_paths" for analyze.impact', () => {
      const out = normalizeStepParams('analyze.impact', { from: 'src/api.ts' });
      expect(out.file_paths).toEqual(['src/api.ts']);
      expect(out.from).toBeUndefined();
    });

    it('normalizes "from" → "file_paths" for analyze.blast_radius', () => {
      const out = normalizeStepParams('analyze.blast_radius', { from: ['a.ts', 'b.ts'] });
      expect(out.file_paths).toEqual(['a.ts', 'b.ts']);
      expect(out.from).toBeUndefined();
    });

    it('does not remap "from" for annotate.link', () => {
      const out = normalizeStepParams('annotate.link', { from: 'h:abc', to: 'h:def' });
      expect(out.from).toBe('h:abc');
      expect(out.file_paths).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Scalar-to-array coercion
  // -----------------------------------------------------------------------

  describe('scalar-to-array coercion', () => {
    it('promotes file_path string to file_paths array', () => {
      const out = normalizeStepParams('read.context', { file_path: 'src/x.ts', type: 'smart' });
      expect(out.file_paths).toEqual(['src/x.ts']);
      expect(out.file_path).toBeUndefined();
    });

    it('does not promote when file_paths already exists', () => {
      const out = normalizeStepParams('read.context', {
        file_path: 'single.ts',
        file_paths: ['a.ts', 'b.ts'],
        type: 'smart',
      });
      expect(out.file_paths).toEqual(['a.ts', 'b.ts']);
    });

    it('promotes symbol_name string to symbol_names array', () => {
      const out = normalizeStepParams('search.usage', { symbol_name: 'Foo' });
      expect(out.symbol_names).toEqual(['Foo']);
    });
  });

  // -----------------------------------------------------------------------
  // key → keys coercion for blackboard ops
  // -----------------------------------------------------------------------

  describe('key → keys coercion', () => {
    it('promotes key to keys for session.bb.read', () => {
      const out = normalizeStepParams('session.bb.read', { key: 'notes' });
      expect(out.keys).toEqual(['notes']);
      expect(out.key).toBeUndefined();
    });

    it('promotes key to keys for session.bb.delete', () => {
      const out = normalizeStepParams('session.bb.delete', { key: 'old' });
      expect(out.keys).toEqual(['old']);
    });

    it('coerces bare string keys to array for session.bb.read', () => {
      const out = normalizeStepParams('session.bb.read', { keys: 'design-decisions' });
      expect(out.keys).toEqual(['design-decisions']);
    });

    it('coerces bare string keys to array for session.bb.delete', () => {
      const out = normalizeStepParams('session.bb.delete', { keys: 'old-key' });
      expect(out.keys).toEqual(['old-key']);
    });

    it('does not promote key for session.bb.write', () => {
      const out = normalizeStepParams('session.bb.write', { key: 'k', content: 'v' });
      expect(out.key).toBe('k');
      expect(out.keys).toBeUndefined();
    });

    it('maps derivedFrom → derived_from for session.bb.write', () => {
      const out = normalizeStepParams('session.bb.write', {
        key: 'k',
        content: 'x',
        derivedFrom: [{ ref: 'h:aa' }, 'h:bb'],
      });
      expect(out.derived_from).toEqual([{ ref: 'h:aa' }, 'h:bb']);
      expect((out as { derivedFrom?: unknown }).derivedFrom).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Symbol prefix stripping
  // -----------------------------------------------------------------------

  describe('symbol prefix stripping', () => {
    it('strips fn(name) wrapper', () => {
      const out = normalizeStepParams('search.symbol', { symbol_names: ['fn(doThing)'] });
      expect(out.symbol_names).toEqual(['doThing']);
    });

    it('strips cls(name) wrapper', () => {
      const out = normalizeStepParams('search.usage', { symbol_names: ['cls(MyClass)'] });
      expect(out.symbol_names).toEqual(['MyClass']);
    });

    it('strips multiple prefixes in array', () => {
      const out = normalizeStepParams('search.usage', {
        symbol_names: ['fn(a)', 'cls(B)', 'plain'],
      });
      expect(out.symbol_names).toEqual(['a', 'B', 'plain']);
    });

    it('strips prefix from scalar symbol_names', () => {
      const out = normalizeStepParams('search.symbol', { symbol_names: 'fn(solo)' });
      expect(out.symbol_names).toEqual(['solo']);
    });

    it('strips prefix after alias resolution (symbol → symbol_names)', () => {
      const out = normalizeStepParams('analyze.blast_radius', { symbol: 'cls(Widget)' });
      expect(out.symbol_names).toEqual(['Widget']);
    });
  });

  // -----------------------------------------------------------------------
  // Null/undefined stripping
  // -----------------------------------------------------------------------

  describe('null/undefined stripping', () => {
    it('strips null values', () => {
      const out = normalizeStepParams('search.code', { queries: ['x'], limit: null });
      expect(out).not.toHaveProperty('limit');
    });

    it('strips undefined values', () => {
      const out = normalizeStepParams('search.code', { queries: ['x'], limit: undefined });
      expect(out).not.toHaveProperty('limit');
    });
  });

  // -----------------------------------------------------------------------
  // Passthrough — canonical params are untouched
  // -----------------------------------------------------------------------

  describe('passthrough of canonical params', () => {
    it('passes through file_paths array unchanged', () => {
      const out = normalizeStepParams('read.context', { file_paths: ['a.ts', 'b.ts'], type: 'full' });
      expect(out.file_paths).toEqual(['a.ts', 'b.ts']);
      expect(out.type).toBe('full');
    });

    it('passes through queries array unchanged', () => {
      const out = normalizeStepParams('search.code', { queries: ['auth', 'login'] });
      expect(out.queries).toEqual(['auth', 'login']);
    });

    it('passes through cmd unchanged', () => {
      const out = normalizeStepParams('system.exec', { cmd: 'npm test' });
      expect(out.cmd).toBe('npm test');
    });

    it('coerces system.git files scalar to array', () => {
      const out = normalizeStepParams('system.git', {
        action: 'stage',
        files: 'atls-studio/src/hooks/useChatPersistence.ts',
      });
      expect(out.action).toBe('stage');
      expect(out.files).toEqual(['atls-studio/src/hooks/useChatPersistence.ts']);
    });

    it('coerces system.git file_paths alias string to files array', () => {
      const out = normalizeStepParams('system.git', {
        action: 'stage',
        file_paths: 'src/a.ts',
      });
      expect(out.files).toEqual(['src/a.ts']);
    });

    it('splits comma-separated system.git files into multiple paths', () => {
      const out = normalizeStepParams('system.git', {
        action: 'restore',
        files: '_test_atls/a.py,_test_atls/b.py',
      });
      expect(out.files).toEqual(['_test_atls/a.py', '_test_atls/b.py']);
    });

    it('splits comma-separated file_paths string into array', () => {
      const out = normalizeStepParams('change.delete', { file_paths: 'src/a.py,src/b.ts,src/c.rs' });
      expect(out.file_paths).toEqual(['src/a.py', 'src/b.ts', 'src/c.rs']);
    });

    it('trims whitespace around comma-separated file_paths entries', () => {
      const out = normalizeStepParams('change.delete', { file_paths: ' src/a.py , src/b.ts ' });
      expect(out.file_paths).toEqual(['src/a.py', 'src/b.ts']);
    });

    it('wraps single file_paths string without commas as single-element array', () => {
      const out = normalizeStepParams('change.delete', { file_paths: 'src/only.ts' });
      expect(out.file_paths).toEqual(['src/only.ts']);
    });

    it('rescues stray h param into hashes array', () => {
      const out = normalizeStepParams('session.recall', { h: 'deadbeef' });
      expect(out.hashes).toEqual(['h:deadbeef']);
      expect(out.h).toBeUndefined();
    });

    it('does not rescue h param when hashes already present', () => {
      const out = normalizeStepParams('session.recall', { hashes: ['h:aaa111'], h: 'bbb222' });
      expect(out.hashes).toEqual(['h:aaa111']);
    });

    it('passes through unknown params unchanged', () => {
      const out = normalizeStepParams('search.code', { queries: ['x'], custom_flag: true });
      expect(out.custom_flag).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Combined scenarios
  // -----------------------------------------------------------------------

  describe('combined normalization', () => {
    it('resolves alias + promotes scalar + strips prefix in one pass', () => {
      const out = normalizeStepParams('search.symbol', { name: 'fn(handleAuth)' });
      expect(out.symbol_names).toEqual(['handleAuth']);
      expect(out.name).toBeUndefined();
    });

    it('resolves file alias + promotes to array', () => {
      const out = normalizeStepParams('read.context', { path: 'src/app.ts', type: 'smart' });
      expect(out.file_paths).toEqual(['src/app.ts']);
      expect(out.path).toBeUndefined();
      expect(out.file_path).toBeUndefined();
    });

    it('handles Cursor-style edit params', () => {
      const out = normalizeStepParams('change.edit', {
        target_file: 'src/foo.ts',
        old_string: 'const x = 1;',
        new_string: 'const x = 2;',
      });
      expect(out.file_path).toBe('src/foo.ts');
      expect(out.old).toBe('const x = 1;');
      expect(out.new).toBe('const x = 2;');
    });

    it('handles Claude str_replace style params', () => {
      const out = normalizeStepParams('change.edit', {
        path: 'lib/util.py',
        old_str: 'def old():',
        new_str: 'def new():',
      });
      expect(out.file_path).toBe('lib/util.py');
      expect(out.old).toBe('def old():');
      expect(out.new).toBe('def new():');
    });

    it('handles analyze.blast_radius with from + symbol', () => {
      const out = normalizeStepParams('analyze.blast_radius', {
        from: 'src/auth.ts',
        symbol: 'cls(AuthService)',
      });
      expect(out.file_paths).toEqual(['src/auth.ts']);
      expect(out.symbol_names).toEqual(['AuthService']);
      expect(out.from).toBeUndefined();
      expect(out.symbol).toBeUndefined();
    });
  });

  describe('coerceFilePathsArray', () => {
    it('flattens nested arrays and ref/path objects', () => {
      expect(coerceFilePathsArray([['a.ts'], { ref: 'h:abc' }, { path: 'b.ts' }, { file: 'c.ts' }])).toEqual([
        'a.ts',
        'h:abc',
        'b.ts',
        'c.ts',
      ]);
    });

    it('dedupes exact normalized paths without collapsing case-distinct paths', () => {
      expect(coerceFilePathsArray(['Src/A.ts', 'src/a.ts', 'Src\\A.ts'])).toEqual(['Src/A.ts', 'src/a.ts']);
    });
  });

  describe('normalizeHashRefsToStrings', () => {
    it('accepts ref objects and nested arrays', () => {
      expect(normalizeHashRefsToStrings([{ ref: 'h:aa' }, ['h:bb', { h: 'cc' }]])).toEqual(['h:aa', 'h:bb', 'cc']);
    });
  });

  describe('expandCommaSeparatedFilePaths', () => {
    it('splits comma-joined entries and dedupes exact normalized paths', () => {
      expect(expandCommaSeparatedFilePaths(['a.py,b.py', 'c.ts', 'a.py', 'C.ts'])).toEqual(['a.py', 'b.py', 'c.ts', 'C.ts']);
    });
  });

  describe('session.plan subtasks coercion', () => {
    it('wraps scalar string subtasks (e.g. analyze:Exercise) as a one-element array', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'Try FileView',
        subtasks: 'analyze:Exercise',
      });
      expect(out.goal).toBe('Try FileView');
      expect(out.subtasks).toEqual(['analyze:Exercise']);
    });

    it('leaves array subtasks unchanged', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'g',
        subtasks: [{ id: 'a', title: 'A' }],
      });
      expect(out.subtasks).toEqual([{ id: 'a', title: 'A' }]);
    });

    it('comma-splits a scalar string of id:title pairs (matches q: parser semantics)', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'g',
        subtasks: 't1:Batch,t2:UHPP,t3:FileView',
      });
      expect(out.subtasks).toEqual(['t1:Batch', 't2:UHPP', 't3:FileView']);
    });

    it('splits newline- and semicolon-joined strings', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'g',
        subtasks: 't1:A\nt2:B;t3:C',
      });
      expect(out.subtasks).toEqual(['t1:A', 't2:B', 't3:C']);
    });

    it('expands object-of-strings map into id:title entries', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'g',
        subtasks: { t1: 'Batch', t2: 'UHPP' },
      });
      expect(out.subtasks).toEqual(['t1:Batch', 't2:UHPP']);
    });

    it('expands array elements that are object-of-strings maps', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'g',
        subtasks: [{ t1: 'Batch' }, { t2: 'UHPP' }],
      });
      expect(out.subtasks).toEqual(['t1:Batch', 't2:UHPP']);
    });

    it('preserves an array that mixes strings and {id,title} objects', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'g',
        subtasks: ['t1:A', { id: 't2', title: 'B' }],
      });
      expect(out.subtasks).toEqual(['t1:A', { id: 't2', title: 'B' }]);
    });

    it('drops malformed array elements (no id+title, no object-map) without throwing', () => {
      const out = normalizeStepParams('session.plan', {
        goal: 'g',
        subtasks: ['t1:A', 42, null, { id: 'x' }],
      });
      expect(out.subtasks).toEqual(['t1:A']);
    });

    it('accepts `tasks`, `plan`, `list`, `items` as aliases for `subtasks`', () => {
      expect(normalizeStepParams('session.plan', { goal: 'g', tasks: ['t1:A'] }).subtasks).toEqual(['t1:A']);
      expect(normalizeStepParams('session.plan', { goal: 'g', plan: ['t1:A'] }).subtasks).toEqual(['t1:A']);
      expect(normalizeStepParams('session.plan', { goal: 'g', list: ['t1:A'] }).subtasks).toEqual(['t1:A']);
      expect(normalizeStepParams('session.plan', { goal: 'g', items: ['t1:A'] }).subtasks).toEqual(['t1:A']);
    });
  });

  describe('normalizeHashRefsToStrings passes dataflow strings through for downstream rescue', () => {
    // The structured-JSON rescue for `hashes:"in:stepId.refs"` lives at the
    // batch-step layer (coerceBatchSteps) and the handler layer
    // (resolveRefsOrStepIds). normalizeStepParams just normalizes the string
    // into an array so the downstream token-level fallback can handle it.
    it('keeps `in:r1.refs` as a bare token in hashes array', () => {
      const out = normalizeStepParams('session.unpin', { hashes: 'in:r1.refs' });
      expect(out.hashes).toEqual(['in:r1.refs']);
      expect(out.in).toBeUndefined();
    });

    it('does not rewrite real hash strings', () => {
      const out = normalizeStepParams('session.unpin', { hashes: 'h:abc123' });
      expect(out.hashes).toEqual(['h:abc123']);
      expect(out.in).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Immutability
  // -----------------------------------------------------------------------

  describe('immutability', () => {
    it('does not mutate the input object', () => {
      const input = { file: 'src/a.ts', queries: ['x'] };
      const frozen = { ...input };
      normalizeStepParams('search.code', input);
      expect(input).toEqual(frozen);
    });
  });
});
