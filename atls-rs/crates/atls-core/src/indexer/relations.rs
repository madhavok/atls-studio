use std::sync::OnceLock;

use regex::Regex;

use crate::indexer::{CallInfo, ImportInfo};
use crate::file::Language;
use tree_sitter::{Node, Tree};

/// Tracks import and call relations
pub struct RelationTracker;

impl RelationTracker {
    /// Extract imports from AST
    pub fn extract_imports(
        tree: &Tree,
        source: &str,
        language: crate::types::Language,
    ) -> Vec<ImportInfo> {
        let mut imports = Vec::new();
        let root_node = tree.root_node();
        
        Self::walk_for_imports(&root_node, source, language, &mut imports);
        
        imports
    }

    /// Extract function/method calls from AST
    pub fn extract_calls(
        tree: &Tree,
        source: &str,
        language: crate::types::Language,
    ) -> Vec<CallInfo> {
        let mut calls = Vec::new();
        let root_node = tree.root_node();
        
        Self::walk_for_calls(&root_node, source, language, &mut calls, None);
        
        calls
    }

    /// Walk tree to find import statements.
    /// Only collects module-level imports — inner-scope `use` statements
    /// (inside fn/impl/block scopes) are skipped to avoid false positives
    /// during extraction-based refactoring.
    fn walk_for_imports(
        node: &Node,
        source: &str,
        language: crate::types::Language,
        imports: &mut Vec<ImportInfo>,
    ) {
        Self::walk_for_imports_inner(node, source, language, imports, false);
    }

