use crate::file::Language;
use crate::symbol::{ParsedSymbol, SymbolKind, SymbolMetadata, SymbolVisibility};
use tree_sitter::{Node, Tree};

/// Tree-sitter AST symbol extractor.
///
/// **DEPRECATED**: Replaced by `uhpp_extractor::uhpp_extract_symbols` which uses
/// UHPP regex-based extraction. This module is retained only for test comparison
/// and will be removed once UHPP parity is fully validated.
#[deprecated(note = "Use uhpp_extractor::uhpp_extract_symbols instead")]
#[allow(deprecated)]
pub struct SymbolExtractor;

#[allow(deprecated)]
impl SymbolExtractor {
    /// Extract symbols from a tree-sitter AST
    pub fn extract_symbols(
        tree: &Tree,
        source: &str,
        language: crate::types::Language,
    ) -> Vec<ParsedSymbol> {
        let mut symbols = Vec::new();
        let root_node = tree.root_node();
        
        Self::walk_tree(&root_node, source, language, &mut symbols, None);
        
        // Post-process: extract body previews (~20 lines) for function/method symbols
        let source_lines: Vec<&str> = source.lines().collect();
        for sym in &mut symbols {
            if matches!(sym.kind, SymbolKind::Function | SymbolKind::Method) {
                if let (Some(end_line), start_line) = (sym.end_line, sym.line) {
                    let body_start = start_line as usize; // skip signature line
                    let body_end = ((start_line + 20) as usize).min(end_line as usize).min(source_lines.len());
                    if body_start < body_end && body_start <= source_lines.len() {
                        let preview: String = source_lines[body_start..body_end].join("\n");
                        if !preview.trim().is_empty() {
                            sym.body_preview = Some(preview);
                        }
                    }
                }
            }
        }
        
        symbols
    }

