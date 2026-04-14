use serde::{Deserialize, Serialize};

/// Symbol kind — unified taxonomy covering UHPP's 26 canonical symbol kinds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SymbolKind {
    Function,
    Method,
    Class,
    Interface,
    Struct,
    Enum,
    Variable,
    Constant,
    Field,
    Property,
    Module,
    Namespace,
    Type,
    Record,
    Protocol,
    Extension,
    Mixin,
    Impl,
    Macro,
    Constructor,
    EnumMember,
    Operator,
    Event,
    Object,
    Actor,
    Union,
    Unknown,
}

impl SymbolKind {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "function" | "fn" => Self::Function,
            "method" => Self::Method,
            "class" | "cls" => Self::Class,
            "interface" => Self::Interface,
            "struct" => Self::Struct,
            "enum" => Self::Enum,
            "variable" => Self::Variable,
            "constant" | "const" => Self::Constant,
            "field" => Self::Field,
            "property" => Self::Property,
            "module" | "mod" => Self::Module,
            "namespace" | "ns" => Self::Namespace,
            "type" => Self::Type,
            "record" => Self::Record,
            "protocol" => Self::Protocol,
            "extension" => Self::Extension,
            "mixin" => Self::Mixin,
            "impl" => Self::Impl,
            "macro" => Self::Macro,
            "constructor" | "ctor" => Self::Constructor,
            "enum_member" | "variant" => Self::EnumMember,
            "operator" => Self::Operator,
            "event" => Self::Event,
            "object" => Self::Object,
            "actor" => Self::Actor,
            "union" => Self::Union,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Method => "method",
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::Variable => "variable",
            Self::Constant => "constant",
            Self::Field => "field",
            Self::Property => "property",
            Self::Module => "module",
            Self::Namespace => "namespace",
            Self::Type => "type",
            Self::Record => "record",
            Self::Protocol => "protocol",
            Self::Extension => "extension",
            Self::Mixin => "mixin",
            Self::Impl => "impl",
            Self::Macro => "macro",
            Self::Constructor => "constructor",
            Self::EnumMember => "enum_member",
            Self::Operator => "operator",
            Self::Event => "event",
            Self::Object => "object",
            Self::Actor => "actor",
            Self::Union => "union",
            Self::Unknown => "unknown",
        }
    }

    /// Map a UHPP symbol kind string (from UHPP_SYMBOL_KINDS) to SymbolKind.
    pub fn from_uhpp_kind(kind: &str) -> Self {
        match kind {
            "fn" => Self::Function,
            "cls" | "class" => Self::Class,
            "struct" => Self::Struct,
            "trait" | "interface" => Self::Interface,
            "protocol" => Self::Protocol,
            "enum" => Self::Enum,
            "record" => Self::Record,
            "extension" => Self::Extension,
            "mixin" => Self::Mixin,
            "impl" => Self::Impl,
            "type" => Self::Type,
            "const" => Self::Constant,
            "static" => Self::Variable,
            "mod" | "ns" | "namespace" | "package" => Self::Module,
            "macro" => Self::Macro,
            "ctor" => Self::Constructor,
            "property" => Self::Property,
            "field" => Self::Field,
            "enum_member" | "variant" => Self::EnumMember,
            "operator" => Self::Operator,
            "event" => Self::Event,
            "object" => Self::Object,
            "actor" => Self::Actor,
            "union" => Self::Union,
            _ => Self::Unknown,
        }
    }
}

/// Symbol visibility
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SymbolVisibility {
    Public,
    Private,
    Protected,
    Internal,
    Package,
}

/// Symbol parameter
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolParameter {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

/// Symbol metadata (stored as JSON in database)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<SymbolParameter>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<SymbolVisibility>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modifiers: Option<Vec<String>>, // e.g., ['static', 'async', 'abstract', 'readonly']
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_symbol: Option<String>, // For nested symbols (e.g., class methods)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extends: Option<Vec<String>>, // Classes/interfaces this extends
    #[serde(skip_serializing_if = "Option::is_none")]
    pub implements: Option<Vec<String>>, // Interfaces this implements
}

/// Display name including enclosing scope when `parent_symbol` is known (e.g. `UserService.validateEmail`).
#[must_use]
pub fn format_qualified_symbol_name(symbol: &str, parent_symbol: Option<&str>) -> String {
    match parent_symbol {
        Some(p) if !p.trim().is_empty() => format!("{}.{}", p.trim(), symbol),
        _ => symbol.to_string(),
    }
}

/// Parsed symbol from AST
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedSymbol {
    pub name: String,
    pub kind: SymbolKind,
    pub line: u32,
    /// End line of the symbol (for classes, functions, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Scope ID (for nested symbols)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    /// Function/method signature
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Cyclomatic complexity
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complexity: Option<u32>,
    /// First ~20 lines of function body for FTS indexing
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_preview: Option<String>,
    /// Enhanced symbol information
    #[serde(flatten)]
    pub metadata: SymbolMetadata,
}

/// Symbol stored in database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    /// Database ID
    pub id: i64,
    /// File ID (foreign key to files table)
    pub file_id: i64,
    pub name: String,
    pub kind: SymbolKind,
    pub line: u32,
    /// Scope ID (for nested symbols)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<i64>,
    /// Rank score (for search relevance)
    pub rank: f64,
    /// Function/method signature
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    /// Cyclomatic complexity
    pub complexity: u32,
    /// Metadata (JSON: parameters, returnType, visibility, modifiers, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<SymbolMetadata>,
}

impl From<ParsedSymbol> for Symbol {
    fn from(parsed: ParsedSymbol) -> Self {
        Self {
            id: 0, // Will be set by database
            file_id: 0, // Will be set when inserting
            name: parsed.name,
            kind: parsed.kind,
            line: parsed.line,
            scope_id: None, // Will be resolved during indexing
            rank: 0.0,
            signature: parsed.signature,
            complexity: parsed.complexity.unwrap_or(0),
            metadata: Some(parsed.metadata),
        }
    }
}

/// Symbol relation type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SymbolRelationType {
    Calls,
    Uses,
    Inherits,
}

/// Symbol relation stored in database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolRelation {
    pub id: i64,
    pub from_symbol_id: i64,
    pub to_symbol_id: i64,
    pub relation_type: SymbolRelationType,
}