    fn walk_for_imports_inner(
        node: &Node,
        source: &str,
        language: crate::types::Language,
        imports: &mut Vec<ImportInfo>,
        inside_body: bool,
    ) {
        let node_type = node.kind();

        if Self::is_import_node(node_type, language) {
            if !inside_body {
                if let Some(import_info) = Self::extract_import(node, source, language) {
                    imports.push(import_info);
                }
            }
            // Don't return — for languages with nested import structures
            // (Go: import_declaration > import_spec) we still need to
            // recurse into children.
        }

        // Track when we enter a function/method/closure body — any
        // import inside is scope-local and not a module-level import.
        let entering_body = matches!(
            node_type,
            "block" | "function_body" | "statement_block" | "compound_statement"
        ) && node.parent().map_or(false, |p| matches!(
            p.kind(),
            "function_item" | "function_definition" | "function_declaration"
            | "closure_expression" | "lambda" | "arrow_function"
            | "method_definition" | "method_declaration"
            | "impl_item"
        ));
        let in_body = inside_body || entering_body;

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            Self::walk_for_imports_inner(&child, source, language, imports, in_body);
        }
    }

    /// Walk tree to find function/method calls
    fn walk_for_calls(
        node: &Node,
        source: &str,
        language: crate::types::Language,
        calls: &mut Vec<CallInfo>,
        current_scope: Option<&str>,
    ) {
        let node_type = node.kind();
        
        // Check if this is a call expression
        if Self::is_call_node(node_type, language) {
            if let Some(call_info) = Self::extract_call(node, source, language, current_scope) {
                calls.push(call_info);
            }
        }

        // Check for JSX attribute references (e.g., onKeyDown={handleKeyDown})
        // These are function references passed as event handlers, not call_expression nodes
        if Self::is_jsx_ref_node(node_type, language) {
            if let Some(call_info) = Self::extract_jsx_ref(node, source, current_scope) {
                calls.push(call_info);
            }
        }
        
        // Update scope if we're entering a function/method
        let new_scope: Option<String> = if Self::is_scope_node(node_type, language) {
            Self::get_scope_name(node, source)
        } else {
            current_scope.map(|s| s.to_string())
        };
        
        // Recursively process children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            Self::walk_for_calls(&child, source, language, calls, new_scope.as_deref());
        }
    }

    /// Check if node is a JSX attribute that may reference a function (event handler)
    fn is_jsx_ref_node(node_type: &str, language: crate::types::Language) -> bool {
        matches!(
            language,
            Language::TypeScript | crate::types::Language::JavaScript
        ) && node_type == "jsx_attribute"
    }

    /// Extract a function reference from a JSX attribute like `onKeyDown={handleKeyDown}`.
    /// Returns a CallInfo for the referenced identifier so it appears in the call hierarchy.
    fn extract_jsx_ref(
        node: &Node,
        source: &str,
        scope: Option<&str>,
    ) -> Option<CallInfo> {
        let mut attr_name: Option<String> = None;
        let mut ref_name: Option<String> = None;

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                // The attribute name, e.g. "onKeyDown"
                "property_identifier" => {
                    attr_name = Self::get_node_text(&child, source);
                }
                // The value expression, e.g. {handleKeyDown} or {() => handleKeyDown()}
                "jsx_expression" => {
                    let mut expr_cursor = child.walk();
                    for expr_child in child.children(&mut expr_cursor) {
                        match expr_child.kind() {
                            // Direct identifier reference: onKeyDown={handleKeyDown}
                            "identifier" => {
                                ref_name = Self::get_node_text(&expr_child, source);
                            }
                            // Member expression: onKeyDown={this.handleKeyDown}
                            "member_expression" => {
                                let mut member_cursor = expr_child.walk();
                                for member_child in expr_child.children(&mut member_cursor) {
                                    if member_child.kind() == "property_identifier" {
                                        ref_name = Self::get_node_text(&member_child, source);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }

        // Only emit a reference if the attribute name looks like an event handler (on*)
        // or a known callback prop pattern (render*, handle*)
        let attr = attr_name?;
        let name = ref_name?;
        let attr_trimmed = attr.trim();
        if attr_trimmed.starts_with("on")
            || attr_trimmed.starts_with("handle")
            || attr_trimmed.starts_with("render")
        {
            Some(CallInfo {
                name: name.trim().to_string(),
                line: node.start_position().row as u32 + 1,
                scope_name: scope.map(String::from),
            })
        } else {
            None
        }
    }

    /// Check if node is an import statement
    fn is_import_node(node_type: &str, language: crate::types::Language) -> bool {
        match language {
            crate::types::Language::TypeScript | crate::types::Language::JavaScript => {
                node_type == "import_statement" || node_type == "import_declaration"
            }
            crate::types::Language::Python => {
                node_type == "import_statement" || node_type == "import_from_statement"
            }
            crate::types::Language::Rust => {
                node_type == "use_declaration" || node_type == "mod_item"
            }
            crate::types::Language::Java => {
                node_type == "import_declaration"
            }
            crate::types::Language::Go => {
                node_type == "import_declaration" || node_type == "import_spec"
            }
            crate::types::Language::C | crate::types::Language::Cpp => {
                node_type == "preproc_include"
            }
            crate::types::Language::CSharp => {
                node_type == "using_directive"
            }
            crate::types::Language::Swift => {
                node_type == "import_declaration"
            }
            crate::types::Language::Php => {
                node_type == "use_declaration" || node_type == "include_expression"
            }
            crate::types::Language::Ruby => {
                node_type == "call" // require/require_relative; filtered in extract_import
            }
            crate::types::Language::Scala => {
                node_type == "import_declaration"
            }
            crate::types::Language::Dart => {
                node_type == "library_import"
            }
            _ => false,
        }
    }

    /// Check if node is a call expression
    fn is_call_node(node_type: &str, language: crate::types::Language) -> bool {
        match language {
            crate::types::Language::TypeScript | crate::types::Language::JavaScript => {
                node_type == "call_expression"
            }
            crate::types::Language::Python => {
                node_type == "call"
            }
            crate::types::Language::Rust => {
                node_type == "call_expression"
            }
            crate::types::Language::Java => {
                node_type == "method_invocation"
            }
            crate::types::Language::Go => {
                node_type == "call_expression"
            }
            crate::types::Language::C | crate::types::Language::Cpp => {
                node_type == "call_expression"
            }
            crate::types::Language::CSharp => {
                node_type == "invocation_expression"
            }
            crate::types::Language::Swift => {
                node_type == "call_expression"
            }
            crate::types::Language::Php => {
                node_type == "call_expression" || node_type == "function_call_expression"
            }
            crate::types::Language::Ruby => {
                node_type == "call"
            }
            crate::types::Language::Scala => {
                node_type == "call_expression"
            }
            crate::types::Language::Dart => {
                node_type == "invocation_expression"
                    || node_type == "function_invocation"
                    || node_type == "invocation"
            }
            _ => false,
        }
    }

    /// Check if node defines a scope (function, method, class)
    fn is_scope_node(node_type: &str, language: crate::types::Language) -> bool {
        match language {
            crate::types::Language::TypeScript | crate::types::Language::JavaScript => {
                node_type == "function_declaration" || node_type == "method_definition"
            }
            crate::types::Language::Python => {
                node_type == "function_definition"
            }
            crate::types::Language::Rust => {
                node_type == "function_item" || node_type == "impl_item"
            }
            crate::types::Language::Java => {
                node_type == "method_declaration"
            }
            crate::types::Language::Go => {
                node_type == "function_declaration" || node_type == "method_declaration"
            }
            crate::types::Language::C | crate::types::Language::Cpp => {
                node_type == "function_definition"
            }
            crate::types::Language::CSharp => {
                node_type == "method_declaration"
            }
            crate::types::Language::Swift => {
                node_type == "function_declaration"
                    || node_type == "class_declaration"
                    || node_type == "struct_declaration"
                    || node_type == "protocol_declaration"
            }
            crate::types::Language::Php => {
                node_type == "function_definition" || node_type == "class_declaration"
            }
            crate::types::Language::Ruby => {
                node_type == "method" || node_type == "class" || node_type == "module"
            }
            crate::types::Language::Scala => {
                node_type == "function_definition"
                    || node_type == "class_definition"
                    || node_type == "object_definition"
            }
            crate::types::Language::Dart => {
                node_type == "class_definition"
                    || node_type == "function_signature"
                    || node_type == "method_signature"
                    || node_type == "function_body"
            }
            _ => false,
        }
    }

    /// Extract import information from node
    fn extract_import(
        node: &Node,
        source: &str,
        language: crate::types::Language,
    ) -> Option<ImportInfo> {
        match language {
            crate::types::Language::TypeScript | crate::types::Language::JavaScript => {
                Self::extract_import_js(node, source)
            }
            crate::types::Language::Python => {
                Self::extract_import_python(node, source)
            }
            crate::types::Language::Rust => {
                if node.kind() == "mod_item" {
                    Self::extract_mod_rust(node, source)
                } else {
                    Self::extract_import_rust(node, source)
                }
            }
            crate::types::Language::Java => {
                Self::extract_import_java(node, source)
            }
            crate::types::Language::Go => {
                Self::extract_import_go(node, source)
            }
            crate::types::Language::C | crate::types::Language::Cpp => {
                Self::extract_import_c(node, source)
            }
            crate::types::Language::CSharp => {
                Self::extract_import_csharp(node, source)
            }
            crate::types::Language::Swift => {
                Self::extract_import_swift(node, source)
            }
            crate::types::Language::Php => {
                Self::extract_import_php(node, source)
            }
            crate::types::Language::Ruby => {
                Self::extract_import_ruby(node, source)
            }
            crate::types::Language::Scala => {
                Self::extract_import_scala(node, source)
            }
            crate::types::Language::Dart => {
                Self::extract_import_dart(node, source)
            }
            _ => {
                // Fallback: use the full node text as module name
                Self::get_node_text(node, source).map(|text| ImportInfo {
                    module: text.trim().to_string(),
                    symbols: Vec::new(),
                    is_default: false,
                    is_pub: false,
                    is_system: false,
                })
            }
        }
    }

    /// JS/TS: import { a, b } from 'module'; import X from './x';
    fn extract_import_js(node: &Node, source: &str) -> Option<ImportInfo> {
        let mut cursor = node.walk();
        let mut module = None;
        let mut symbols = Vec::new();
        let mut is_default = false;

        for child in node.children(&mut cursor) {
            match child.kind() {
                "string" | "string_fragment" => {
                    if module.is_none() {
                        module = Self::get_node_text(&child, source)
                            .map(|s| s.trim_matches('"').trim_matches('\'').to_string());
                    }
                }
                "import_specifier" | "named_imports" => {
                    let mut spec_cursor = child.walk();
                    for spec_child in child.children(&mut spec_cursor) {
                        if spec_child.kind() == "identifier" || spec_child.kind() == "import_specifier" {
                            if let Some(name) = Self::get_node_text(&spec_child, source) {
                                symbols.push(name.trim().to_string());
                            }
                        }
                    }
                }
                "identifier" => {
                    if let Some(name) = Self::get_node_text(&child, source) {
                        is_default = true;
                        symbols.push(name.trim().to_string());
                    }
                }
                _ => {}
            }
        }

        module.map(|m| ImportInfo { module: m, symbols, is_default, is_pub: false, is_system: false })
    }

    /// Python: `import X` / `from X.Y import a, b` / `from . import x` / `from ..pkg import z`
    fn extract_import_python(node: &Node, source: &str) -> Option<ImportInfo> {
        let mut cursor = node.walk();
        let mut prefix: Option<String> = None; // relative dot prefix
        let mut dotted_module: Option<String> = None;
        let mut symbols = Vec::new();
        let mut found_module = false;

        for child in node.children(&mut cursor) {
            match child.kind() {
                "import_prefix" => {
                    // Relative import dots (`.`, `..`, `...`)
                    prefix = Self::get_node_text(&child, source).map(|s| s.trim().to_string());
                }
                "dotted_name" => {
                    if !found_module {
                        dotted_module = Self::get_node_text(&child, source);
                        found_module = true;
                    } else {
                        // After the module, dotted_name children are imported names
                        if let Some(name) = Self::get_node_text(&child, source) {
                            symbols.push(name.trim().to_string());
                        }
                    }
                }
                "aliased_import" | "identifier" => {
                    // `from . import x` -- `x` appears as direct child
                    if found_module || prefix.is_some() {
                        if let Some(name) = Self::get_node_text(&child, source) {
                            let name = name.trim().to_string();
                            if name != "import" && name != "from" {
                                symbols.push(name);
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        // Build the final module string
        let module = match (prefix, dotted_module) {
            (Some(dots), Some(name)) => {
                // `from ..pkg import x` -> `..pkg`
                format!("{}{}", dots, name)
            }
            (Some(dots), None) => {
                // `from . import x` -> `.`
                dots
            }
            (None, Some(name)) => name,
            (None, None) => return None,
        };

        Some(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false })
    }

    /// Rust: `use std::path::Path;` / `use crate::types::{A, B};` / `pub use crate::re_export::*;`
    fn extract_import_rust(node: &Node, source: &str) -> Option<ImportInfo> {
        let full_text = Self::get_node_text(node, source)?;
        let mut text = full_text.trim();

        // Detect and strip visibility modifiers: `pub`, `pub(crate)`, `pub(super)`, etc.
        let is_pub = text.starts_with("pub ");
        if is_pub {
            text = text.strip_prefix("pub").unwrap_or(text).trim();
            // Strip optional visibility restriction like `(crate)` or `(super)`
            if text.starts_with('(') {
                if let Some(paren_end) = text.find(')') {
                    text = text[paren_end + 1..].trim();
                }
            }
        }

        let trimmed = text
            .trim_start_matches("use")
            .trim()
            .trim_end_matches(';')
            .trim();

        // Parse brace groups: `crate::types::{A, B}` -> module=`crate::types`, symbols=[A, B]
        let mut symbols = Vec::new();
        let module = if let Some(brace_start) = trimmed.find('{') {
            let prefix = trimmed[..brace_start].trim_end_matches("::").trim().to_string();
            if let Some(brace_end) = trimmed.find('}') {
                let inner = &trimmed[brace_start + 1..brace_end];
                for sym in inner.split(',') {
                    let sym = sym.trim();
                    if !sym.is_empty() {
                        // Handle `Name as Alias` -- use the original name
                        let name = sym.split_whitespace().next().unwrap_or(sym);
                        symbols.push(name.to_string());
                    }
                }
            }
            prefix
        } else {
            trimmed.to_string()
        };

        Some(ImportInfo { module, symbols, is_default: false, is_pub, is_system: false })
    }

    /// Rust mod declarations: `mod foo;` or `pub mod foo;`
    /// Treated as imports so that `foo.rs` / `foo/mod.rs` appears in the dependency graph.
    /// Uses `self::` prefix so the resolver looks relative to the declaring file's directory.
    fn extract_mod_rust(node: &Node, source: &str) -> Option<ImportInfo> {
        let full_text = Self::get_node_text(node, source)?;
        let text = full_text.trim();

        // Inline modules (`mod foo { ... }`) don't map to separate files
        if text.contains('{') {
            return None;
        }

        let is_pub = text.starts_with("pub ");
        let mut stripped: &str = text;
        if stripped.starts_with("pub") {
            stripped = stripped.strip_prefix("pub").unwrap_or(stripped).trim();
            if stripped.starts_with('(') {
                if let Some(end) = stripped.find(')') {
                    stripped = stripped[end + 1..].trim();
                }
            }
        }
        stripped = stripped
            .trim_start_matches("mod")
            .trim()
            .trim_end_matches(';')
            .trim();

        if stripped.is_empty() {
            return None;
        }

        // `self::foo` makes the resolver look in the declaring file's directory
        let module = format!("self::{}", stripped);
        Some(ImportInfo {
            module,
            symbols: vec![stripped.to_string()],
            is_default: false,
            is_pub,
            is_system: false,
        })
    }

    /// Java: import java.util.List;  /  import static org.junit.Assert.*;
    fn extract_import_java(node: &Node, source: &str) -> Option<ImportInfo> {
        let full_text = Self::get_node_text(node, source)?;
        let trimmed = full_text
            .trim()
            .trim_start_matches("import")
            .trim()
            .trim_start_matches("static")
            .trim()
            .trim_end_matches(';')
            .trim();

        // Extract the simple class name as a symbol
        let mut symbols = Vec::new();
        if let Some(last) = trimmed.rsplit('.').next() {
            if last != "*" {
                symbols.push(last.to_string());
            }
        }

        Some(ImportInfo { module: trimmed.to_string(), symbols, is_default: false, is_pub: false, is_system: false })
    }

    /// Go: import "fmt"  /  import ( "fmt"\n "os" )
    /// Node kind is import_spec for each individual import line.
    fn extract_import_go(node: &Node, source: &str) -> Option<ImportInfo> {
        // import_spec children: optional identifier (alias), interpreted_string_literal (path)
        let mut cursor = node.walk();
        let mut module = None;

        for child in node.children(&mut cursor) {
            if child.kind() == "interpreted_string_literal" {
                module = Self::get_node_text(&child, source)
                    .map(|s| s.trim_matches('"').to_string());
            }
        }

        // Fallback for import_declaration with a single string child (no parens)
        if module.is_none() {
            let full_text = Self::get_node_text(node, source)?;
            let trimmed = full_text
                .trim()
                .trim_start_matches("import")
                .trim()
                .trim_matches('"');
            if !trimmed.is_empty() && !trimmed.starts_with('(') {
                module = Some(trimmed.to_string());
            }
        }

        module.map(|m| ImportInfo { module: m, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false })
    }

    /// C/C++: #include <stdio.h>  /  #include "mylib.h"
    fn extract_import_c(node: &Node, source: &str) -> Option<ImportInfo> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "system_lib_string" => {
                    // #include <stdio.h> → system header
                    let text = Self::get_node_text(&child, source)?;
                    let module = text.trim_start_matches('<').trim_end_matches('>').to_string();
                    return Some(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: true });
                }
                "string_literal" => {
                    // #include "mylib.h" → local header
                    let text = Self::get_node_text(&child, source)?;
                    let module = text.trim_matches('"').to_string();
                    return Some(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
                }
                _ => {}
            }
        }
        // Fallback: parse the full text
        let full_text = Self::get_node_text(node, source)?;
        let trimmed = full_text.trim().trim_start_matches("#include").trim();
        let is_system = trimmed.starts_with('<');
        let module = trimmed
            .trim_matches('"')
            .trim_start_matches('<')
            .trim_end_matches('>')
            .trim()
            .to_string();
        if module.is_empty() { return None; }
        Some(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system })
    }

    /// C#: using System;  /  using System.Collections.Generic;
    fn extract_import_csharp(node: &Node, source: &str) -> Option<ImportInfo> {
        // using_directive typically has a qualified_name or identifier child
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "qualified_name" || child.kind() == "identifier" {
                let module = Self::get_node_text(&child, source)?.trim().to_string();
                return Some(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
            }
        }
        // Fallback: parse full text
        let full_text = Self::get_node_text(node, source)?;
        let module = full_text
            .trim()
            .trim_start_matches("using")
            .trim()
            .trim_end_matches(';')
            .trim()
            .to_string();
        if module.is_empty() { return None; }
        Some(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false })
    }

    /// Swift: import Foundation  /  import class Module.ClassName
    fn extract_import_swift(node: &Node, source: &str) -> Option<ImportInfo> {
        let full_text = Self::get_node_text(node, source)?;
        let trimmed = full_text
            .trim()
            .trim_start_matches("import")
            .trim();
        if trimmed.is_empty() { return None; }
        let module = trimmed.to_string();
        Some(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false })
    }

    /// PHP: use App\Models\User;  /  include 'file.php';
    fn extract_import_php(node: &Node, source: &str) -> Option<ImportInfo> {
        let full_text = Self::get_node_text(node, source)?;
        let trimmed = full_text.trim();
        let (module, symbols) = if trimmed.starts_with("use ") {
            let inner = trimmed
                .trim_start_matches("use")
                .trim_end_matches(';')
                .trim();
            if let Some(brace_start) = inner.find('{') {
                let prefix = inner[..brace_start].trim_end_matches('\\').trim().to_string();
                let mut syms = Vec::new();
                if let Some(brace_end) = inner.find('}') {
                    for s in inner[brace_start + 1..brace_end].split(',') {
                        let s = s.trim().split(" as ").next().unwrap_or(s).trim();
                        if !s.is_empty() { syms.push(s.to_string()); }
                    }
                }
                (prefix, syms)
            } else if let Some(last) = inner.rsplit('\\').next() {
                (inner.to_string(), vec![last.to_string()])
            } else {
                (inner.to_string(), Vec::new())
            }
        } else if trimmed.starts_with("include") || trimmed.starts_with("require") {
            let inner = trimmed
                .trim_start_matches("include_once")
                .trim_start_matches("include")
                .trim_start_matches("require_once")
                .trim_start_matches("require")
                .trim()
                .trim_matches(|c| c == '\'' || c == '"' || c == '(' || c == ')')
                .trim();
            (inner.to_string(), Vec::new())
        } else {
            return None;
        };
        Some(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false })
    }

    /// Ruby: require 'json'  /  require_relative 'helper'
    fn extract_import_ruby(node: &Node, source: &str) -> Option<ImportInfo> {
        if node.kind() != "call" { return None; }
        let full_text = Self::get_node_text(node, source)?;
        let trimmed = full_text.trim();
        let arg = if trimmed.starts_with("require_relative ") {
            trimmed.trim_start_matches("require_relative").trim()
        } else if trimmed.starts_with("require ") {
            trimmed.trim_start_matches("require").trim()
        } else {
            return None;
        };
        let module = arg.trim_matches('\'').trim_matches('"').to_string();
        if module.is_empty() { return None; }
        let last = module.rsplit(|c| c == '/' || c == '.').next().unwrap_or(&module);
        let symbols = vec![last.to_string()];
        Some(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false })
    }

    /// Scala: import foo.bar._  /  import foo.bar.{A, B}
    fn extract_import_scala(node: &Node, source: &str) -> Option<ImportInfo> {
        let full_text = Self::get_node_text(node, source)?;
        let trimmed = full_text
            .trim()
            .trim_start_matches("import")
            .trim()
            .trim_end_matches(';')
            .trim();
        if trimmed.is_empty() { return None; }
        let mut symbols = Vec::new();
        let module = if let Some(brace_start) = trimmed.find('{') {
            let prefix = trimmed[..brace_start].trim_end_matches(".").trim().to_string();
            if let Some(brace_end) = trimmed.find('}') {
                for s in trimmed[brace_start + 1..brace_end].split(',') {
                    let s = s.trim();
                    if s != "_" && !s.is_empty() { symbols.push(s.to_string()); }
                }
            }
            prefix
        } else {
            trimmed.to_string()
        };
        Some(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false })
    }

    /// Dart: import 'package:flutter/material.dart';  /  import 'dart:io' show stdin;
    fn extract_import_dart(node: &Node, source: &str) -> Option<ImportInfo> {
        let full_text = Self::get_node_text(node, source)?;
        let trimmed = full_text.trim();
        let uri = if let Some(q) = trimmed.find('\'') {
            let end = trimmed[q + 1..].find('\'').map(|i| q + 1 + i).unwrap_or(trimmed.len());
            trimmed[q + 1..end].to_string()
        } else if let Some(q) = trimmed.find('"') {
            let end = trimmed[q + 1..].find('"').map(|i| q + 1 + i).unwrap_or(trimmed.len());
            trimmed[q + 1..end].to_string()
        } else {
            return None;
        };
        let module = uri
            .strip_suffix(".dart")
            .unwrap_or(&uri)
            .rsplit(|c| c == '/' || c == ':')
            .next()
            .unwrap_or(&uri)
            .to_string();
        let mut symbols = Vec::new();
        if let Some(show_pos) = trimmed.find("show ") {
            for s in trimmed[show_pos + 5..].split(',') {
                let s = s.trim().trim_end_matches(';').trim();
                if !s.is_empty() { symbols.push(s.to_string()); }
            }
        }
        Some(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false })
    }

    /// Extract call information from node
    fn extract_call(
        node: &Node,
        source: &str,
        _language: crate::types::Language,
        scope: Option<&str>,
    ) -> Option<CallInfo> {
        let mut cursor = node.walk();
        let mut name = None;
        
        for child in node.children(&mut cursor) {
            match child.kind() {
                "identifier" | "property_identifier" => {
                    if name.is_none() {
                        name = Self::get_node_text(&child, source);
                    }
                }
                "member_expression" | "field_expression" | "member_access_expression" => {
                    // Extract the last identifier (the method name) from a member/access chain
                    let mut member_cursor = child.walk();
                    let mut last_name = None;
                    for member_child in child.children(&mut member_cursor) {
                        if member_child.kind() == "property_identifier"
                            || member_child.kind() == "identifier"
                            || member_child.kind() == "field_identifier"
                        {
                            last_name = Self::get_node_text(&member_child, source);
                        }
                    }
                    if last_name.is_some() {
                        name = last_name;
                    }
                }
                _ => {}
            }
        }
        
        name.map(|n| CallInfo {
            name: n.trim().to_string(),
            line: node.start_position().row as u32 + 1,
            scope_name: scope.map(String::from),
        })
    }

    /// Get scope name from node
    fn get_scope_name(node: &Node, source: &str) -> Option<String> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "identifier" || child.kind() == "property_identifier" {
                return Self::get_node_text(&child, source);
            }
        }
        None
    }

    /// Get text content of a node
    fn get_node_text(node: &Node, source: &str) -> Option<String> {
        let start_byte = node.start_byte();
        let end_byte = node.end_byte();
        source.get(start_byte..end_byte).map(String::from)
    }
}

