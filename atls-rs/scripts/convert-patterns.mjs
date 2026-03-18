#!/usr/bin/env node
/**
 * Pattern Conversion Script
 * 
 * Migrates all patterns from src/patterns/catalog/ to atls-rs/patterns/
 * Validates required fields and normalizes categories for Rust compatibility.
 * 
 * Usage: node atls-rs/scripts/convert-patterns.mjs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const SOURCE_DIR = path.join(ROOT, 'src/patterns/catalog');
const TARGET_DIR = path.join(ROOT, 'atls-rs/patterns');

// Category normalization map
// Maps various category names to Rust-compatible values
const CATEGORY_MAP = {
  // PascalCase variants
  'CodeQuality': 'Maintainability',
  'Correctness': 'Correctness',
  'Security': 'Security',
  'Performance': 'Performance',
  'Maintainability': 'Maintainability',
  'Style': 'Style',
  'DesignSmell': 'DesignSmell',
  
  // snake_case variants (from TypeScript detectors)
  'code_quality': 'Maintainability',
  'correctness': 'Correctness',
  'security': 'Security',
  'performance': 'Performance',
  'maintainability': 'Maintainability',
  'style': 'Style',
  'design_smell': 'DesignSmell',
  
  // Additional categories from TypeScript ATLS
  'architecture': 'DesignSmell',
  'concurrency': 'Performance',
  'error_handling': 'Correctness',
  'memory': 'Performance',
  'test_quality': 'Maintainability',
};

// Required fields for a valid pattern
const REQUIRED_FIELDS = ['id', 'languages', 'category', 'severity', 'title', 'description'];

// Stats tracking
const stats = {
  filesProcessed: 0,
  patternsTotal: 0,
  patternsValid: 0,
  patternsWithQuery: 0,
  patternsByLanguage: {},
  patternsByCategory: {},
  validationErrors: [],
  categoryMappings: {},
};

/**
 * Validate a single pattern
 */
function validatePattern(pattern, filename) {
  const errors = [];
  
  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (!pattern[field]) {
      errors.push(`Missing required field: ${field}`);
    }
  }
  
  // Validate languages is an array
  if (pattern.languages && !Array.isArray(pattern.languages)) {
    errors.push(`'languages' must be an array`);
  }
  
  // Validate severity
  const validSeverities = ['info', 'low', 'medium', 'high', 'critical'];
  if (pattern.severity && !validSeverities.includes(pattern.severity.toLowerCase())) {
    errors.push(`Invalid severity: ${pattern.severity}`);
  }
  
  // Validate tags is an array (if present)
  if (pattern.tags && !Array.isArray(pattern.tags)) {
    errors.push(`'tags' must be an array`);
  }
  
  // Validate sources is an array (if present)
  if (pattern.sources && !Array.isArray(pattern.sources)) {
    errors.push(`'sources' must be an array`);
  }
  
  return errors;
}

/**
 * Normalize a pattern for Rust compatibility
 */
function normalizePattern(pattern) {
  const normalized = { ...pattern };
  
  // Normalize category
  const originalCategory = pattern.category;
  const normalizedCategory = CATEGORY_MAP[originalCategory];
  
  if (normalizedCategory) {
    normalized.category = normalizedCategory;
    
    // Track category mappings
    if (originalCategory !== normalizedCategory) {
      stats.categoryMappings[originalCategory] = normalizedCategory;
    }
  } else {
    // Unknown category - default to Maintainability and log
    console.warn(`  Warning: Unknown category '${originalCategory}' for pattern ${pattern.id}, defaulting to 'Maintainability'`);
    normalized.category = 'Maintainability';
    stats.categoryMappings[originalCategory] = 'Maintainability (default)';
  }
  
  // Ensure tags is an array
  if (!normalized.tags) {
    normalized.tags = [];
  }
  
  // Ensure sources is an array
  if (!normalized.sources) {
    normalized.sources = [];
  }
  
  // Track stats
  stats.patternsByCategory[normalized.category] = (stats.patternsByCategory[normalized.category] || 0) + 1;
  
  for (const lang of normalized.languages || []) {
    stats.patternsByLanguage[lang] = (stats.patternsByLanguage[lang] || 0) + 1;
  }
  
  if (normalized.structuralHints?.treeSitterQuery) {
    stats.patternsWithQuery++;
  }
  
  return normalized;
}