    /// Recursively walk the AST tree
    fn walk_tree(
        node: &Node,
        source: &str,
        language: crate::types::Language,
        symbols: &mut Vec<ParsedSymbol>,
        parent: Option<&str>,
    ) {
        // Extract symbol based on node type and language
        if let Some(symbol) = Self::extract_symbol_from_node(node, source, language, parent) {
            let symbol_name = symbol.name.clone();

            // Rust impl blocks: use type name as parent for child methods
            // but don't store the impl symbol itself (prevents shadowing
            // individual methods like `deserialize_any` when searching for the type name).
            // Propagate `implements` metadata to child methods so they carry trait info.
            let is_rust_impl = matches!(language, Language::Rust)
                && node.kind() == "impl_item";
            let impl_implements = if is_rust_impl {
                symbol.metadata.implements.clone()
            } else {
                None
            };
            if !is_rust_impl {
                symbols.push(symbol);
            }
            
            // Recursively process children
            let start_idx = symbols.len();
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                Self::walk_tree(&child, source, language, symbols, Some(&symbol_name));
            }
            // For Rust impl blocks, propagate trait implements to all child methods
            if let Some(ref impls) = impl_implements {
                for sym in &mut symbols[start_idx..] {
                    if sym.metadata.implements.is_none() {
                        sym.metadata.implements = Some(impls.clone());
                    }
                }
            }
        } else {
            // No symbol extracted, but still process children
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                Self::walk_tree(&child, source, language, symbols, parent);
            }
        }
    }

    /// Extract a symbol from a tree-sitter node
    fn extract_symbol_from_node(
        node: &Node,
        source: &str,
        language: crate::types::Language,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let node_type = node.kind();
        let start_line = node.start_position().row as u32 + 1; // 1-indexed
        let end_line = node.end_position().row as u32 + 1;
        
        // Language-specific extraction
        match language {
            crate::types::Language::TypeScript | crate::types::Language::JavaScript => {
                Self::extract_ts_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Python => {
                Self::extract_python_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Rust => {
                Self::extract_rust_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Java => {
                Self::extract_java_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Go => {
                Self::extract_go_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::C | crate::types::Language::Cpp => {
                Self::extract_c_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::CSharp => {
                Self::extract_csharp_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Swift => {
                Self::extract_swift_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Php => {
                Self::extract_php_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Ruby => {
                Self::extract_ruby_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Scala => {
                Self::extract_scala_symbol(node, source, node_type, start_line, end_line, parent)
            }
            crate::types::Language::Dart => {
                Self::extract_dart_symbol(node, source, node_type, start_line, end_line, parent)
            }
            _ => None,
        }
    }

    /// Extract TypeScript/JavaScript symbol
    fn extract_ts_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let is_exported = false;

        let (name, kind) = match node_type {
            "function_declaration" | "function" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Function)
            }
            "method_definition" | "method" => {
                let n = Self::find_child_text(node, source, "property_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Method)
            }
            "class_declaration" | "class" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Class)
            }
            "interface_declaration" | "interface" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Interface)
            }
            "type_alias_declaration" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Type)
            }
            "variable_declaration" | "lexical_declaration" => {
                let n = Self::get_variable_name(node, source)?;
                // Check if the initializer is an arrow function or function expression.
                // e.g. `const foo = () => { ... }` or `const bar = function() { ... }`
                let kind = Self::detect_variable_function_kind(node);
                (n, kind)
            }
            "enum_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Enum)
            }
            "export_statement" => {
                // Delegate to the inner declaration, marking it as exported.
                // Detect `export default` by checking the source text of the node.
                let node_src = &source[node.start_byte()..node.end_byte()];
                let is_default_export = node_src.trim_start().starts_with("export default");

                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if let Some(mut sym) = Self::extract_ts_symbol(&child, source, child.kind(), start_line, end_line, parent) {
                        let mods = sym.metadata.modifiers.get_or_insert_with(Vec::new);
                        if !mods.contains(&"export".to_string()) {
                            mods.push("export".to_string());
                        }
                        if is_default_export && !mods.contains(&"default".to_string()) {
                            mods.push("default".to_string());
                        }
                        return Some(sym);
                    }
                }
                // Fallback for anonymous default exports: `export default function(...) { ... }`
                // When the inner function/class has no name, use "default" as the symbol name.
                if is_default_export {
                    return Some(ParsedSymbol {
                        name: "default".to_string(),
                        kind: SymbolKind::Function,
                        line: start_line,
                        end_line: Some(end_line),
                        scope_id: parent.map(|p| p.to_string()),
                        complexity: None,
                        body_preview: None,
                        signature: None,
                        metadata: SymbolMetadata {
                            parameters: None,
                            return_type: None,
                            visibility: None,
                            modifiers: Some(vec!["export".to_string(), "default".to_string()]),
                            extends: None,
                            implements: None,
                            parent_symbol: parent.map(|p| p.to_string()),
                        },
                    });
                }
                return None;
            }
            _ => return None,
        };
        
        // Extract signature and complexity for functions/methods
        let (signature, complexity) = if matches!(kind, SymbolKind::Function | SymbolKind::Method) {
            (Some(Self::extract_signature(node, source)), Some(Self::calculate_complexity(node)))
        } else {
            (None, None)
        };

        // Extract visibility, modifiers, extends, implements from AST children.
        // TS/JS tree-sitter uses accessibility_modifier (public/private/protected),
        // standalone keyword nodes (static, abstract, async, readonly, override),
        // extends_clause and implements_clause for class declarations.
        let mut visibility = None;
        let mut modifiers_list: Vec<String> = Vec::new();
        let mut extends_list: Vec<String> = Vec::new();
        let mut implements_list: Vec<String> = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            let child_kind = child.kind();
            match child_kind {
                "accessibility_modifier" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        match text.trim() {
                            "public" => visibility = Some(SymbolVisibility::Public),
                            "private" => visibility = Some(crate::types::SymbolVisibility::Private),
                            "protected" => visibility = Some(crate::types::SymbolVisibility::Protected),
                            _ => {}
                        }
                    }
                }
                // Standalone modifier keyword nodes in TS
                "static" | "abstract" | "async" | "readonly" | "override" => {
                    modifiers_list.push(child_kind.to_string());
                }
                "extends_clause" => {
                    let mut ec_cursor = child.walk();
                    for ec_child in child.children(&mut ec_cursor) {
                        match ec_child.kind() {
                            "identifier" | "type_identifier" | "generic_type"
                            | "member_expression" => {
                                if let Some(text) = Self::get_node_text(&ec_child, source) {
                                    let trimmed = text.trim().to_string();
                                    if !trimmed.is_empty() {
                                        extends_list.push(trimmed);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "implements_clause" => {
                    let mut ic_cursor = child.walk();
                    for ic_child in child.children(&mut ic_cursor) {
                        match ic_child.kind() {
                            "identifier" | "type_identifier" | "generic_type"
                            | "member_expression" => {
                                if let Some(text) = Self::get_node_text(&ic_child, source) {
                                    let trimmed = text.trim().to_string();
                                    if !trimmed.is_empty() {
                                        implements_list.push(trimmed);
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

        if is_exported && !modifiers_list.contains(&"export".to_string()) {
            modifiers_list.push("export".to_string());
        }

        let modifiers = if modifiers_list.is_empty() { None } else { Some(modifiers_list) };
        let extends = if extends_list.is_empty() { None } else { Some(extends_list) };
        let implements = if implements_list.is_empty() { None } else { Some(implements_list) };

        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility,
                modifiers,
                parent_symbol: parent.map(String::from),
                extends,
                implements,
            },
        })
    }

    /// Extract Python symbol
    fn extract_python_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "function_definition" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Function)
            }
            "class_definition" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Class)
            }
            "expression_statement" => {
                return Self::extract_python_assignment(node, source, start_line, end_line, parent);
            }
            _ => return None,
        };
        
        let complexity = if matches!(kind, SymbolKind::Function) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };

        // Extract metadata from AST children.
        let mut visibility = None;
        let mut modifiers_list: Vec<String> = Vec::new();
        let mut extends_list: Vec<String> = Vec::new();

        if kind == SymbolKind::Function {
            // Python visibility convention: _name = private, __name = very private
            if name.starts_with("__") && !name.ends_with("__") {
                visibility = Some(crate::types::SymbolVisibility::Private);
            } else if name.starts_with('_') {
                visibility = Some(crate::types::SymbolVisibility::Private);
            } else {
                visibility = Some(crate::types::SymbolVisibility::Public);
            }

            // Check decorators for @staticmethod, @classmethod, @property, @abstractmethod
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "decorator" {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        let trimmed = text.trim().trim_start_matches('@');
                        match trimmed {
                            "staticmethod" => modifiers_list.push("static".to_string()),
                            "classmethod" => modifiers_list.push("classmethod".to_string()),
                            "property" => modifiers_list.push("property".to_string()),
                            "abstractmethod" => modifiers_list.push("abstract".to_string()),
                            _ => {}
                        }
                    }
                }
            }
        } else if kind == SymbolKind::Class {
            // Extract base classes from argument_list child
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if child.kind() == "argument_list" {
                    let mut al_cursor = child.walk();
                    for al_child in child.children(&mut al_cursor) {
                        match al_child.kind() {
                            "identifier" | "attribute" => {
                                if let Some(text) = Self::get_node_text(&al_child, source) {
                                    let trimmed = text.trim().to_string();
                                    if !trimmed.is_empty() && trimmed != "(" && trimmed != ")" && trimmed != "," {
                                        extends_list.push(trimmed);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    break;
                }
            }
            visibility = Some(crate::types::SymbolVisibility::Public);
        }

        let modifiers = if modifiers_list.is_empty() { None } else { Some(modifiers_list) };
        let extends = if extends_list.is_empty() { None } else { Some(extends_list) };

        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility,
                modifiers,
                parent_symbol: parent.map(String::from),
                extends,
                implements: None,
            },
        })
    }

    /// Extract Python module-level assignment as a variable symbol.
    /// Handles `x = 10`, `MY_CONST = "value"`, skips tuple/list unpacking.
    fn extract_python_assignment(
        node: &Node,
        source: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "assignment" {
                // First child of assignment is the left-hand side
                let mut assign_cursor = child.walk();
                for assign_child in child.children(&mut assign_cursor) {
                    if assign_child.kind() == "identifier" {
                        let name = Self::get_node_text(&assign_child, source)?;
                        // Uppercase names are treated as constants
                        let kind = if name.chars().all(|c| c.is_uppercase() || c == '_') {
                            SymbolKind::Constant
                        } else {
                            SymbolKind::Variable
                        };
                        return Some(ParsedSymbol {
                            name,
                            kind,
                            line: start_line,
                            end_line: Some(end_line),
                            scope_id: None,
                            signature: None,
                            complexity: None,
                            body_preview: None,
                            metadata: SymbolMetadata {
                                parameters: None,
                                return_type: None,
                                visibility: None,
                                modifiers: None,
                                parent_symbol: parent.map(String::from),
                                extends: None,
                                implements: None,
                            },
                        });
                    }
                    // Skip destructuring (pattern_list, tuple_pattern, etc.)
                    break;
                }
            }
        }
        None
    }

    /// Extract Rust symbol
    fn extract_rust_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let mut implements: Option<Vec<String>> = None;
        
        let (name, kind) = match node_type {
            "function_item" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Function)
            }
            "struct_item" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| {
                        // Fallback for grammar variants where name is inside generic_type
                        let mut c = node.walk();
                        for child in node.children(&mut c) {
                            if child.kind() == "generic_type" {
                                return Self::find_child_text(&child, source, "type_identifier");
                            }
                        }
                        None
                    })
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Struct)
            }
            "enum_item" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| {
                        let mut c = node.walk();
                        for child in node.children(&mut c) {
                            if child.kind() == "generic_type" {
                                return Self::find_child_text(&child, source, "type_identifier");
                            }
                        }
                        None
                    })
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Enum)
            }
            "impl_item" => {
                let mut type_ids: Vec<String> = Vec::new();
                let mut has_for = false;
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    match child.kind() {
                        "type_identifier" | "scoped_type_identifier" | "generic_type" => {
                            if let Some(text) = Self::get_node_text(&child, source) {
                                type_ids.push(text.trim().to_string());
                            }
                        }
                        "for" => { has_for = true; }
                        _ => {}
                    }
                }
                
                if has_for && type_ids.len() >= 2 {
                    let trait_name = type_ids[0].clone();
                    let type_name = type_ids[1].clone();
                    implements = Some(vec![trait_name]);
                    (type_name, SymbolKind::Method)
                } else if let Some(type_name) = type_ids.into_iter().next() {
                    (type_name, SymbolKind::Method)
                } else {
                    return None;
                }
            }
            "trait_item" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Interface)
            }
            "const_item" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Constant)
            }
            "static_item" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Variable)
            }
            "let_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Variable)
            }
            "type_item" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Type)
            }
            "macro_definition" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Function)
            }
            _ => return None,
        };
        
        let (signature, complexity) = if matches!(kind, SymbolKind::Function | SymbolKind::Method) {
            let sig = Self::extract_signature(node, source);
            let sig = if sig.is_empty() { None } else { Some(sig) };
            (sig, Some(Self::calculate_complexity(node)))
        } else {
            (None, None)
        };

        // Extract visibility and modifiers from AST children.
        // Rust tree-sitter uses visibility_modifier (pub, pub(crate), pub(super))
        // and keyword nodes like "async", "unsafe", "const".
        let mut visibility = None;
        let mut modifiers_list: Vec<String> = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "visibility_modifier" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        let trimmed = text.trim();
                        match trimmed {
                            "pub" => visibility = Some(crate::types::SymbolVisibility::Public),
                            "pub(crate)" => visibility = Some(crate::types::SymbolVisibility::Internal),
                            "pub(super)" => visibility = Some(crate::types::SymbolVisibility::Protected),
                            _ if trimmed.starts_with("pub") => {
                                visibility = Some(crate::types::SymbolVisibility::Public);
                            }
                            _ => {}
                        }
                    }
                }
                "async" => modifiers_list.push("async".to_string()),
                "unsafe" => modifiers_list.push("unsafe".to_string()),
                // "const" as a keyword node on const fn
                "const" if node_type == "function_item" => {
                    modifiers_list.push("const".to_string());
                }
                _ => {}
            }
        }

        // Default to private if no visibility modifier present (Rust default)
        if visibility.is_none() && !matches!(node_type, "impl_item" | "let_declaration") {
            visibility = Some(crate::types::SymbolVisibility::Private);
        }

        let modifiers = if modifiers_list.is_empty() { None } else { Some(modifiers_list) };

        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility,
                modifiers,
                parent_symbol: parent.map(String::from),
                extends: None,
                implements,
            },
        })
    }

    /// Extract Java symbol
    fn extract_java_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let kind = match node_type {
            "method_declaration" => SymbolKind::Method,
            "constructor_declaration" => SymbolKind::Method,
            "class_declaration" => SymbolKind::Class,
            "interface_declaration" => SymbolKind::Interface,
            "enum_declaration" => SymbolKind::Enum,
            "field_declaration" => SymbolKind::Field,
            "annotation_type_declaration" => SymbolKind::Interface,
            _ => return None,
        };
        let name = Self::find_child_text(node, source, "identifier")
            .or_else(|| Self::get_variable_name(node, source))?;
        
        // Calculate complexity for methods
        let complexity = if matches!(kind, SymbolKind::Method) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };
        
        // Extract visibility, modifiers, extends, implements from AST children.
        // Java tree-sitter uses a "modifiers" node for access modifiers and keywords,
        // plus "superclass" and "super_interfaces" nodes for inheritance.
        let mut visibility = None;
        let mut modifiers_list: Vec<String> = Vec::new();
        let mut extends_list: Vec<String> = Vec::new();
        let mut implements_list: Vec<String> = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            match child.kind() {
                "modifiers" => {
                    let mut mod_cursor = child.walk();
                    for modifier in child.children(&mut mod_cursor) {
                        if let Some(text) = Self::get_node_text(&modifier, source) {
                            let text = text.trim();
                            match text {
                                "public" => visibility = Some(crate::types::SymbolVisibility::Public),
                                "private" => visibility = Some(crate::types::SymbolVisibility::Private),
                                "protected" => visibility = Some(crate::types::SymbolVisibility::Protected),
                                "static" | "final" | "abstract" | "synchronized"
                                | "volatile" | "transient" | "native" | "default" => {
                                    modifiers_list.push(text.to_string());
                                }
                                _ => {}
                            }
                        }
                    }
                }
                // Java superclass: "extends BaseClass"
                "superclass" => {
                    let mut sc_cursor = child.walk();
                    for sc_child in child.children(&mut sc_cursor) {
                        match sc_child.kind() {
                            "type_identifier" | "scoped_type_identifier" | "generic_type" => {
                                if let Some(text) = Self::get_node_text(&sc_child, source) {
                                    let trimmed = text.trim().to_string();
                                    if !trimmed.is_empty() {
                                        extends_list.push(trimmed);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                // Java super_interfaces: "implements IFoo, IBar"
                "super_interfaces" => {
                    let mut si_cursor = child.walk();
                    for si_child in child.children(&mut si_cursor) {
                        match si_child.kind() {
                            "type_list" => {
                                let mut tl_cursor = si_child.walk();
                                for tl_child in si_child.children(&mut tl_cursor) {
                                    match tl_child.kind() {
                                        "type_identifier" | "scoped_type_identifier" | "generic_type" => {
                                            if let Some(text) = Self::get_node_text(&tl_child, source) {
                                                let trimmed = text.trim().to_string();
                                                if !trimmed.is_empty() {
                                                    implements_list.push(trimmed);
                                                }
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            "type_identifier" | "scoped_type_identifier" | "generic_type" => {
                                if let Some(text) = Self::get_node_text(&si_child, source) {
                                    let trimmed = text.trim().to_string();
                                    if !trimmed.is_empty() {
                                        implements_list.push(trimmed);
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
        let modifiers = if modifiers_list.is_empty() { None } else { Some(modifiers_list) };
        let extends = if extends_list.is_empty() { None } else { Some(extends_list) };
        let implements = if implements_list.is_empty() { None } else { Some(implements_list) };

        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility,
                modifiers,
                parent_symbol: parent.map(String::from),
                extends,
                implements,
            },
        })
    }

    /// Extract Go symbol
    fn extract_go_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let mut receiver_type: Option<String> = None;
        let mut implements: Option<Vec<String>> = None;
        
        let (name, kind) = match node_type {
            "function_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Function)
            }
            "method_declaration" => {
                // Go method: func (recv Type) Name() - name is a field_identifier
                let n = Self::find_child_text(node, source, "field_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                
                // Extract receiver type from parameter_list
                // In tree-sitter-go, the first parameter_list child is the receiver
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "parameter_list" {
                        // The receiver param list: (recv *Type) or (recv Type)
                        if let Some(text) = Self::get_node_text(&child, source) {
                            let trimmed = text.trim_matches(|c| c == '(' || c == ')').trim();
                            // Extract the type: last token, strip leading *
                            if let Some(type_part) = trimmed.split_whitespace().last() {
                                receiver_type = Some(type_part.trim_start_matches('*').to_string());
                            }
                        }
                        break; // Only first parameter_list is the receiver
                    }
                }
                
                // Tag well-known Go stdlib interface methods for protection.
                // These methods, when defined on a struct, implement standard interfaces.
                let well_known_interface_methods: &[(&str, &str)] = &[
                    ("Write", "io.Writer"),
                    ("Read", "io.Reader"),
                    ("Close", "io.Closer"),
                    ("String", "fmt.Stringer"),
                    ("Error", "error"),
                    ("ServeHTTP", "http.Handler"),
                    ("WriteHeader", "http.ResponseWriter"),
                    ("Header", "http.ResponseWriter"),
                    ("Len", "sort.Interface"),
                    ("Less", "sort.Interface"),
                    ("Swap", "sort.Interface"),
                    ("MarshalJSON", "json.Marshaler"),
                    ("UnmarshalJSON", "json.Unmarshaler"),
                ];
                
                let mut ifaces: Vec<String> = Vec::new();
                for &(method, iface) in well_known_interface_methods {
                    if n == method {
                        ifaces.push(iface.to_string());
                    }
                }
                if !ifaces.is_empty() {
                    implements = Some(ifaces);
                }
                
                (n, SymbolKind::Method)
            }
            "type_declaration" => {
                // type_declaration > type_spec > type_identifier
                // Distinguish struct / interface / plain type alias by inspecting type_spec children
                let n = Self::find_nested_identifier(node, source, &["type_spec", "type_identifier"])?;
                let kind = Self::go_type_decl_kind(node);
                (n, kind)
            }
            "var_declaration" => {
                // var_declaration > var_spec > identifier
                let n = Self::find_nested_identifier(node, source, &["var_spec", "identifier"])?;
                (n, SymbolKind::Variable)
            }
            "const_declaration" => {
                // const_declaration > const_spec > identifier
                let n = Self::find_nested_identifier(node, source, &["const_spec", "identifier"])?;
                (n, SymbolKind::Constant)
            }
            "short_var_declaration" => {
                // short_var_declaration: x := expr
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Variable)
            }
            _ => return None,
        };
        
        // Calculate complexity for functions/methods
        let complexity = if matches!(kind, SymbolKind::Function | SymbolKind::Method) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };
        
        // Go visibility: uppercase first char = exported (public), lowercase = unexported (private)
        let visibility = name.chars().next().map(|c| {
            if c.is_uppercase() {
                crate::types::SymbolVisibility::Public
            } else {
                crate::types::SymbolVisibility::Private
            }
        });
        
        // Use receiver type as parent_symbol for methods, fall back to AST parent
        let parent_sym = receiver_type
            .or_else(|| parent.map(String::from));

        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility,
                modifiers: None,
                parent_symbol: parent_sym,
                extends: None,
                implements,
            },
        })
    }

    /// Classify a Go `type_declaration` as Struct, Interface, or generic Type.
    /// tree-sitter-go AST: type_declaration > type_spec > { struct_type | interface_type | ... }
    fn go_type_decl_kind(node: &Node) -> SymbolKind {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "type_spec" {
                let mut ts_cursor = child.walk();
                for ts_child in child.children(&mut ts_cursor) {
                    match ts_child.kind() {
                        "struct_type" => return SymbolKind::Struct,
                        "interface_type" => return SymbolKind::Interface,
                        _ => {}
                    }
                }
            }
        }
        SymbolKind::Type
    }

    /// Extract C/C++ symbol
    fn extract_c_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "function_definition" => {
                let n = Self::find_nested_identifier(node, source, &["function_declarator", "identifier"])
                    .or_else(|| Self::find_nested_identifier(node, source, &["function_declarator", "field_identifier"]))
                    .or_else(|| Self::find_child_text(node, source, "identifier"))
                    // Fallback for macro-wrapped declarations like CJSON_PUBLIC(cJSON *) cJSON_Parse(...)
                    // where tree-sitter doesn't produce a standard function_declarator.
                    .or_else(|| Self::find_identifier_before_params(node, source))?;
                (n, SymbolKind::Function)
            }
            "declaration" => {
                if Self::has_descendant_kind(node, "function_declarator") {
                    let n = Self::find_nested_identifier(node, source, &["function_declarator", "identifier"])
                        .or_else(|| Self::find_nested_identifier(node, source, &["init_declarator", "function_declarator", "identifier"]))?;
                    (n, SymbolKind::Function)
                } else {
                    let n = Self::find_nested_identifier(node, source, &["init_declarator", "identifier"])
                        .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                    (n, SymbolKind::Variable)
                }
            }
            "struct_specifier" => {
                let n = Self::find_child_text(node, source, "type_identifier")?;
                (n, SymbolKind::Struct)
            }
            "enum_specifier" => {
                let n = Self::find_child_text(node, source, "type_identifier")?;
                (n, SymbolKind::Enum)
            }
            "class_specifier" => {
                let n = Self::find_child_text(node, source, "type_identifier")?;
                (n, SymbolKind::Class)
            }
            "namespace_definition" => {
                let n = Self::find_child_text(node, source, "namespace_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Namespace)
            }
            "type_definition" => {
                // C/C++ typedef: `typedef struct { ... } Name;` or `typedef int Name;`
                // The typedef name is the type_identifier child at the end.
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Type)
            }
            "field_declaration" => {
                // C++ class member: method declarations or member variables.
                // Method decl: `void helperA();` inside class body
                if Self::has_descendant_kind(node, "function_declarator") {
                    let n = Self::find_nested_identifier(node, source, &["function_declarator", "field_identifier"])
                        .or_else(|| Self::find_nested_identifier(node, source, &["function_declarator", "identifier"]))?;
                    (n, SymbolKind::Method)
                } else {
                    let n = Self::find_child_text(node, source, "field_identifier")
                        .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                    (n, SymbolKind::Field)
                }
            }
            "template_declaration" => {
                // Recurse into children to find the inner function/class.
                // Tree-sitter wraps template functions in template_declaration;
                // the inner node may be function_definition, declaration, or class_specifier.
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    let ck = child.kind();
                    if let Some(sym) = Self::extract_c_symbol(&child, source, ck, start_line, end_line, parent) {
                        return Some(sym);
                    }
                }
                return None;
            }
            _ => return None,
        };

        let complexity = if matches!(kind, SymbolKind::Function) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };

        // Extract modifiers, visibility (C++), and extends (C++ class inheritance)
        let mut visibility = None;
        let mut modifiers_list: Vec<String> = Vec::new();
        let mut extends_list: Vec<String> = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            let child_kind = child.kind();
            match child_kind {
                // C/C++ storage class specifiers: static, extern, inline, register
                "storage_class_specifier" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        let trimmed = text.trim().to_string();
                        if !trimmed.is_empty() {
                            modifiers_list.push(trimmed);
                        }
                    }
                }
                // C/C++ type qualifiers: const, volatile, restrict
                "type_qualifier" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        let trimmed = text.trim().to_string();
                        if !trimmed.is_empty() {
                            modifiers_list.push(trimmed);
                        }
                    }
                }
                // C++ virtual keyword on methods
                "virtual" => {
                    modifiers_list.push("virtual".to_string());
                }
                // C++ access specifier (public/private/protected) in class context
                "access_specifier" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        match text.trim() {
                            "public" => visibility = Some(crate::types::SymbolVisibility::Public),
                            "private" => visibility = Some(crate::types::SymbolVisibility::Private),
                            "protected" => visibility = Some(crate::types::SymbolVisibility::Protected),
                            _ => {}
                        }
                    }
                }
                // C++ base_class_clause: class Foo : public Bar, private Baz
                "base_class_clause" => {
                    let mut bc_cursor = child.walk();
                    for bc_child in child.children(&mut bc_cursor) {
                        match bc_child.kind() {
                            "type_identifier" | "qualified_identifier"
                            | "template_type" => {
                                if let Some(text) = Self::get_node_text(&bc_child, source) {
                                    let trimmed = text.trim().to_string();
                                    if !trimmed.is_empty() {
                                        extends_list.push(trimmed);
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

        let modifiers = if modifiers_list.is_empty() { None } else { Some(modifiers_list) };
        let extends = if extends_list.is_empty() { None } else { Some(extends_list) };

        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility,
                modifiers,
                parent_symbol: parent.map(String::from),
                extends,
                implements: None,
            },
        })
    }

    /// Extract C# symbol
    fn extract_csharp_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "method_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Method)
            }
            "class_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Class)
            }
            "interface_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Interface)
            }
            "struct_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Struct)
            }
            "enum_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Enum)
            }
            "field_declaration" => {
                let n = Self::find_nested_identifier(node, source, &["variable_declaration", "variable_declarator", "identifier"])
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Field)
            }
            "property_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Property)
            }
            "namespace_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")
                    .or_else(|| Self::find_child_text(node, source, "qualified_name"))?;
                (n, SymbolKind::Namespace)
            }
            _ => return None,
        };

        let complexity = if matches!(kind, SymbolKind::Method) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };

        // Extract visibility, modifiers, extends, implements from AST children.
        // C# tree-sitter emits modifier keywords as direct children of declarations
        // (e.g. "public", "static", "abstract") and a base_list for inheritance.
        let mut visibility = None;
        let mut modifiers_list: Vec<String> = Vec::new();
        let mut extends_list: Vec<String> = Vec::new();
        let mut implements_list: Vec<String> = Vec::new();

        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            let child_kind = child.kind();
            if let Some(text) = Self::get_node_text(&child, source) {
                let text = text.trim();
                match child_kind {
                    // C# modifier keywords are direct child nodes
                    "modifier" => {
                        match text {
                            "public" => visibility = Some(crate::types::SymbolVisibility::Public),
                            "private" => visibility = Some(crate::types::SymbolVisibility::Private),
                            "protected" => visibility = Some(crate::types::SymbolVisibility::Protected),
                            "internal" => visibility = Some(crate::types::SymbolVisibility::Internal),
                            "static" | "abstract" | "sealed" | "override" | "virtual"
                            | "readonly" | "async" | "partial" | "const" | "extern"
                            | "new" | "volatile" | "unsafe" => {
                                modifiers_list.push(text.to_string());
                            }
                            _ => {}
                        }
                    }
                    // base_list contains ": BaseClass, IInterface1, IInterface2"
                    "base_list" => {
                        let mut bl_cursor = child.walk();
                        for base_child in child.children(&mut bl_cursor) {
                            // Each base type can be identifier, qualified_name, or generic_name
                            match base_child.kind() {
                                "identifier" | "qualified_name" | "generic_name"
                                | "simple_base_type" | "type_identifier" => {
                                    if let Some(base_text) = Self::get_node_text(&base_child, source) {
                                        let trimmed = base_text.trim().to_string();
                                        if !trimmed.is_empty() && trimmed != ":" && trimmed != "," {
                                            // Convention: interfaces start with 'I' in C#
                                            if trimmed.starts_with('I') && trimmed.chars().nth(1).map_or(false, |c| c.is_uppercase()) {
                                                implements_list.push(trimmed);
                                            } else {
                                                extends_list.push(trimmed);
                                            }
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
        }

        let modifiers = if modifiers_list.is_empty() { None } else { Some(modifiers_list) };
        let extends = if extends_list.is_empty() { None } else { Some(extends_list) };
        let implements = if implements_list.is_empty() { None } else { Some(implements_list) };

        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility,
                modifiers,
                parent_symbol: parent.map(String::from),
                extends,
                implements,
            },
        })
    }

    /// Swift: function_declaration, class_declaration, struct_declaration, protocol_declaration
    fn extract_swift_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "function_declaration" => {
                let n = Self::find_child_text(node, source, "simple_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Function)
            }
            "class_declaration" | "struct_declaration" | "protocol_declaration" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "simple_identifier"))
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                let kind = match node_type {
                    "class_declaration" => SymbolKind::Class,
                    "struct_declaration" => SymbolKind::Struct,
                    "protocol_declaration" => SymbolKind::Interface,
                    _ => SymbolKind::Class,
                };
                (n, kind)
            }
            _ => return None,
        };
        let complexity = if matches!(kind, SymbolKind::Function) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };
        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility: None,
                modifiers: None,
                parent_symbol: parent.map(String::from),
                extends: None,
                implements: None,
            },
        })
    }

    /// PHP: function_definition, class_declaration
    fn extract_php_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "function_definition" => {
                let n = Self::find_child_text(node, source, "name")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Function)
            }
            "class_declaration" => {
                let n = Self::find_child_text(node, source, "name")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                (n, SymbolKind::Class)
            }
            _ => return None,
        };
        let complexity = if matches!(kind, SymbolKind::Function) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };
        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility: None,
                modifiers: None,
                parent_symbol: parent.map(String::from),
                extends: None,
                implements: None,
            },
        })
    }

    /// Ruby: method, class, module
    fn extract_ruby_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "method" => {
                let n = Self::find_child_text(node, source, "identifier")
                    .or_else(|| Self::find_child_text(node, source, "method_name"))?;
                (n, SymbolKind::Method)
            }
            "class" | "module" => {
                let n = Self::find_child_text(node, source, "constant")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))?;
                let kind = if node_type == "class" {
                    SymbolKind::Class
                } else {
                    SymbolKind::Namespace
                };
                (n, kind)
            }
            _ => return None,
        };
        let complexity = if matches!(kind, SymbolKind::Method) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };
        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility: None,
                modifiers: None,
                parent_symbol: parent.map(String::from),
                extends: None,
                implements: None,
            },
        })
    }

    /// Scala: function_definition, class_definition, object_definition
    fn extract_scala_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "function_definition" => {
                let n = Self::find_child_text(node, source, "identifier")
                    .or_else(|| Self::find_child_text(node, source, "simple_identifier"))?;
                (n, SymbolKind::Function)
            }
            "class_definition" | "object_definition" => {
                let n = Self::find_child_text(node, source, "type_identifier")
                    .or_else(|| Self::find_child_text(node, source, "identifier"))
                    .or_else(|| Self::find_child_text(node, source, "simple_identifier"))?;
                let kind = if node_type == "class_definition" {
                    SymbolKind::Class
                } else {
                    SymbolKind::Class // object is singleton
                };
                (n, kind)
            }
            _ => return None,
        };
        let complexity = if matches!(kind, SymbolKind::Function) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };
        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility: None,
                modifiers: None,
                parent_symbol: parent.map(String::from),
                extends: None,
                implements: None,
            },
        })
    }

    /// Dart: class_definition, enum_declaration, extension_declaration, mixin_declaration,
    /// method_signature (methods), function_signature (top-level when parent is not method_signature)
    fn extract_dart_symbol(
        node: &Node,
        source: &str,
        node_type: &str,
        start_line: u32,
        end_line: u32,
        parent: Option<&str>,
    ) -> Option<ParsedSymbol> {
        let (name, kind) = match node_type {
            "class_definition" | "mixin_application_class" => {
                let n = Self::find_child_text(node, source, "identifier")
                    .or_else(|| Self::find_child_text(node, source, "type_identifier"))?;
                (n, SymbolKind::Class)
            }
            "enum_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")
                    .or_else(|| Self::find_child_text(node, source, "type_identifier"))?;
                (n, SymbolKind::Enum)
            }
            "extension_declaration" | "mixin_declaration" => {
                let n = Self::find_child_text(node, source, "identifier")
                    .or_else(|| Self::find_child_text(node, source, "type_identifier"))?;
                let kind = if node_type == "extension_declaration" {
                    SymbolKind::Class
                } else {
                    SymbolKind::Interface
                };
                (n, kind)
            }
            "method_signature" => {
                let n = Self::find_child_text(node, source, "identifier").or_else(|| {
                    let mut cursor = node.walk();
                    for child in node.children(&mut cursor) {
                        if matches!(
                            child.kind(),
                            "function_signature" | "getter_signature" | "setter_signature"
                        ) {
                            if let Some(name) = Self::find_child_text(&child, source, "identifier") {
                                return Some(name);
                            }
                        }
                    }
                    None
                })?;
                (n, SymbolKind::Method)
            }
            "function_signature" => {
                // Top-level function (when not inside method_signature)
                if node.parent().map_or(false, |p| p.kind() == "method_signature") {
                    return None;
                }
                let n = Self::find_child_text(node, source, "identifier")
                    .or_else(|| Self::find_child_text(node, source, "type_identifier"))?;
                (n, SymbolKind::Function)
            }
            "constructor_signature" | "factory_constructor_signature" => {
                let n = Self::find_child_text(node, source, "identifier")?;
                (n, SymbolKind::Method)
            }
            _ => return None,
        };
        let complexity = if matches!(kind, SymbolKind::Function | SymbolKind::Method) {
            Some(Self::calculate_complexity(node))
        } else {
            None
        };
        Some(ParsedSymbol {
            name,
            kind,
            line: start_line,
            end_line: Some(end_line),
            scope_id: None,
            signature: None,
            complexity,
            body_preview: None,
            metadata: SymbolMetadata {
                parameters: None,
                return_type: None,
                visibility: None,
                modifiers: None,
                parent_symbol: parent.map(String::from),
                extends: None,
                implements: None,
            },
        })
    }

    /// Get text content of a node
    fn get_node_text(node: &Node, source: &str) -> Option<String> {
        let start_byte = node.start_byte();
        let end_byte = node.end_byte();
        source.get(start_byte..end_byte).map(String::from)
    }

    /// Find the first direct child of a given kind and return its text
    fn find_child_text(node: &Node, source: &str, child_kind: &str) -> Option<String> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == child_kind {
                return Self::get_node_text(&child, source);
            }
        }
        None
    }

    /// Extract variable name from a variable/lexical declaration.
    /// Returns None for destructuring patterns (object_pattern, array_pattern).
    fn get_variable_name(node: &Node, source: &str) -> Option<String> {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "variable_declarator" {
                let mut inner = child.walk();
                for inner_child in child.children(&mut inner) {
                    if inner_child.kind() == "identifier" {
                        return Self::get_node_text(&inner_child, source);
                    }
                }
                // Destructuring or complex pattern — skip
                return None;
            }
        }
        None
    }

    /// Detect if a variable/lexical declaration's initializer is a function.
    /// Returns Function for arrow functions and function expressions, Variable otherwise.
    fn detect_variable_function_kind(node: &Node) -> SymbolKind {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "variable_declarator" {
                let mut inner = child.walk();
                for inner_child in child.children(&mut inner) {
                    match inner_child.kind() {
                        "arrow_function" | "function" | "function_expression" => {
                            return SymbolKind::Function;
                        }
                        "class" | "class_expression" => {
                            return SymbolKind::Class;
                        }
                        _ => {}
                    }
                }
            }
        }
        SymbolKind::Variable
    }

    /// Walk a chain of node kinds to find a nested identifier.
    /// E.g., ["function_declarator", "identifier"] finds the identifier inside a function_declarator.
    fn find_nested_identifier(node: &Node, source: &str, path: &[&str]) -> Option<String> {
        if path.is_empty() {
            return Self::get_node_text(node, source);
        }
        let target_kind = path[0];
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == target_kind {
                if path.len() == 1 {
                    return Self::get_node_text(&child, source);
                }
                return Self::find_nested_identifier(&child, source, &path[1..]);
            }
        }
        // Also search one level deeper (for C declarator nesting)
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if let Some(found) = Self::find_nested_identifier(&child, source, path) {
                return Some(found);
            }
        }
        None
    }

    /// Find a function name in macro-wrapped C declarations.
    /// Scans all descendant identifiers for one immediately followed by a parameter_list sibling.
    /// Handles patterns like: CJSON_PUBLIC(cJSON *) cJSON_Parse(const char *value)
    fn find_identifier_before_params(node: &Node, source: &str) -> Option<String> {
        fn scan(node: &Node, source: &str) -> Option<String> {
            let child_count = node.child_count();
            for i in 0..child_count {
                if let Some(child) = node.child(i) {
                    if (child.kind() == "identifier" || child.kind() == "field_identifier")
                        && i + 1 < child_count
                    {
                        if let Some(next) = node.child(i + 1) {
                            if next.kind() == "parameter_list" || next.kind() == "argument_list" {
                                if let Some(text) = SymbolExtractor::get_node_text(&child, source) {
                                    let trimmed = text.trim();
                                    // Skip macro names (typically ALL_CAPS with underscores)
                                    if !trimmed.is_empty()
                                        && !trimmed.chars().all(|c| c.is_uppercase() || c == '_')
                                    {
                                        return Some(trimmed.to_string());
                                    }
                                }
                            }
                        }
                    }
                    // Recurse into children
                    if let Some(found) = scan(&child, source) {
                        return Some(found);
                    }
                }
            }
            None
        }
        scan(node, source)
    }

    /// Check if a node has a descendant of the given kind
    fn has_descendant_kind(node: &Node, kind: &str) -> bool {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == kind {
                return true;
            }
            if Self::has_descendant_kind(&child, kind) {
                return true;
            }
        }
        false
    }

    /// Extract function/method signature
    fn extract_signature(node: &Node, source: &str) -> String {
        let mut cursor = node.walk();
        let mut parts: Vec<String> = Vec::new();

        for child in node.children(&mut cursor) {
            match child.kind() {
                // TS/JS: formal_parameters (x, y), parameters
                "formal_parameters" | "parameters" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        parts.push(text);
                    }
                }
                // Rust: function parameters list
                "parameter" | "self_parameter" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        parts.push(text);
                    }
                }
                // Return type annotations (TS: type_annotation, Rust: return type after ->)
                "type_annotation" | "return_type" => {
                    if let Some(text) = Self::get_node_text(&child, source) {
                        parts.push(text);
                    }
                }
                _ => {}
            }
        }

        // If we found parts, join them into a signature string
        if !parts.is_empty() {
            return parts.join(" ");
        }

        // Fallback: extract first line of the node as a rough signature
        if let Some(text) = Self::get_node_text(&node, source) {
            let first_line = text.lines().next().unwrap_or("");
            // Trim to a reasonable length for signature comparison
            if first_line.len() <= 200 {
                return first_line.to_string();
            }
            return first_line[..200].to_string();
        }

        String::new()
    }

    /// Calculate cyclomatic complexity for a function/method node
    /// 
    /// Cyclomatic complexity = 1 + number of decision points
    /// Decision points: if, else if, for, while, do, case, catch, &&, ||, ternary
    fn calculate_complexity(node: &Node) -> u32 {
        let mut complexity: u32 = 1; // Base complexity
        Self::count_complexity_recursive(node, &mut complexity);
        complexity
    }

    /// Recursively count complexity decision points
    fn count_complexity_recursive(node: &Node, complexity: &mut u32) {
        let node_kind = node.kind();
        
        // Count decision points based on node type
        match node_kind {
            // Conditional statements (covers JS/TS, Go, Rust, Java, C, C++, C#, Python)
            "if_statement" | "if_expression" | "if_let_expression" => *complexity += 1,
            // Python elif is a separate node, not nested if inside else
            "elif_clause" => *complexity += 1,
            "else_clause" => {
                // Only count "else if" as additional complexity (not plain else)
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    if child.kind() == "if_statement" || child.kind() == "if_expression" {
                        break;
                    }
                }
            }
            
            // Loops (all languages)
            "for_statement" | "for_in_statement" | "for_of_statement" => *complexity += 1,
            // Go range, Java enhanced-for, Python for-in, C# foreach
            "for_range_statement" | "enhanced_for_statement" | "for_each_statement" => *complexity += 1,
            "while_statement" | "while_expression" => *complexity += 1,
            "do_statement" => *complexity += 1,
            // Rust loop {}
            "loop_expression" => *complexity += 1,
            
            // Switch/match cases (all languages)
            "switch_case" | "case_clause" | "match_arm" => *complexity += 1,
            // Go select/type-switch cases
            "expression_case" | "type_case" | "communication_case" | "default_case" => *complexity += 1,
            
            // Exception handling
            "catch_clause" | "except_clause" => *complexity += 1,
            
            // Ternary/conditional expressions
            "ternary_expression" | "conditional_expression" => *complexity += 1,
            
            // Logical operators (short-circuit evaluation creates branches)
            "binary_expression" | "boolean_operator" => {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    let child_kind = child.kind();
                    if child_kind == "&&" || child_kind == "||" 
                       || child_kind == "and" || child_kind == "or" {
                        *complexity += 1;
                    }
                }
            }
            
            // Null coalescing (??), optional chaining (?.) - count as decision points
            "nullish_coalescing_expression" | "optional_chain_expression" => *complexity += 1,
            
            // Python comprehension conditions (if inside list/dict/set comprehension)
            "if_clause" => *complexity += 1,
            
            // Go defer/go with error paths, Rust ? operator
            "try_expression" => *complexity += 1,
            
            _ => {}
        }
        
        // Recurse into children
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            Self::count_complexity_recursive(&child, complexity);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::create_parser;
    use crate::types::Language;

    // ── TypeScript / JavaScript ────────────────────────────────────────

    #[test]
    fn test_ts_functions_and_variables() {
        let mut parser = create_parser(Language::TypeScript).unwrap();
        let source = r#"function greet(name: string): void {}
const API_URL = "https://example.com";
let count = 0;
class MyService {
    doWork() {}
}
interface Config {
    port: number;
}
type ID = string;
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::TypeScript);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"greet"), "Missing function 'greet', got {:?}", names);
        assert!(names.contains(&"API_URL"), "Missing variable 'API_URL', got {:?}", names);
        assert!(names.contains(&"count"), "Missing variable 'count', got {:?}", names);
        assert!(names.contains(&"MyService"), "Missing class 'MyService', got {:?}", names);
        assert!(names.contains(&"doWork"), "Missing method 'doWork', got {:?}", names);
        assert!(names.contains(&"Config"), "Missing interface 'Config', got {:?}", names);
        assert!(names.contains(&"ID"), "Missing type 'ID', got {:?}", names);
    }

    #[test]
    fn test_ts_export_statement() {
        let mut parser = create_parser(Language::TypeScript).unwrap();
        let source = "export function helper() {}\nexport const MAX = 100;\n";
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::TypeScript);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"helper"), "Missing exported function 'helper', got {:?}", names);
        assert!(names.contains(&"MAX"), "Missing exported const 'MAX', got {:?}", names);
    }

    #[test]
    fn test_js_default_export() {
        // Test anonymous default export: `export default function(...) { ... }`
        let mut parser = create_parser(Language::JavaScript).unwrap();
        let source = "export default function(str, options) {\n  return str.length > 0;\n}\n";
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::JavaScript);

        let default_sym = symbols.iter().find(|s| s.name == "default");
        assert!(default_sym.is_some(), "Anonymous default export should be indexed as 'default', got: {:?}",
            symbols.iter().map(|s| &s.name).collect::<Vec<_>>());
        let ds = default_sym.unwrap();
        assert_eq!(ds.kind, SymbolKind::Function);
        let mods = ds.metadata.modifiers.as_ref().unwrap();
        assert!(mods.contains(&"export".to_string()), "Should have 'export' modifier");
        assert!(mods.contains(&"default".to_string()), "Should have 'default' modifier");

        // Test named default export: `export default function isEmail(...) { ... }`
        let source2 = "export default function isEmail(str) {\n  return true;\n}\n";
        let tree2 = parser.parse(source2, None).unwrap();
        let symbols2 = SymbolExtractor::extract_symbols(&tree2, source2, Language::JavaScript);

        let named_sym = symbols2.iter().find(|s| s.name == "isEmail");
        assert!(named_sym.is_some(), "Named default export should be indexed as 'isEmail', got: {:?}",
            symbols2.iter().map(|s| &s.name).collect::<Vec<_>>());
        let ns = named_sym.unwrap();
        let mods2 = ns.metadata.modifiers.as_ref().unwrap();
        assert!(mods2.contains(&"default".to_string()), "Named default export should have 'default' modifier");
    }

    #[test]
    fn test_js_class_expression_in_variable() {
        let mut parser = create_parser(Language::JavaScript).unwrap();
        let source = r#"const MyClass = class {
  constructor() {}
  doStuff() { return 1; }
};
const helper = () => 42;
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::JavaScript);

        let cls = symbols.iter().find(|s| s.name == "MyClass");
        assert!(cls.is_some(), "Class expression 'MyClass' should be indexed, got: {:?}",
            symbols.iter().map(|s| (&s.name, &s.kind)).collect::<Vec<_>>());
        assert_eq!(cls.unwrap().kind, SymbolKind::Class, "MyClass should be Class kind");

        let helper = symbols.iter().find(|s| s.name == "helper");
        assert!(helper.is_some(), "Arrow function 'helper' should be indexed");
        assert_eq!(helper.unwrap().kind, SymbolKind::Function, "helper should be Function kind");
    }

    // ── Python ─────────────────────────────────────────────────────────

    #[test]
    fn test_python_functions_classes_variables() {
        let mut parser = create_parser(Language::Python).unwrap();
        let source = r#"MAX_SIZE = 100
name = "world"

def greet(n):
    pass

class Handler:
    pass
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Python);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"greet"), "Missing function 'greet', got {:?}", names);
        assert!(names.contains(&"Handler"), "Missing class 'Handler', got {:?}", names);
        assert!(names.contains(&"MAX_SIZE"), "Missing constant 'MAX_SIZE', got {:?}", names);
        assert!(names.contains(&"name"), "Missing variable 'name', got {:?}", names);

        // Verify constant vs variable kind
        let max_sym = symbols.iter().find(|s| s.name == "MAX_SIZE").unwrap();
        assert_eq!(max_sym.kind, SymbolKind::Constant, "MAX_SIZE should be Constant");
        let name_sym = symbols.iter().find(|s| s.name == "name").unwrap();
        assert_eq!(name_sym.kind, SymbolKind::Variable, "name should be Variable");
    }

    // ── Rust ───────────────────────────────────────────────────────────

    #[test]
    fn test_rust_symbols() {
        let mut parser = create_parser(Language::Rust).unwrap();
        let source = r#"const MAX: u32 = 100;
static COUNTER: u32 = 0;
type Result<T> = std::result::Result<T, Error>;

fn process() {}

struct Config {
    port: u16,
}

enum Status {
    Active,
    Inactive,
}

trait Handler {
    fn handle(&self);
}

impl Config {
    fn new() -> Self { Config { port: 8080 } }
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Rust);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"MAX"), "Missing const 'MAX', got {:?}", names);
        assert!(names.contains(&"COUNTER"), "Missing static 'COUNTER', got {:?}", names);
        assert!(names.contains(&"process"), "Missing function 'process', got {:?}", names);
        assert!(names.contains(&"Config"), "Missing struct 'Config', got {:?}", names);
        assert!(names.contains(&"Status"), "Missing enum 'Status', got {:?}", names);
        assert!(names.contains(&"Handler"), "Missing trait 'Handler', got {:?}", names);

        let max_sym = symbols.iter().find(|s| s.name == "MAX").unwrap();
        assert_eq!(max_sym.kind, SymbolKind::Constant, "MAX should be Constant");
    }

    #[test]
    fn test_rust_generic_struct_indexing() {
        let mut parser = create_parser(Language::Rust).unwrap();
        let source = r#"
pub struct StreamDeserializer<'de, R, T> {
    de: Deserializer<IoRead<R>>,
    output: PhantomData<T>,
    lifetime: PhantomData<&'de ()>,
}