// ---------------------------------------------------------------------------
// Regex-based import extraction (tree-sitter-free)
// ---------------------------------------------------------------------------

/// Extract function/method calls via regex when tree-sitter is unavailable
/// (e.g. Kotlin) or as a supplement. Produces CallInfo for the calls table.
pub fn extract_calls_regex(content: &str, language: Language) -> Vec<CallInfo> {
    match language {
        Language::Kotlin => extract_calls_kotlin_regex(content),
        _ => Vec::new(),
    }
}

fn extract_calls_kotlin_regex(content: &str) -> Vec<CallInfo> {
    let mut calls = Vec::new();
    // Match: ident( or ident { (lambda) or obj.ident( or obj.ident {
    let re = match Regex::new(
        r"(?m)(?:^|[^\w.])(\w+)\s*(?:\(|\{)|(?:^|[^\w])(\w+)\.(\w+)\s*(?:\(|\{)",
    ) {
        Ok(r) => r,
        Err(_) => return calls,
    };
    for (line_idx, line) in content.lines().enumerate() {
        for caps in re.captures_iter(line) {
            let name = if let Some(m) = caps.get(3) {
                m.as_str().to_string()
            } else if let Some(m) = caps.get(1) {
                m.as_str().to_string()
            } else {
                continue;
            };
            if matches!(
                name.as_str(),
                "if" | "else" | "when" | "for" | "while" | "try" | "catch" | "fun" | "class"
                    | "object" | "interface" | "enum" | "return" | "throw" | "super" | "this"
            ) {
                continue;
            }
            calls.push(CallInfo {
                name,
                line: (line_idx + 1) as u32,
                scope_name: None,
            });
        }
    }
    calls
}

