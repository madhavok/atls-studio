/**
 * Lists Vitest-instrumented source files with line coverage strictly below a threshold (default 100).
 * Respects path exclusions in coverage-gap-exclusions.json (same as list-coverage-gaps.ts).
 *
 * Usage (from atls-studio/):
 *   npx tsx scripts/list-coverage-below-pct.ts [--min 100] [--fail]
 *
 * --fail  Exit 1 if any non-excluded file is below the minimum line %.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type Exclusions = {
  ts?: { paths?: string[]; pathPrefixes?: string[]; notes?: string[] };
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const ATLS_APP = dirname(__dirname);
const repoRoot = process.env.ATLS_REPO_ROOT ?? dirname(ATLS_APP);

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function repoRel(absPath: string): string {
  return normPath(relative(repoRoot, absPath));
}

function normalizeForMatch(repoRelPath: string): string {
  return normPath(repoRelPath).toLowerCase();
}

function loadExclusions(): Exclusions {
  const exPath = join(ATLS_APP, "coverage-gap-exclusions.json");
  if (!existsSync(exPath)) return {};
  return JSON.parse(readFileSync(exPath, "utf8")) as Exclusions;
}

function tsExcluded(rel: string, ex: Exclusions): boolean {
  const n = normalizeForMatch(rel);
  for (const p of ex.ts?.paths ?? []) {
    if (normalizeForMatch(p) === n) return true;
  }
  for (const pre of ex.ts?.pathPrefixes ?? []) {
    if (n.startsWith(normalizeForMatch(pre))) return true;
  }
  return false;
}

type SummaryEntry = { lines?: { total: number; covered: number; pct: number } };

function main(): void {
  let minPct = 100;
  const fail = process.argv.includes("--fail");
  const minIdx = process.argv.indexOf("--min");
  if (minIdx >= 0 && process.argv[minIdx + 1]) {
    const v = Number(process.argv[minIdx + 1]);
    if (!Number.isNaN(v)) minPct = v;
  }

  const ex = loadExclusions();
  const vitestPath = join(ATLS_APP, "coverage", "coverage-summary.json");
  if (!existsSync(vitestPath)) {
    console.error(`Missing ${vitestPath}. Run: npm run test:coverage`);
    process.exit(1);
  }

  const summary = JSON.parse(readFileSync(vitestPath, "utf8")) as Record<string, SummaryEntry>;
  const below: { file: string; pct: number; total: number }[] = [];

  for (const [key, val] of Object.entries(summary)) {
    if (key === "total") continue;
    const rel = repoRel(key);
    if (!rel.startsWith("atls-studio/src/")) continue;
    if (tsExcluded(rel, ex)) continue;
    const lines = val.lines;
    if (!lines || lines.total <= 0) continue;
    if (lines.pct < minPct) {
      below.push({ file: rel, pct: lines.pct, total: lines.total });
    }
  }

  below.sort((a, b) => a.pct - b.pct || a.file.localeCompare(b.file));

  const outDir = join(ATLS_APP, "test-gap-reports");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "ts-below-100-lines.txt");
  const body = [
    `# TypeScript — line coverage < ${minPct}% (Vitest v8)`,
    "Generated from coverage/coverage-summary.json",
    `Files: ${below.length}`,
    "",
    ...below.map((r) => `${r.pct.toFixed(2).padStart(6)}%  (${r.total} lines)  ${r.file}`),
    "",
  ].join("\n");
  writeFileSync(outFile, body, "utf8");

  console.log(`Wrote ${outFile}`);
  console.log(`  Files below ${minPct}% lines: ${below.length}`);

  if (fail && below.length > 0) {
    console.error(`--fail: ${below.length} file(s) below ${minPct}% line coverage.`);
    process.exit(1);
  }
}

main();
