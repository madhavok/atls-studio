#!/usr/bin/env node
/**
 * Sync Pattern Severity from TypeScript Sources
 * 
 * Reads severity values from original TypeScript pattern definitions
 * and applies them to the JSON catalog files.
 * 
 * Usage: node atls-rs/scripts/sync-severity-from-ts.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const TS_PATTERNS_DIR = path.join(ROOT, 'src/indexer/patternRegistry');
const JSON_PATTERNS_DIRS = [
  path.join(ROOT, 'atls-rs/patterns'),
  path.join(ROOT, 'src/patterns/catalog'),
];

// Category normalization map (snake_case -> PascalCase)
const CATEGORY_MAP = {
  // snake_case -> PascalCase
  'security': 'Security',
  'performance': 'Performance',
  'correctness': 'Correctness',
  'maintainability': 'Maintainability',
  'style': 'Style',
  'design_smell': 'DesignSmell',
  'code_quality': 'Maintainability',
  'architecture': 'DesignSmell',
  'concurrency': 'Performance',
  'memory': 'Performance',
  'error_handling': 'Correctness',
  'test_quality': 'Maintainability',
  // Already correct
  'Security': 'Security',
  'Performance': 'Performance',
  'Correctness': 'Correctness',
  'Maintainability': 'Maintainability',
  'Style': 'Style',
  'DesignSmell': 'DesignSmell',
  'CodeQuality': 'Maintainability',
};

// Severity by category defaults (for patterns not found in TS)
const CATEGORY_SEVERITY_DEFAULTS = {
  'Security': 'high',
  'Performance': 'medium',
  'Correctness': 'high',
  'Maintainability': 'low',
  'Style': 'low',
  'DesignSmell': 'medium',
};

// Stats
const stats = {
  tsPatterns: 0,
  jsonPatterns: 0,
  matched: 0,
  unmatched: 0,
  updated: 0,
  byCategory: {},
};

/**
 * Extract pattern ID -> severity mappings from TypeScript files
 */
async function extractSeverityFromTS() {
  const severityMap = new Map();
  
  const files = await fs.readdir(TS_PATTERNS_DIR);
  const tsFiles = files.filter(f => f.endsWith('Patterns.ts'));
  
  console.log(`Found ${tsFiles.length} TypeScript pattern files\n`);
  
  for (const file of tsFiles) {
    const filePath = path.join(TS_PATTERNS_DIR, file);
    const content = await fs.readFile(filePath, 'utf-8');
    
    // Extract patterns using regex
    // Matches: id: 'PATTERN_ID', ... severity: 'high'|'medium'|'low',
    const patternRegex = /id:\s*['"]([^'"]+)['"][^}]*?severity:\s*['"]([^'"]+)['"]/gs;
    
    let match;
    let count = 0;
    while ((match = patternRegex.exec(content)) !== null) {
      const [, patternId, severity] = match;
      severityMap.set(patternId, severity.toLowerCase());
      count++;
      stats.tsPatterns++;
    }
    
    if (count > 0) {
      console.log(`  ${file}: ${count} patterns`);
    }
  }
  
  // Also check language-specific patterns
  const langDir = path.join(TS_PATTERNS_DIR, 'languages');
  try {
    const langFiles = await fs.readdir(langDir);
    const langTsFiles = langFiles.filter(f => f.endsWith('Patterns.ts'));
    
    for (const file of langTsFiles) {
      const filePath = path.join(langDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      
      const patternRegex = /id:\s*['"]([^'"]+)['"][^}]*?severity:\s*['"]([^'"]+)['"]/gs;
      
      let match;
      let count = 0;
      while ((match = patternRegex.exec(content)) !== null) {
        const [, patternId, severity] = match;
        severityMap.set(patternId, severity.toLowerCase());
        count++;
        stats.tsPatterns++;
      }
      
      if (count > 0) {
        console.log(`  languages/${file}: ${count} patterns`);
      }
    }
  } catch {
    // languages dir may not exist
  }
  
  return severityMap;
}

/**
 * Update JSON catalog files with correct severities
 */