pub struct Deserializer<R> {
    read: R,
}

trait Visitor<'de> {
    type Value;
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>;
}

impl<'de, R: Read<'de>> Deserializer<R> {
    fn peek_invalid_type(&mut self, exp: &dyn Expected) -> Error {
        Error::invalid_type(Unexpected::Unit, exp)
    }
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Rust);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"StreamDeserializer"),
            "Missing generic struct 'StreamDeserializer', got {:?}", names);
        assert!(names.contains(&"Deserializer"),
            "Missing generic struct 'Deserializer', got {:?}", names);
        assert!(names.contains(&"Visitor"),
            "Missing trait 'Visitor', got {:?}", names);
        assert!(names.contains(&"peek_invalid_type"),
            "Missing impl method 'peek_invalid_type', got {:?}", names);

        let sd = symbols.iter().find(|s| s.name == "StreamDeserializer").unwrap();
        assert_eq!(sd.kind, SymbolKind::Struct, "StreamDeserializer should be Struct kind");
    }

    // ── Java ───────────────────────────────────────────────────────────

    #[test]
    fn test_java_symbols() {
        let mut parser = create_parser(Language::Java).unwrap();
        let source = r#"public class UserService {
    private String name;

    public void process() {
        System.out.println("hello");
    }
}

interface Repository {
    void save();
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Java);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"UserService"), "Missing class 'UserService', got {:?}", names);
        assert!(names.contains(&"process"), "Missing method 'process', got {:?}", names);
        assert!(names.contains(&"Repository"), "Missing interface 'Repository', got {:?}", names);
        assert!(names.contains(&"name"), "Missing field 'name', got {:?}", names);
    }

    // ── Go ─────────────────────────────────────────────────────────────

    #[test]
    fn test_go_symbols() {
        let mut parser = create_parser(Language::Go).unwrap();
        let source = r#"package main

var globalCount int

func greet(name string) string {
    return "hello " + name
}

type Config struct {
    Port int
}

type Reader interface {
    Read(p []byte) (n int, err error)
}

func (c *Config) Validate() error {
    return nil
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Go);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"greet"), "Missing function 'greet', got {:?}", names);
        assert!(names.contains(&"Config"), "Missing type 'Config', got {:?}", names);
        assert!(names.contains(&"Validate"), "Missing method 'Validate', got {:?}", names);
        assert!(names.contains(&"Reader"), "Missing interface 'Reader', got {:?}", names);

        let config = symbols.iter().find(|s| s.name == "Config").unwrap();
        assert_eq!(config.kind, SymbolKind::Struct, "Config should be Struct, got {:?}", config.kind);

        let reader = symbols.iter().find(|s| s.name == "Reader").unwrap();
        assert_eq!(reader.kind, SymbolKind::Interface, "Reader should be Interface, got {:?}", reader.kind);
    }

    // ── C ──────────────────────────────────────────────────────────────

    #[test]
    fn test_c_symbols() {
        // C uses the C++ parser in tree-sitter
        let mut parser = create_parser(Language::C).unwrap();
        let source = r#"#include <stdio.h>

struct Config {
    int port;
};

enum Status { ACTIVE, INACTIVE };

void process(int x) {
    printf("%d\n", x);
}

int main() {
    process(42);
    return 0;
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::C);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"process"), "Missing function 'process', got {:?}", names);
        assert!(names.contains(&"main"), "Missing function 'main', got {:?}", names);
        assert!(names.contains(&"Config"), "Missing struct 'Config', got {:?}", names);
        assert!(names.contains(&"Status"), "Missing enum 'Status', got {:?}", names);
    }

    // ── C++ ────────────────────────────────────────────────────────────

    #[test]
    fn test_cpp_symbols() {
        let mut parser = create_parser(Language::Cpp).unwrap();
        let source = r#"#include <iostream>

namespace mylib {

class Widget {
public:
    void render() {}
};

}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Cpp);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"mylib"), "Missing namespace 'mylib', got {:?}", names);
        assert!(names.contains(&"Widget"), "Missing class 'Widget', got {:?}", names);
        assert!(names.contains(&"render"), "Missing method (function) 'render', got {:?}", names);
    }

    // ── C# ─────────────────────────────────────────────────────────────

    #[test]
    fn test_csharp_symbols() {
        let mut parser = create_parser(Language::CSharp).unwrap();
        let source = r#"using System;

namespace MyApp {
    public class UserService {
        private string _name;

        public void Process() {
            Console.WriteLine("hello");
        }
    }

    public interface IRepository {
        void Save();
    }

    public struct Point {
        public int X;
        public int Y;
    }

    public enum Color {
        Red,
        Green,
        Blue
    }
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::CSharp);
        let names: Vec<&str> = symbols.iter().map(|s| s.name.as_str()).collect();

        assert!(names.contains(&"UserService"), "Missing class 'UserService', got {:?}", names);
        assert!(names.contains(&"Process"), "Missing method 'Process', got {:?}", names);
        assert!(names.contains(&"IRepository"), "Missing interface 'IRepository', got {:?}", names);
        assert!(names.contains(&"Point"), "Missing struct 'Point', got {:?}", names);
        assert!(names.contains(&"Color"), "Missing enum 'Color', got {:?}", names);
    }

    // ── Trait/Interface awareness tests ─────────────────────────────────

    #[test]
    fn test_rust_trait_impl_populates_implements() {
        let mut parser = create_parser(Language::Rust).unwrap();
        let source = r#"
use std::io;

struct MyWriter;

impl io::Write for MyWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl MyWriter {
    fn new() -> Self { MyWriter }
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Rust);

        // Methods inside the trait impl should have `implements` propagated from the impl block.
        // The impl block itself is NOT stored (prevents shadowing the type name).
        let write_method = symbols.iter().find(|s| s.name == "write");
        assert!(write_method.is_some(), "Should find 'write' method, got symbols: {:?}",
            symbols.iter().map(|s| (&s.name, &s.kind, &s.metadata.implements)).collect::<Vec<_>>());
        let wm = write_method.unwrap();
        let impls = wm.metadata.implements.as_ref();
        assert!(impls.is_some(), "write method should have implements metadata");
        assert!(impls.unwrap().iter().any(|i| i.contains("Write")),
            "Should detect io::Write trait, got {:?}", impls);

        // Methods inside the inherent impl should NOT have implements
        let new_method = symbols.iter().find(|s| s.name == "new");
        assert!(new_method.is_some(), "Should find 'new' method from inherent impl");
        assert!(new_method.unwrap().metadata.implements.is_none(),
            "Inherent impl method should NOT have implements");
    }

    #[test]
    fn test_go_method_populates_implements_for_known_interfaces() {
        let mut parser = create_parser(Language::Go).unwrap();
        let source = r#"package main

import "io"

type MyWriter struct{}

func (w *MyWriter) Write(p []byte) (int, error) {
    return len(p), nil
}

func (w *MyWriter) Close() error {
    return nil
}

func (w *MyWriter) CustomMethod() string {
    return "hello"
}
"#;
        let tree = parser.parse(source, None).unwrap();
        let symbols = SymbolExtractor::extract_symbols(&tree, source, Language::Go);

        // Write should be tagged with io.Writer
        let write_sym = symbols.iter().find(|s| s.name == "Write").unwrap();
        assert!(write_sym.metadata.implements.is_some(),
            "Write method should have implements metadata");
        let write_impls = write_sym.metadata.implements.as_ref().unwrap();
        assert!(write_impls.contains(&"io.Writer".to_string()),
            "Write should implement io.Writer, got {:?}", write_impls);

        // Close should be tagged with io.Closer
        let close_sym = symbols.iter().find(|s| s.name == "Close").unwrap();
        assert!(close_sym.metadata.implements.is_some(),
            "Close method should have implements metadata");
        let close_impls = close_sym.metadata.implements.as_ref().unwrap();
        assert!(close_impls.contains(&"io.Closer".to_string()),
            "Close should implement io.Closer, got {:?}", close_impls);

        // CustomMethod should NOT have implements
        let custom_sym = symbols.iter().find(|s| s.name == "CustomMethod").unwrap();
        assert!(custom_sym.metadata.implements.is_none(),
            "CustomMethod should not have implements metadata");

        // Write should have MyWriter as parent_symbol (receiver type)
        assert_eq!(write_sym.metadata.parent_symbol.as_deref(), Some("MyWriter"),
            "Write receiver type should be MyWriter");
    }
}