/// Extract imports from source content using regex patterns.
/// Replaces `RelationTracker::extract_imports` (tree-sitter based) and
/// `fallback_extractor::extract_imports_fallback`.
pub fn extract_imports_regex(content: &str, language: Language) -> Vec<ImportInfo> {
    match language {
        Language::Rust => extract_imports_rust_regex(content),
        Language::TypeScript | Language::JavaScript => extract_imports_js_regex(content),
        Language::Python => extract_imports_python_regex(content),
        Language::Go => extract_imports_go_regex(content),
        Language::Java => extract_imports_java_regex(content),
        Language::CSharp => extract_imports_csharp_regex(content),
        Language::C | Language::Cpp => extract_imports_c_regex(content),
        Language::Swift => extract_imports_swift_regex(content),
        Language::Php => extract_imports_php_regex(content),
        Language::Ruby => extract_imports_ruby_regex(content),
        Language::Kotlin => extract_imports_kotlin_regex(content),
        Language::Scala => extract_imports_scala_regex(content),
        Language::Dart => extract_imports_dart_regex(content),
        Language::Unknown => Vec::new(),
    }
}

fn extract_imports_rust_regex(content: &str) -> Vec<ImportInfo> {
    static USE_RE: OnceLock<Regex> = OnceLock::new();
    let use_re = USE_RE.get_or_init(|| {
        Regex::new(r"(?m)^(\s*(?:pub(?:\([^)]*\))?\s+)?use\s+.+?;)").unwrap()
    });
    static MOD_RE: OnceLock<Regex> = OnceLock::new();
    let mod_re = MOD_RE.get_or_init(|| {
        Regex::new(r"(?m)^(\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;)").unwrap()
    });

    let mut imports = Vec::new();

    for caps in use_re.captures_iter(content) {
        let full = caps.get(1).unwrap().as_str().trim();
        let is_pub = full.starts_with("pub");
        let mut text = full;
        if text.starts_with("pub") {
            text = text.strip_prefix("pub").unwrap_or(text).trim();
            if text.starts_with('(') {
                if let Some(end) = text.find(')') {
                    text = text[end + 1..].trim();
                }
            }
        }
        let trimmed = text
            .trim_start_matches("use").trim()
            .trim_end_matches(';').trim();

        let mut symbols = Vec::new();
        let module = if let Some(brace_start) = trimmed.find('{') {
            let prefix = trimmed[..brace_start].trim_end_matches("::").trim().to_string();
            if let Some(brace_end) = trimmed.find('}') {
                for sym in trimmed[brace_start + 1..brace_end].split(',') {
                    let sym = sym.trim();
                    if !sym.is_empty() {
                        let name = sym.split_whitespace().next().unwrap_or(sym);
                        symbols.push(name.to_string());
                    }
                }
            }
            prefix
        } else {
            trimmed.to_string()
        };

        imports.push(ImportInfo { module, symbols, is_default: false, is_pub, is_system: false });
    }

    for caps in mod_re.captures_iter(content) {
        let full_line = caps.get(1).unwrap().as_str().trim();
        if full_line.contains('{') { continue; }
        let name = caps.get(2).unwrap().as_str();
        let is_pub = full_line.starts_with("pub");
        imports.push(ImportInfo {
            module: format!("self::{}", name),
            symbols: vec![name.to_string()],
            is_default: false,
            is_pub,
            is_system: false,
        });
    }

    imports
}