async function updateJSONFiles(severityMap) {
  for (const JSON_PATTERNS_DIR of JSON_PATTERNS_DIRS) {
    console.log(`\nProcessing: ${JSON_PATTERNS_DIR}\n`);
    
    let files;
    try {
      files = await fs.readdir(JSON_PATTERNS_DIR);
    } catch {
      console.log(`  Directory not found, skipping`);
      continue;
    }
    
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    console.log(`  Found ${jsonFiles.length} JSON catalog files\n`);
    
    for (const file of jsonFiles) {
      const filePath = path.join(JSON_PATTERNS_DIR, file);
    const content = await fs.readFile(filePath, 'utf-8');
    let patterns;
    
    try {
      patterns = JSON.parse(content);
    } catch (e) {
      console.error(`  Error parsing ${file}: ${e.message}`);
      continue;
    }
    
    if (!Array.isArray(patterns)) {
      console.warn(`  ${file}: not an array, skipping`);
      continue;
    }
    
    let fileUpdated = 0;
    
    for (const pattern of patterns) {
      stats.jsonPatterns++;
      
      // Normalize category first
      const normalizedCategory = CATEGORY_MAP[pattern.category];
      if (normalizedCategory && normalizedCategory !== pattern.category) {
        pattern.category = normalizedCategory;
        fileUpdated++;
        stats.updated++;
      }
      
      // Try to find severity from TS
      const tsSeverity = severityMap.get(pattern.id);
      
      if (tsSeverity) {
        stats.matched++;
        if (pattern.severity !== tsSeverity) {
          pattern.severity = tsSeverity;
          fileUpdated++;
          stats.updated++;
        }
      } else {
        stats.unmatched++;
        // Use category default (using normalized category)
        const defaultSeverity = CATEGORY_SEVERITY_DEFAULTS[pattern.category] || 'medium';
        if (pattern.severity !== defaultSeverity) {
          pattern.severity = defaultSeverity;
          fileUpdated++;
          stats.updated++;
        }
      }
      
      // Track by category
      const cat = pattern.category || 'Unknown';
      if (!stats.byCategory[cat]) {
        stats.byCategory[cat] = { high: 0, medium: 0, low: 0 };
      }
      stats.byCategory[cat][pattern.severity]++;
    }
    
    // Write back if updated
    if (fileUpdated > 0) {
      await fs.writeFile(filePath, JSON.stringify(patterns, null, 2), 'utf-8');
      console.log(`    ${file}: updated ${fileUpdated} patterns`);
    } else {
      console.log(`    ${file}: no changes needed`);
    }
    }
  }
}

/**
 * Main
 */
async function main() {
  console.log('='.repeat(60));
  console.log('Sync Pattern Severity from TypeScript Sources');
  console.log('='.repeat(60));
  console.log(`TS Source: ${TS_PATTERNS_DIR}`);
  console.log(`JSON Targets:`);
  for (const dir of JSON_PATTERNS_DIRS) {
    console.log(`  - ${dir}`);
  }
  console.log('');
  
  // Step 1: Extract from TS
  console.log('Step 1: Extracting severity from TypeScript patterns...\n');
  const severityMap = await extractSeverityFromTS();
  console.log(`\nExtracted ${severityMap.size} pattern severities from TypeScript\n`);
  
  // Step 2: Update JSON files
  console.log('Step 2: Updating JSON catalog files...\n');
  await updateJSONFiles(severityMap);
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`TypeScript patterns found: ${stats.tsPatterns}`);
  console.log(`JSON patterns processed: ${stats.jsonPatterns}`);
  console.log(`Matched to TS: ${stats.matched}`);
  console.log(`Unmatched (used category default): ${stats.unmatched}`);
  console.log(`Total updated: ${stats.updated}`);
  
  console.log('\nSeverity distribution by category:');
  for (const [cat, counts] of Object.entries(stats.byCategory).sort()) {
    console.log(`  ${cat}: high=${counts.high}, medium=${counts.medium}, low=${counts.low}`);
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Done! JSON patterns now have correct severities.');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