/**
 * Process a single catalog file
 */
async function processFile(filename) {
  const sourcePath = path.join(SOURCE_DIR, filename);
  const targetPath = path.join(TARGET_DIR, filename);
  
  console.log(`Processing: ${filename}`);
  
  try {
    const content = await fs.readFile(sourcePath, 'utf-8');
    const patterns = JSON.parse(content);
    
    if (!Array.isArray(patterns)) {
      console.error(`  Error: ${filename} does not contain an array`);
      stats.validationErrors.push({ file: filename, error: 'Not an array' });
      return;
    }
    
    const validPatterns = [];
    
    for (const pattern of patterns) {
      stats.patternsTotal++;
      
      const errors = validatePattern(pattern, filename);
      
      if (errors.length > 0) {
        stats.validationErrors.push({
          file: filename,
          patternId: pattern.id || 'unknown',
          errors,
        });
        // Still include pattern but log warning
        console.warn(`  Warning: Pattern ${pattern.id || 'unknown'} has validation issues: ${errors.join(', ')}`);
      }
      
      const normalized = normalizePattern(pattern);
      validPatterns.push(normalized);
      stats.patternsValid++;
    }
    
    // Write to target
    await fs.writeFile(
      targetPath,
      JSON.stringify(validPatterns, null, 2),
      'utf-8'
    );
    
    console.log(`  Wrote ${validPatterns.length} patterns to ${filename}`);
    stats.filesProcessed++;
    
  } catch (error) {
    console.error(`  Error processing ${filename}:`, error.message);
    stats.validationErrors.push({ file: filename, error: error.message });
  }
}

/**
 * Main conversion function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('ATLS Pattern Conversion Script');
  console.log('='.repeat(60));
  console.log(`Source: ${SOURCE_DIR}`);
  console.log(`Target: ${TARGET_DIR}`);
  console.log('');
  
  // Check source directory exists
  try {
    await fs.access(SOURCE_DIR);
  } catch {
    console.error(`Error: Source directory not found: ${SOURCE_DIR}`);
    process.exit(1);
  }
  
  // Ensure target directory exists
  await fs.mkdir(TARGET_DIR, { recursive: true });
  
  // Get all JSON files
  const files = (await fs.readdir(SOURCE_DIR))
    .filter(f => f.endsWith('.json'))
    .sort();
  
  console.log(`Found ${files.length} catalog files to process\n`);
  
  // Process each file
  for (const file of files) {
    await processFile(file);
  }
  
  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('CONVERSION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Files processed: ${stats.filesProcessed}`);
  console.log(`Total patterns: ${stats.patternsTotal}`);
  console.log(`Valid patterns: ${stats.patternsValid}`);
  console.log(`Patterns with tree-sitter queries: ${stats.patternsWithQuery}`);
  
  console.log('\nPatterns by language:');
  const langEntries = Object.entries(stats.patternsByLanguage).sort((a, b) => b[1] - a[1]);
  for (const [lang, count] of langEntries) {
    console.log(`  ${lang}: ${count}`);
  }
  
  console.log('\nPatterns by category:');
  const catEntries = Object.entries(stats.patternsByCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of catEntries) {
    console.log(`  ${cat}: ${count}`);
  }
  
  if (Object.keys(stats.categoryMappings).length > 0) {
    console.log('\nCategory mappings applied:');
    for (const [from, to] of Object.entries(stats.categoryMappings)) {
      console.log(`  ${from} -> ${to}`);
    }
  }
  
  if (stats.validationErrors.length > 0) {
    console.log(`\nValidation warnings: ${stats.validationErrors.length}`);
    for (const err of stats.validationErrors.slice(0, 10)) {
      if (err.patternId) {
        console.log(`  ${err.file}/${err.patternId}: ${err.errors?.join(', ') || err.error}`);
      } else {
        console.log(`  ${err.file}: ${err.error}`);
      }
    }
    if (stats.validationErrors.length > 10) {
      console.log(`  ... and ${stats.validationErrors.length - 10} more`);
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Conversion complete!');
  console.log(`Patterns are now available at: ${TARGET_DIR}`);
  console.log('='.repeat(60));
}

// Run
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