fn extract_imports_js_regex(content: &str) -> Vec<ImportInfo> {
    static IMPORT_RE: OnceLock<Regex> = OnceLock::new();
    let import_re = IMPORT_RE.get_or_init(|| {
        Regex::new(r#"(?m)^[ \t]*import\s+(?:(?:\{([^}]*)\}|(\w+))\s+from\s+)?['"]([^'"]+)['"]"#).unwrap()
    });
    static REQUIRE_RE: OnceLock<Regex> = OnceLock::new();
    let require_re = REQUIRE_RE.get_or_init(|| {
        Regex::new(r#"(?m)(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)"#).unwrap()
    });

    let mut imports = Vec::new();

    for caps in import_re.captures_iter(content) {
        let module = caps.get(3).unwrap().as_str().to_string();
        let mut symbols = Vec::new();
        let mut is_default = false;
        if let Some(named) = caps.get(1) {
            for sym in named.as_str().split(',') {
                let sym = sym.trim().split(" as ").next().unwrap_or("").trim();
                if !sym.is_empty() { symbols.push(sym.to_string()); }
            }
        }
        if let Some(default) = caps.get(2) {
            symbols.push(default.as_str().to_string());
            is_default = true;
        }
        imports.push(ImportInfo { module, symbols, is_default, is_pub: false, is_system: false });
    }

    for caps in require_re.captures_iter(content) {
        let module = caps.get(3).unwrap().as_str().to_string();
        let mut symbols = Vec::new();
        let mut is_default = false;
        if let Some(named) = caps.get(1) {
            for sym in named.as_str().split(',') {
                let sym = sym.trim();
                if !sym.is_empty() { symbols.push(sym.to_string()); }
            }
        }
        if let Some(default) = caps.get(2) {
            symbols.push(default.as_str().to_string());
            is_default = true;
        }
        imports.push(ImportInfo { module, symbols, is_default, is_pub: false, is_system: false });
    }

    imports
}

fn extract_imports_python_regex(content: &str) -> Vec<ImportInfo> {
    static FROM_RE: OnceLock<Regex> = OnceLock::new();
    let from_re = FROM_RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*from\s+(\.{0,3}\S*)\s+import\s+(.+)").unwrap()
    });
    static IMPORT_RE: OnceLock<Regex> = OnceLock::new();
    let import_re = IMPORT_RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*import\s+(\S+)").unwrap()
    });

    let mut imports = Vec::new();

    for caps in from_re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().to_string();
        let syms_str = caps.get(2).unwrap().as_str();
        let symbols: Vec<String> = syms_str.split(',')
            .map(|s| s.trim().split(" as ").next().unwrap_or("").trim().to_string())
            .filter(|s| !s.is_empty() && s != "(")
            .collect();
        imports.push(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false });
    }

    for caps in import_re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().to_string();
        if module.starts_with('(') { continue; }
        imports.push(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
    }

    imports
}

fn extract_imports_go_regex(content: &str) -> Vec<ImportInfo> {
    static SINGLE_RE: OnceLock<Regex> = OnceLock::new();
    let single_re = SINGLE_RE.get_or_init(|| {
        Regex::new(r#"(?m)^[ \t]*import\s+"([^"]+)""#).expect("Go single import regex")
    });
    static BLOCK_RE: OnceLock<Regex> = OnceLock::new();
    let block_re = BLOCK_RE.get_or_init(|| {
        Regex::new(r#"(?ms)import\s*\((.*?)\)"#).expect("Go block import regex")
    });
    static SPEC_RE: OnceLock<Regex> = OnceLock::new();
    let spec_re = SPEC_RE.get_or_init(|| {
        Regex::new(r#""([^"]+)""#).expect("Go import spec regex")
    });

    let mut imports = Vec::new();

    for caps in single_re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().to_string();
        imports.push(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
    }

    for caps in block_re.captures_iter(content) {
        let block = caps.get(1).unwrap().as_str();
        for spec_caps in spec_re.captures_iter(block) {
            let module = spec_caps.get(1).unwrap().as_str().to_string();
            imports.push(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
        }
    }

    imports
}

fn extract_imports_java_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*import\s+(?:static\s+)?(.+?)\s*;").unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().trim().to_string();
        let mut symbols = Vec::new();
        if let Some(last) = module.rsplit('.').next() {
            if last != "*" { symbols.push(last.to_string()); }
        }
        imports.push(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false });
    }
    imports
}

fn extract_imports_csharp_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*using\s+(?:static\s+)?(.+?)\s*;").unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().trim().to_string();
        if module.contains('=') { continue; }
        imports.push(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
    }
    imports
}

fn extract_imports_c_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?m)^[ \t]*#\s*include\s+([<"])([^>"]+)[>"]"#).unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let bracket = caps.get(1).unwrap().as_str();
        let module = caps.get(2).unwrap().as_str().to_string();
        let is_system = bracket == "<";
        imports.push(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system });
    }
    imports
}

fn extract_imports_swift_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*import\s+(?:class\s+|struct\s+|enum\s+|protocol\s+|func\s+)?(\S+)").unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().to_string();
        imports.push(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
    }
    imports
}

fn extract_imports_php_regex(content: &str) -> Vec<ImportInfo> {
    static USE_RE: OnceLock<Regex> = OnceLock::new();
    let use_re = USE_RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*use\s+(.+?)\s*;").unwrap()
    });
    static INCLUDE_RE: OnceLock<Regex> = OnceLock::new();
    let include_re = INCLUDE_RE.get_or_init(|| {
        Regex::new(r#"(?m)(?:include|require|include_once|require_once)\s*(?:\(\s*)?['"]([^'"]+)['"]\s*\)?\s*;"#).unwrap()
    });

    let mut imports = Vec::new();

    for caps in use_re.captures_iter(content) {
        let inner = caps.get(1).unwrap().as_str().trim();
        let module = inner.split(" as ").next().unwrap_or(inner).trim().to_string();
        let mut symbols = Vec::new();
        if let Some(last) = module.rsplit('\\').next() {
            symbols.push(last.to_string());
        }
        imports.push(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false });
    }

    for caps in include_re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().to_string();
        imports.push(ImportInfo { module, symbols: Vec::new(), is_default: false, is_pub: false, is_system: false });
    }

    imports
}

fn extract_imports_ruby_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?m)^[ \t]*(?:require|require_relative)\s+['"]([^'"]+)['"]"#).unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let module = caps.get(1).unwrap().as_str().to_string();
        let last = module.rsplit(|c: char| c == '/' || c == '.').next().unwrap_or(&module).to_string();
        imports.push(ImportInfo {
            module,
            symbols: vec![last],
            is_default: false,
            is_pub: false,
            is_system: false,
        });
    }
    imports
}

fn extract_imports_kotlin_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*import\s+(.+)").unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let inner = caps.get(1).unwrap().as_str().trim().trim_end_matches(';').trim();
        if inner.is_empty() { continue; }
        let module = inner.to_string();
        let last = module.rsplit('.').next().unwrap_or(&module).to_string();
        imports.push(ImportInfo {
            module,
            symbols: vec![last],
            is_default: false,
            is_pub: false,
            is_system: false,
        });
    }
    imports
}

fn extract_imports_scala_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?m)^[ \t]*import\s+(.+?)(?:\s*;|\s*$)").unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let trimmed = caps.get(1).unwrap().as_str().trim();
        if trimmed.is_empty() { continue; }
        let mut symbols = Vec::new();
        let module = if let Some(brace_start) = trimmed.find('{') {
            let prefix = trimmed[..brace_start].trim_end_matches('.').trim().to_string();
            if let Some(brace_end) = trimmed.find('}') {
                for s in trimmed[brace_start + 1..brace_end].split(',') {
                    let s = s.trim();
                    if s != "_" && !s.is_empty() { symbols.push(s.to_string()); }
                }
            }
            prefix
        } else {
            trimmed.to_string()
        };
        imports.push(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false });
    }
    imports
}

fn extract_imports_dart_regex(content: &str) -> Vec<ImportInfo> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?m)^[ \t]*import\s+['"]([^'"]+)['"]\s*(?:(?:as\s+\w+|show\s+([^;]+)|hide\s+[^;]+)\s*)*;"#).unwrap()
    });

    let mut imports = Vec::new();
    for caps in re.captures_iter(content) {
        let uri = caps.get(1).unwrap().as_str().to_string();
        let module = uri.strip_suffix(".dart").unwrap_or(&uri)
            .rsplit(|c: char| c == '/' || c == ':')
            .next()
            .unwrap_or(&uri)
            .to_string();
        let mut symbols = Vec::new();
        if let Some(show) = caps.get(2) {
            for s in show.as_str().split(',') {
                let s = s.trim();
                if !s.is_empty() { symbols.push(s.to_string()); }
            }
        }
        imports.push(ImportInfo { module, symbols, is_default: false, is_pub: false, is_system: false });
    }
    imports
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::create_parser;
    use crate::types::Language;

    // ── Import extraction ──────────────────────────────────────────────

    #[test]
    fn test_extract_imports_typescript() {
        let mut parser = create_parser(Language::TypeScript).unwrap();
        let source = r#"import { useState, useEffect } from 'react';
import App from './App';
"#;
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::TypeScript);

        assert!(!imports.is_empty(), "Expected at least one import");
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();
        assert!(modules.contains(&"react"), "Expected 'react' import, got {:?}", modules);
        assert!(modules.contains(&"./App"), "Expected './App' import, got {:?}", modules);
    }

    #[test]
    fn test_extract_imports_python() {
        let mut parser = create_parser(Language::Python).unwrap();
        let source = "from os.path import join, exists\nimport sys\n";
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::Python);

        assert!(!imports.is_empty(), "Expected at least one import");
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();
        assert!(modules.contains(&"os.path"), "Expected 'os.path' import, got {:?}", modules);
        assert!(modules.contains(&"sys"), "Expected 'sys' import, got {:?}", modules);
    }

    #[test]
    fn test_extract_imports_rust() {
        let mut parser = create_parser(Language::Rust).unwrap();
        let source = "use std::path::Path;\nuse crate::types::Language;\n";
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::Rust);

        assert!(!imports.is_empty(), "Expected at least one import");
        let has_std = imports.iter().any(|i| i.module.contains("std::path"));
        assert!(has_std, "Expected std::path import, got {:?}", imports.iter().map(|i| &i.module).collect::<Vec<_>>());
    }

    #[test]
    fn test_extract_rust_mod_declarations() {
        let mut parser = create_parser(Language::Rust).unwrap();
        let source = r#"
use std::path::Path;

mod macros;
pub mod de;
pub mod error;
pub mod map;
pub mod ser;
pub mod value;
mod io;
mod number;
mod read;

pub mod __private {
    pub use alloc::vec;
}
"#;
        let tree = parser.parse(source, None).unwrap();

        // Debug: print the AST
        fn print_tree(node: &tree_sitter::Node, source: &str, depth: usize) {
            let indent = " ".repeat(depth * 2);
            let text = &source[node.byte_range()];
            let short = if text.len() > 60 { &text[..60] } else { text };
            let short = short.replace('\n', "\\n");
            eprintln!("{}[{}] {} {:?}", indent, node.kind(), node.byte_range().start, short);
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                print_tree(&child, source, depth + 1);
            }
        }
        print_tree(&tree.root_node(), source, 0);

        let imports = RelationTracker::extract_imports(&tree, source, Language::Rust);

        eprintln!("Extracted imports: {:?}", imports.iter().map(|i| &i.module).collect::<Vec<_>>());

        // Should have the `use` import
        assert!(imports.iter().any(|i| i.module.contains("std::path")),
            "Expected std::path import");

        // Should have mod declarations
        assert!(imports.iter().any(|i| i.module == "self::macros"),
            "Expected self::macros from 'mod macros;', got modules: {:?}",
            imports.iter().map(|i| &i.module).collect::<Vec<_>>());

        assert!(imports.iter().any(|i| i.module == "self::de"),
            "Expected self::de from 'pub mod de;'");

        assert!(imports.iter().any(|i| i.module == "self::io"),
            "Expected self::io from 'mod io;'");

        // Inline modules should NOT appear
        assert!(!imports.iter().any(|i| i.module.contains("__private")),
            "Inline mod __private should be skipped");
    }

    #[test]
    fn test_extract_imports_rust_skips_inner_scope() {
        let mut parser = create_parser(Language::Rust).unwrap();
        let source = r#"use crate::io;
use crate::error::Result;

pub trait Formatter {
    fn write_null<W>(&mut self, w: &mut W) -> io::Result<()>;
}

pub enum CharEscape { Quote, Tab }

impl Formatter for CompactFormatter {
    fn write_char_escape<W>(&mut self, w: &mut W, ch: CharEscape) -> io::Result<()>
    where W: io::Write,
    {
        use self::CharEscape::*;
        match ch {
            Quote => w.write_all(b"\\\""),
            Tab => w.write_all(b"\\t"),
        }
    }
}

fn helper() {
    use std::fmt::Write;
    let _ = format!("test");
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::Rust);
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();

        assert!(modules.iter().any(|m| m.contains("io")),
            "Expected top-level 'crate::io' import, got {:?}", modules);
        assert!(modules.iter().any(|m| m.contains("error")),
            "Expected top-level 'crate::error' import, got {:?}", modules);
        assert!(!modules.iter().any(|m| m.contains("CharEscape")),
            "Inner-scope 'use self::CharEscape::*' should be excluded, got {:?}", modules);
        assert!(!modules.iter().any(|m| m.contains("fmt")),
            "Inner-scope 'use std::fmt::Write' should be excluded, got {:?}", modules);
    }

    #[test]
    fn test_extract_imports_skips_unsupported_language() {
        let mut parser = create_parser(Language::Python).unwrap();
        let source = "import sys\n";
        let tree = parser.parse(source, None).unwrap();
        // Use an unsupported language variant to verify empty result
        let imports = RelationTracker::extract_imports(&tree, source, Language::Unknown);
        assert!(imports.is_empty(), "Expected no imports for unsupported language");
    }

    // ── Call extraction ────────────────────────────────────────────────

    #[test]
    fn test_extract_calls_typescript() {
        let mut parser = create_parser(Language::TypeScript).unwrap();
        let source = r#"function greet(name: string) {
    console.log("hello");
    fetch("/api");
}
greet("world");
"#;
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::TypeScript);

        assert!(!calls.is_empty(), "Expected at least one call");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"greet"), "Expected 'greet' call, got {:?}", names);
    }

    #[test]
    fn test_extract_calls_python() {
        let mut parser = create_parser(Language::Python).unwrap();
        let source = "def foo():\n    bar()\n    baz(1, 2)\nfoo()\n";
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::Python);

        assert!(!calls.is_empty(), "Expected at least one call");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"foo"), "Expected 'foo' call, got {:?}", names);
        assert!(names.contains(&"bar"), "Expected 'bar' call, got {:?}", names);
        assert!(names.contains(&"baz"), "Expected 'baz' call, got {:?}", names);
    }

    #[test]
    fn test_extract_calls_rust() {
        let mut parser = create_parser(Language::Rust).unwrap();
        let source = "fn main() {\n    println!(\"hi\");\n    do_work();\n}\n";
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::Rust);

        assert!(!calls.is_empty(), "Expected at least one call");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"do_work"), "Expected 'do_work' call, got {:?}", names);
    }

    #[test]
    fn test_extract_calls_scope_tracking() {
        let mut parser = create_parser(Language::Python).unwrap();
        let source = "def outer():\n    inner()\ndef another():\n    helper()\n";
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::Python);

        // inner() should have scope "outer", helper() should have scope "another"
        let inner_call = calls.iter().find(|c| c.name == "inner");
        assert!(inner_call.is_some(), "Expected 'inner' call");
        assert_eq!(
            inner_call.unwrap().scope_name.as_deref(),
            Some("outer"),
            "Expected 'inner' to be in scope 'outer'"
        );

        let helper_call = calls.iter().find(|c| c.name == "helper");
        assert!(helper_call.is_some(), "Expected 'helper' call");
        assert_eq!(
            helper_call.unwrap().scope_name.as_deref(),
            Some("another"),
            "Expected 'helper' to be in scope 'another'"
        );
    }

    #[test]
    fn test_extract_calls_line_numbers() {
        let mut parser = create_parser(Language::TypeScript).unwrap();
        let source = "foo();\nbar();\nbaz();\n";
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::TypeScript);

        assert_eq!(calls.len(), 3, "Expected 3 calls");
        assert_eq!(calls[0].line, 1, "First call should be on line 1");
        assert_eq!(calls[1].line, 2, "Second call should be on line 2");
        assert_eq!(calls[2].line, 3, "Third call should be on line 3");
    }

    // ── JSX event handler references ─────────────────────────────────

    #[test]
    fn test_extract_calls_jsx_event_handlers() {
        let mut parser = create_parser(Language::TypeScript).unwrap();
        let source = r#"function App() {
    function handleClick() {}
    function handleKeyDown(e: KeyboardEvent) {}
    return (
        <div onClick={handleClick} onKeyDown={handleKeyDown}>
            <input onChange={handleChange} />
        </div>
    );
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::TypeScript);

        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(
            names.contains(&"handleClick"),
            "Expected 'handleClick' from onClick JSX attribute, got {:?}",
            names
        );
        assert!(
            names.contains(&"handleKeyDown"),
            "Expected 'handleKeyDown' from onKeyDown JSX attribute, got {:?}",
            names
        );
        assert!(
            names.contains(&"handleChange"),
            "Expected 'handleChange' from onChange JSX attribute, got {:?}",
            names
        );
    }

    #[test]
    fn test_extract_calls_jsx_non_event_attrs_ignored() {
        let mut parser = create_parser(Language::TypeScript).unwrap();
        let source = r#"function App() {
    const myRef = useRef(null);
    return <div className={styles} ref={myRef} />;
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::TypeScript);

        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        // className and ref are not event handlers, should not be extracted as calls
        assert!(
            !names.contains(&"styles"),
            "Non-event attribute 'className' should not produce a call, got {:?}",
            names
        );
    }

    // ── Java imports & calls ──────────────────────────────────────────

    #[test]
    fn test_extract_imports_java() {
        let mut parser = create_parser(Language::Java).unwrap();
        let source = "import java.util.List;\nimport java.io.File;\n\npublic class Main {}\n";
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::Java);

        assert!(!imports.is_empty(), "Expected at least one import");
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();
        assert!(
            modules.iter().any(|m| m.contains("java.util.List")),
            "Expected 'java.util.List' import, got {:?}", modules
        );
        assert!(
            modules.iter().any(|m| m.contains("java.io.File")),
            "Expected 'java.io.File' import, got {:?}", modules
        );
    }

    #[test]
    fn test_extract_calls_java() {
        let mut parser = create_parser(Language::Java).unwrap();
        let source = r#"public class Main {
    public void run() {
        System.out.println("hi");
        process();
    }
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::Java);

        assert!(!calls.is_empty(), "Expected at least one call");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"println"), "Expected 'println' call, got {:?}", names);
        assert!(names.contains(&"process"), "Expected 'process' call, got {:?}", names);
    }

    // ── Go imports & calls ────────────────────────────────────────────

    #[test]
    fn test_extract_imports_go() {
        let mut parser = create_parser(Language::Go).unwrap();
        let source = "package main\n\nimport (\n\t\"fmt\"\n\t\"os\"\n)\n\nfunc main() {}\n";
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::Go);

        assert!(!imports.is_empty(), "Expected at least one import");
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();
        assert!(modules.contains(&"fmt"), "Expected 'fmt' import, got {:?}", modules);
        assert!(modules.contains(&"os"), "Expected 'os' import, got {:?}", modules);
    }

    #[test]
    fn test_extract_calls_go() {
        let mut parser = create_parser(Language::Go).unwrap();
        let source = r#"package main

import "fmt"

func greet(name string) {
    fmt.Println(name)
}

func main() {
    greet("world")
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::Go);

        assert!(!calls.is_empty(), "Expected at least one call");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"greet"), "Expected 'greet' call, got {:?}", names);
    }

    // ── C/C++ imports & calls ─────────────────────────────────────────

    #[test]
    fn test_extract_imports_c() {
        let mut parser = create_parser(Language::C).unwrap();
        let source = "#include <stdio.h>\n#include \"mylib.h\"\n\nint main() { return 0; }\n";
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::C);

        assert!(!imports.is_empty(), "Expected at least one import");
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();
        assert!(
            modules.iter().any(|m| m.contains("stdio.h")),
            "Expected 'stdio.h' import, got {:?}", modules
        );
        assert!(
            modules.iter().any(|m| m.contains("mylib.h")),
            "Expected 'mylib.h' import, got {:?}", modules
        );
    }

    #[test]
    fn test_extract_calls_c() {
        let mut parser = create_parser(Language::C).unwrap();
        let source = r#"#include <stdio.h>
void process(int x) { printf("%d\n", x); }
int main() { process(42); return 0; }
"#;
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::C);

        assert!(!calls.is_empty(), "Expected at least one call");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"process"), "Expected 'process' call, got {:?}", names);
        assert!(names.contains(&"printf"), "Expected 'printf' call, got {:?}", names);
    }

    #[test]
    fn test_extract_imports_cpp() {
        let mut parser = create_parser(Language::Cpp).unwrap();
        let source = "#include <iostream>\n#include <vector>\n\nint main() {}\n";
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::Cpp);

        assert!(!imports.is_empty(), "Expected at least one import");
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();
        assert!(
            modules.iter().any(|m| m.contains("iostream")),
            "Expected 'iostream' import, got {:?}", modules
        );
    }

    // ── C# imports & calls ────────────────────────────────────────────

    #[test]
    fn test_extract_imports_csharp() {
        let mut parser = create_parser(Language::CSharp).unwrap();
        let source = "using System;\nusing System.Collections.Generic;\n\nclass Main {}\n";
        let tree = parser.parse(source, None).unwrap();
        let imports = RelationTracker::extract_imports(&tree, source, Language::CSharp);

        assert!(!imports.is_empty(), "Expected at least one import");
        let modules: Vec<&str> = imports.iter().map(|i| i.module.as_str()).collect();
        assert!(
            modules.iter().any(|m| m.contains("System")),
            "Expected 'System' import, got {:?}", modules
        );
    }

    #[test]
    fn test_extract_calls_csharp() {
        let mut parser = create_parser(Language::CSharp).unwrap();
        let source = r#"using System;
class Program {
    static void Main() {
        Console.WriteLine("hello");
        Process();
    }
    static void Process() {}
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let calls = RelationTracker::extract_calls(&tree, source, Language::CSharp);

        assert!(!calls.is_empty(), "Expected at least one call");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"WriteLine"), "Expected 'WriteLine' call, got {:?}", names);
        assert!(names.contains(&"Process"), "Expected 'Process' call, got {:?}", names);
    }

    #[test]
    fn test_extract_calls_kotlin_regex() {
        let source = r#"fun main() {
    println("hello")
    listOf(1, 2, 3)
    foo.bar()
}
"#;
        let calls = extract_calls_regex(source, Language::Kotlin);
        assert!(!calls.is_empty(), "Expected Kotlin regex calls");
        let names: Vec<&str> = calls.iter().map(|c| c.name.as_str()).collect();
        assert!(names.contains(&"println"), "Expected 'println', got {:?}", names);
        assert!(names.contains(&"listOf"), "Expected 'listOf', got {:?}", names);
        assert!(names.contains(&"bar"), "Expected 'bar' from foo.bar(), got {:?}", names);
    }
}
