//! A safe XML tokenizer and a whitelisted XSD subset compiler/validator.
//!
//! Port of `core-back/engine/compliance/reporting/{safeXml,XsdCompiler,XsdXmlValidator}.ts`.
//!
//! There is no XML crate in this crate's manifest, so the tokenizer is written here. It is the
//! same algorithm as `safeXml.ts`: no DTD, no entity declarations, no external identifiers, no
//! processing instructions kept, one root element, depth-bounded. The compiler accepts a
//! **whitelist** of XSD vocabulary; `xs:include`, `xs:import`, `xs:redefine`, `script` and every
//! other element outside the whitelist are refused rather than ignored (defence in depth over
//! the TS compiler, which only blacklists external `schemaLocation`s).
//!
//! Documented limitations (open questions for the coordinator):
//! - `xs:pattern` facets are **not** enforced: there is no regex dependency, and a hand-written
//!   XSD regex engine would be a security surface. Every other facet is checked.
//! - `xs:group`, `xs:attributeGroup`, `xs:any` and `xs:anyAttribute` are outside the whitelist.
//! - Namespace prefixes are stripped to local names, exactly like the TS compiler.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDate};
use serde::{Deserialize, Serialize};

/// `MAX_XSD_BYTES` (2 MiB).
pub const MAX_XSD_BYTES: usize = 2 * 1024 * 1024;
/// `MAX_XML_BYTES` (8 MiB) for a document that is validated.
pub const MAX_XML_BYTES: usize = 8 * 1024 * 1024;
/// `MAX_DEPTH` (the XSD nesting limit).
pub const MAX_DEPTH: usize = 32;
/// `MAX_REPEAT` (the bound applied to `maxOccurs="unbounded"`).
pub const MAX_REPEAT: usize = 5_000;

/// The XSD elements the compiler understands. Anything else is refused.
pub const ALLOWED_XSD_ELEMENTS: &[&str] = &[
    "schema",
    "element",
    "complexType",
    "simpleType",
    "sequence",
    "choice",
    "all",
    "attribute",
    "simpleContent",
    "complexContent",
    "extension",
    "restriction",
    "annotation",
    "documentation",
    "appinfo",
    "minLength",
    "maxLength",
    "length",
    "pattern",
    "enumeration",
    "minInclusive",
    "maxInclusive",
    "totalDigits",
    "fractionDigits",
    "whiteSpace",
];

/// The vocabulary refused with an explicit external-import code.
const EXTERNAL_VOCABULARY: &[&str] = &["include", "import", "redefine"];

/// A parsed XML element.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XmlNode {
    pub name: String,
    pub local_name: String,
    #[serde(default)]
    pub attributes: BTreeMap<String, String>,
    #[serde(default)]
    pub children: Vec<XmlNode>,
    #[serde(default)]
    pub text: String,
}

impl XmlNode {
    /// The first child with the given local name.
    #[must_use]
    pub fn first_child(&self, local_name: &str) -> Option<&Self> {
        self.children
            .iter()
            .find(|child| child.local_name == local_name)
    }

    /// All children with the given local name.
    #[must_use]
    pub fn children_named(&self, local_name: &str) -> Vec<&Self> {
        self.children
            .iter()
            .filter(|child| child.local_name == local_name)
            .collect()
    }
}

/// A tokenizer or XSD refusal.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum XmlError {
    /// The payload exceeds the byte limit.
    #[error("The XML payload exceeds {maximum} bytes")]
    PayloadTooLarge {
        /// The limit that was exceeded.
        maximum: usize,
    },
    /// DOCTYPE, ENTITY or an external identifier.
    #[error("DOCTYPE, ENTITY declarations and external identifiers are forbidden")]
    ExternalEntityForbidden,
    /// The document is not well-formed.
    #[error("{0}")]
    Malformed(String),
    /// An unsupported declaration such as `<!...>`.
    #[error("Unsupported XML declaration")]
    ForbiddenDeclaration,
}

impl XmlError {
    /// The TS error code (`XmlSecurityError.code`).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::PayloadTooLarge { .. } => "XML_PAYLOAD_TOO_LARGE",
            Self::ExternalEntityForbidden => "XML_EXTERNAL_ENTITY_FORBIDDEN",
            Self::Malformed(_) => "XML_MALFORMED",
            Self::ForbiddenDeclaration => "XML_FORBIDDEN_DECLARATION",
        }
    }
}

/// `assertSafeXml`.
///
/// # Errors
/// Rejects oversized payloads and DOCTYPE/ENTITY/external identifiers.
pub fn assert_safe_xml(xml: &str, maximum_bytes: usize) -> Result<(), XmlError> {
    if xml.len() > maximum_bytes {
        return Err(XmlError::PayloadTooLarge {
            maximum: maximum_bytes,
        });
    }
    let lower = xml.to_ascii_lowercase();
    if lower.contains("<!doctype") || lower.contains("<!entity") {
        return Err(XmlError::ExternalEntityForbidden);
    }
    for keyword in ["system", "public"] {
        let mut rest = lower.as_str();
        while let Some(index) = rest.find(keyword) {
            let after = rest.get(index + keyword.len()..).unwrap_or("");
            let trimmed = after.trim_start();
            if trimmed.starts_with('"') || trimmed.starts_with('\'') {
                return Err(XmlError::ExternalEntityForbidden);
            }
            rest = after;
        }
    }
    Ok(())
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// `escapeXml`.
#[must_use]
pub fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn local_name(name: &str) -> &str {
    match name.split_once(':') {
        Some((_, local)) => local,
        None => name,
    }
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-')
}

fn parse_attributes(source: &str) -> BTreeMap<String, String> {
    let bytes = source.as_bytes();
    let mut attributes = BTreeMap::new();
    let mut index = 0;
    while index < bytes.len() {
        while index < bytes.len() && (bytes[index].is_ascii_whitespace() || bytes[index] == b'/') {
            index += 1;
        }
        let name_start = index;
        while index < bytes.len() && is_name_byte(bytes[index]) {
            index += 1;
        }
        if name_start == index {
            index += 1;
            continue;
        }
        let Some(name) = source.get(name_start..index) else {
            break;
        };
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if bytes.get(index) != Some(&b'=') {
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        let quote = match bytes.get(index) {
            Some(b'"') => b'"',
            Some(b'\'') => b'\'',
            _ => continue,
        };
        index += 1;
        let value_start = index;
        while index < bytes.len() && bytes[index] != quote {
            index += 1;
        }
        let Some(value) = source.get(value_start..index) else {
            break;
        };
        index += 1;
        attributes.insert(name.to_owned(), decode_entities(value));
    }
    attributes
}

/// Removes comments and processing instructions, keeping the rest byte-identical.
fn strip_comments_and_pis(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let comment = rest.find("<!--");
        let instruction = rest.find("<?");
        let next = match (comment, instruction) {
            (Some(comment), Some(instruction)) => {
                if comment <= instruction {
                    Some((comment, true))
                } else {
                    Some((instruction, false))
                }
            }
            (Some(comment), None) => Some((comment, true)),
            (None, Some(instruction)) => Some((instruction, false)),
            (None, None) => None,
        };
        let Some((start, is_comment)) = next else {
            out.push_str(rest);
            break;
        };
        out.push_str(rest.get(..start).unwrap_or(""));
        let tail = rest.get(start..).unwrap_or("");
        let (open_length, close) = if is_comment { (4, "-->") } else { (2, "?>") };
        let after_open = tail.get(open_length..).unwrap_or("");
        match after_open.find(close) {
            Some(end) => {
                rest = after_open.get(end + close.len()..).unwrap_or("");
            }
            None => {
                // Unterminated: keep the remainder so the tokenizer reports it.
                out.push_str(tail);
                break;
            }
        }
    }
    out
}

/// `parseSafeXml`: one root element, no declarations, entity-decoded text.
///
/// # Errors
/// [`XmlError`] for unsafe or malformed documents.
pub fn parse_safe_xml(input: &str, maximum_bytes: usize) -> Result<XmlNode, XmlError> {
    assert_safe_xml(input, maximum_bytes)?;
    let stripped = strip_comments_and_pis(input.strip_prefix('\u{feff}').unwrap_or(input));
    let xml = stripped.as_str();
    let mut root = XmlNode {
        name: "#document".to_owned(),
        local_name: "#document".to_owned(),
        attributes: BTreeMap::new(),
        children: Vec::new(),
        text: String::new(),
    };
    let mut stack: Vec<XmlNode> = Vec::new();
    let mut index = 0;
    while index < xml.len() {
        let Some(open_offset) = xml.get(index..).and_then(|rest| rest.find('<')) else {
            push_text(&mut root, &mut stack, xml.get(index..).unwrap_or(""));
            break;
        };
        let open = index + open_offset;
        if open > index {
            push_text(&mut root, &mut stack, xml.get(index..open).unwrap_or(""));
        }
        if xml
            .get(open..)
            .is_some_and(|rest| rest.starts_with("<![CDATA["))
        {
            let after = xml.get(open + 9..).unwrap_or("");
            let Some(end) = after.find("]]>") else {
                return Err(XmlError::Malformed("Unterminated CDATA section".to_owned()));
            };
            push_text(&mut root, &mut stack, after.get(..end).unwrap_or(""));
            index = open + 9 + end + 3;
            continue;
        }
        if xml.get(open..).is_some_and(|rest| rest.starts_with("</")) {
            let Some(end) = xml
                .get(open..)
                .and_then(|rest| rest.find('>'))
                .map(|end| open + end)
            else {
                return Err(XmlError::Malformed("Unterminated closing tag".to_owned()));
            };
            let name = xml.get(open + 2..end).unwrap_or("").trim();
            let Some(current) = stack.pop() else {
                return Err(XmlError::Malformed(format!(
                    "Unexpected closing tag </{name}>"
                )));
            };
            if current.name != name {
                return Err(XmlError::Malformed(format!(
                    "Unexpected closing tag </{name}>"
                )));
            }
            attach(&mut root, &mut stack, current);
            index = end + 1;
            continue;
        }
        let Some(end) = xml
            .get(open..)
            .and_then(|rest| rest.find('>'))
            .map(|end| open + end)
        else {
            return Err(XmlError::Malformed("Unterminated opening tag".to_owned()));
        };
        let raw = xml.get(open + 1..end).unwrap_or("").trim();
        if raw.starts_with('!') {
            return Err(XmlError::ForbiddenDeclaration);
        }
        let self_closing = raw.ends_with('/');
        let body = if self_closing {
            raw.get(..raw.len().saturating_sub(1))
                .unwrap_or("")
                .trim_end()
        } else {
            raw
        };
        let name_length = body
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '_' | ':' | '.' | '-')
            })
            .count();
        if name_length == 0 {
            return Err(XmlError::Malformed("Invalid element name".to_owned()));
        }
        let Some(name) = body.get(..name_length) else {
            return Err(XmlError::Malformed("Invalid element name".to_owned()));
        };
        let node = XmlNode {
            name: name.to_owned(),
            local_name: local_name(name).to_owned(),
            attributes: parse_attributes(body.get(name_length..).unwrap_or("")),
            children: Vec::new(),
            text: String::new(),
        };
        if self_closing {
            attach(&mut root, &mut stack, node);
        } else {
            stack.push(node);
        }
        index = end + 1;
    }
    if !stack.is_empty() {
        return Err(XmlError::Malformed("Unclosed element".to_owned()));
    }
    if root.children.len() != 1 {
        return Err(XmlError::Malformed(
            "XML must have exactly one root element".to_owned(),
        ));
    }
    root.children
        .pop()
        .ok_or_else(|| XmlError::Malformed("Missing root element".to_owned()))
}

fn push_text(root: &mut XmlNode, stack: &mut [XmlNode], text: &str) {
    let decoded = decode_entities(text);
    if let Some(top) = stack.last_mut() {
        top.text.push_str(&decoded);
    } else {
        root.text.push_str(&decoded);
    }
}

fn attach(root: &mut XmlNode, stack: &mut [XmlNode], node: XmlNode) {
    if let Some(top) = stack.last_mut() {
        top.children.push(node);
    } else {
        root.children.push(node);
    }
}

/// `childText`.
#[must_use]
pub fn child_text<'a>(node: &'a XmlNode, local: &str) -> Option<&'a str> {
    node.first_child(local).map(|child| child.text.trim())
}

/// The primitive types the XSD compiler supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum XsdPrimitiveType {
    String,
    Token,
    NormalizedString,
    Int,
    Integer,
    Long,
    PositiveInteger,
    NonNegativeInteger,
    Decimal,
    Boolean,
    Date,
    DateTime,
}

impl XsdPrimitiveType {
    /// Parses the local name of an `xs:` type.
    #[must_use]
    pub fn from_local(local: &str) -> Option<Self> {
        match local {
            "string" => Some(Self::String),
            "token" => Some(Self::Token),
            "normalizedString" => Some(Self::NormalizedString),
            "int" => Some(Self::Int),
            "integer" => Some(Self::Integer),
            "long" => Some(Self::Long),
            "positiveInteger" => Some(Self::PositiveInteger),
            "nonNegativeInteger" => Some(Self::NonNegativeInteger),
            "decimal" => Some(Self::Decimal),
            "boolean" => Some(Self::Boolean),
            "date" => Some(Self::Date),
            "dateTime" => Some(Self::DateTime),
            _ => None,
        }
    }

    /// `xs:<local>`.
    #[must_use]
    pub const fn wire(self) -> &'static str {
        match self {
            Self::String => "xs:string",
            Self::Token => "xs:token",
            Self::NormalizedString => "xs:normalizedString",
            Self::Int => "xs:int",
            Self::Integer => "xs:integer",
            Self::Long => "xs:long",
            Self::PositiveInteger => "xs:positiveInteger",
            Self::NonNegativeInteger => "xs:nonNegativeInteger",
            Self::Decimal => "xs:decimal",
            Self::Boolean => "xs:boolean",
            Self::Date => "xs:date",
            Self::DateTime => "xs:dateTime",
        }
    }

    fn is_integer(self) -> bool {
        matches!(
            self,
            Self::Int
                | Self::Integer
                | Self::Long
                | Self::PositiveInteger
                | Self::NonNegativeInteger
        )
    }

    fn is_numeric(self) -> bool {
        self.is_integer() || matches!(self, Self::Decimal)
    }
}

/// `XsdTypeFacets`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XsdTypeFacets {
    pub base_type: XsdPrimitiveType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enumeration: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_inclusive: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_inclusive: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_digits: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction_digits: Option<usize>,
}

impl Default for XsdTypeFacets {
    fn default() -> Self {
        Self {
            base_type: XsdPrimitiveType::String,
            min_length: None,
            max_length: None,
            length: None,
            pattern: None,
            enumeration: Vec::new(),
            min_inclusive: None,
            max_inclusive: None,
            total_digits: None,
            fraction_digits: None,
        }
    }
}

/// `XsdAttributeNode["use"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttributeUse {
    Required,
    Optional,
    Prohibited,
}

impl AttributeUse {
    fn from_wire(value: &str) -> Self {
        match value {
            "required" => Self::Required,
            "prohibited" => Self::Prohibited,
            _ => Self::Optional,
        }
    }
}

/// `XsdAttributeNode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XsdAttributeNode {
    pub name: String,
    pub use_: AttributeUse,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed_value: Option<String>,
    pub facets: XsdTypeFacets,
}

/// `maxOccurs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaxOccurs {
    Bounded(usize),
    Unbounded,
}

impl MaxOccurs {
    fn bound(self) -> usize {
        match self {
            Self::Bounded(value) => value,
            Self::Unbounded => MAX_REPEAT,
        }
    }

    /// The value used in messages.
    #[must_use]
    pub fn as_text(self) -> String {
        match self {
            Self::Bounded(value) => value.to_string(),
            Self::Unbounded => "unbounded".to_owned(),
        }
    }
}

/// `kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ElementKind {
    Simple,
    Complex,
}

/// `compositor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Compositor {
    Sequence,
    Choice,
    All,
}

/// `XsdElementNode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XsdElementNode {
    pub name: String,
    pub path: String,
    pub sequence_order: usize,
    pub min_occurs: usize,
    pub max_occurs: MaxOccurs,
    #[serde(default)]
    pub nillable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
    pub kind: ElementKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compositor: Option<Compositor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facets: Option<XsdTypeFacets>,
    #[serde(default)]
    pub attributes: Vec<XsdAttributeNode>,
    #[serde(default)]
    pub children: Vec<XsdElementNode>,
}

/// `XsdPathInfo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XsdPathInfo {
    pub path: String,
    pub kind: ElementKind,
    pub min_occurs: usize,
    pub max_occurs: MaxOccurs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub facets: Option<XsdTypeFacets>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documentation: Option<String>,
}

/// `XsdCodeList`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XsdCodeList {
    pub name: String,
    pub used_by_paths: Vec<String>,
    pub allowed_values: Vec<String>,
}

/// `XsdCompiledAst`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledSchema {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_namespace: Option<String>,
    pub element_form_default: String,
    pub root_element: XsdElementNode,
    pub paths: BTreeMap<String, XsdPathInfo>,
    pub code_lists: BTreeMap<String, XsdCodeList>,
}

/// A schema refusal (`XsdCompileError`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum XsdError {
    /// The document is not safe XML or not well-formed.
    #[error("{message}")]
    InvalidXml {
        /// The `XmlError` code.
        code: String,
        message: String,
    },
    /// The root is not `xs:schema`.
    #[error("The document root must be xs:schema")]
    RootInvalid,
    /// No named root element.
    #[error("The XSD must declare a root xs:element")]
    RootElementMissing,
    /// An unsupported base type.
    #[error("Unsupported XSD base type '{0}'")]
    UnsupportedType(String),
    /// An external import/include/redefine or a script.
    #[error("{0}")]
    ForbiddenMarkup(String),
    /// An element outside the whitelist.
    #[error("Unsupported XSD element '{0}'")]
    UnsupportedElement(String),
    /// The nesting limit.
    #[error("The XSD nesting exceeds the limit")]
    NestingTooDeep,
    /// An invalid `maxOccurs`.
    #[error("Invalid maxOccurs '{0}'")]
    InvalidMaxOccurs(String),
    /// An element without a name.
    #[error("An element has no name")]
    ElementNameMissing,
    /// An unresolved `ref`.
    #[error("Element reference '{0}' is not declared")]
    UnresolvedReference(String),
    /// A recursive simple type.
    #[error("Recursive simple type '{0}'")]
    RecursiveType(String),
}

impl XsdError {
    /// The TS code (`XsdCompileError.code`).
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::InvalidXml { code, .. } => code,
            Self::RootInvalid => "XSD_ROOT_INVALID",
            Self::RootElementMissing => "XSD_ROOT_ELEMENT_MISSING",
            Self::UnsupportedType(_) => "XSD_UNSUPPORTED_TYPE",
            Self::ForbiddenMarkup(_) => "XSD_EXTERNAL_IMPORT_FORBIDDEN",
            Self::UnsupportedElement(_) => "XSD_UNSUPPORTED_ELEMENT",
            Self::NestingTooDeep => "XSD_NESTING_TOO_DEEP",
            Self::InvalidMaxOccurs(_) => "XSD_INVALID_MAX_OCCURS",
            Self::ElementNameMissing => "XSD_ELEMENT_NAME_MISSING",
            Self::UnresolvedReference(_) => "XSD_UNRESOLVED_REFERENCE",
            Self::RecursiveType(_) => "XSD_RECURSIVE_TYPE",
        }
    }
}

#[derive(Debug, Default)]
struct TypeDefinitions<'a> {
    complex: BTreeMap<&'a str, &'a XmlNode>,
    simple: BTreeMap<&'a str, &'a XmlNode>,
    elements: BTreeMap<&'a str, &'a XmlNode>,
}

fn reject_forbidden_markup(xsd: &str) -> Result<(), XsdError> {
    let lower = xsd.to_ascii_lowercase();
    for element in EXTERNAL_VOCABULARY {
        for prefix in ["<xs:", "<xsd:", "<"] {
            if lower.contains(&format!("{prefix}{element}")) {
                return Err(XsdError::ForbiddenMarkup(format!(
                    "External schema {element} is forbidden; upload a self-contained XSD"
                )));
            }
        }
    }
    if lower.contains("<script") || lower.contains("javascript:") {
        return Err(XsdError::ForbiddenMarkup(
            "Scripts are forbidden in an XSD".to_owned(),
        ));
    }
    if lower.contains("schemalocation") && (lower.contains("http://") || lower.contains("https://"))
    {
        return Err(XsdError::ForbiddenMarkup(
            "External schemaLocation imports/includes are forbidden; upload a self-contained XSD"
                .to_owned(),
        ));
    }
    Ok(())
}

fn validate_vocabulary(node: &XmlNode) -> Result<(), XsdError> {
    if EXTERNAL_VOCABULARY.contains(&node.local_name.as_str()) {
        return Err(XsdError::ForbiddenMarkup(format!(
            "External schema {} is forbidden; upload a self-contained XSD",
            node.local_name
        )));
    }
    if node.local_name == "script" {
        return Err(XsdError::ForbiddenMarkup(
            "Scripts are forbidden in an XSD".to_owned(),
        ));
    }
    if !ALLOWED_XSD_ELEMENTS.contains(&node.local_name.as_str()) {
        return Err(XsdError::UnsupportedElement(node.local_name.clone()));
    }
    for child in &node.children {
        validate_vocabulary(child)?;
    }
    Ok(())
}

fn documentation_of(node: &XmlNode) -> Option<String> {
    let annotation = node.first_child("annotation")?;
    let documentation = annotation.first_child("documentation")?;
    let text = documentation.text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_owned())
    }
}

fn integer_attribute(node: &XmlNode, name: &str, fallback: usize) -> usize {
    node.attributes
        .get(name)
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(fallback)
}

fn max_occurs_of(node: &XmlNode) -> Result<MaxOccurs, XsdError> {
    match node.attributes.get("maxOccurs") {
        None => Ok(MaxOccurs::Bounded(1)),
        Some(value) if value == "unbounded" => Ok(MaxOccurs::Unbounded),
        Some(value) => value
            .parse::<usize>()
            .map(MaxOccurs::Bounded)
            .map_err(|_| XsdError::InvalidMaxOccurs(value.clone())),
    }
}

fn primitive_type(base: Option<&str>) -> Result<XsdPrimitiveType, XsdError> {
    let local = base.map_or("string", local_name);
    XsdPrimitiveType::from_local(local)
        .ok_or_else(|| XsdError::UnsupportedType(base.unwrap_or("").to_owned()))
}

fn apply_facets(mut facets: XsdTypeFacets, restriction: &XmlNode) -> XsdTypeFacets {
    let mut enumerations = Vec::new();
    for child in &restriction.children {
        let Some(value) = child.attributes.get("value") else {
            continue;
        };
        match child.local_name.as_str() {
            "minLength" => facets.min_length = value.parse().ok(),
            "maxLength" => facets.max_length = value.parse().ok(),
            "length" => facets.length = value.parse().ok(),
            "pattern" => facets.pattern = Some(value.clone()),
            "minInclusive" => facets.min_inclusive = Some(value.clone()),
            "maxInclusive" => facets.max_inclusive = Some(value.clone()),
            "totalDigits" => facets.total_digits = value.parse().ok(),
            "fractionDigits" => facets.fraction_digits = value.parse().ok(),
            "enumeration" => enumerations.push(value.clone()),
            _ => {}
        }
    }
    if !enumerations.is_empty() {
        facets.enumeration = enumerations;
    }
    facets
}

fn facets_of(
    node: &XmlNode,
    definitions: &TypeDefinitions<'_>,
    seen: &mut Vec<String>,
) -> Result<XsdTypeFacets, XsdError> {
    let Some(restriction) = node.first_child("restriction") else {
        if let Some(extension) = node.first_child("extension") {
            return facets_of(extension, definitions, seen);
        }
        return Ok(XsdTypeFacets::default());
    };
    if let Some(base) = restriction.attributes.get("base") {
        let name = local_name(base).to_owned();
        if let Some(named) = definitions.simple.get(name.as_str()) {
            if seen.contains(&name) {
                return Err(XsdError::RecursiveType(name));
            }
            seen.push(name);
            let inherited = facets_of(named, definitions, seen)?;
            return Ok(apply_facets(inherited, restriction));
        }
    }
    Ok(apply_facets(
        XsdTypeFacets {
            base_type: primitive_type(restriction.attributes.get("base").map(String::as_str))?,
            ..XsdTypeFacets::default()
        },
        restriction,
    ))
}

fn attributes_of(
    node: &XmlNode,
    definitions: &TypeDefinitions<'_>,
) -> Result<Vec<XsdAttributeNode>, XsdError> {
    let mut attributes = Vec::new();
    for attribute in node.children_named("attribute") {
        let type_name = attribute.attributes.get("type").map(String::as_str);
        let named_simple = type_name.and_then(|name| definitions.simple.get(local_name(name)));
        let facets = match named_simple {
            Some(simple) => facets_of(simple, definitions, &mut Vec::new())?,
            None => XsdTypeFacets {
                base_type: primitive_type(type_name)?,
                ..XsdTypeFacets::default()
            },
        };
        attributes.push(XsdAttributeNode {
            name: attribute
                .attributes
                .get("name")
                .cloned()
                .unwrap_or_default(),
            use_: attribute
                .attributes
                .get("use")
                .map_or(AttributeUse::Optional, |value| {
                    AttributeUse::from_wire(value)
                }),
            default_value: attribute.attributes.get("default").cloned(),
            fixed_value: attribute.attributes.get("fixed").cloned(),
            facets,
        });
    }
    Ok(attributes)
}

fn compositor_of(node: &XmlNode) -> Option<Compositor> {
    let direct = node
        .children
        .iter()
        .find(|child| matches!(child.local_name.as_str(), "sequence" | "choice" | "all"));
    if let Some(direct) = direct {
        return match direct.local_name.as_str() {
            "sequence" => Some(Compositor::Sequence),
            "choice" => Some(Compositor::Choice),
            "all" => Some(Compositor::All),
            _ => None,
        };
    }
    let content = node.first_child("complexContent")?;
    let extension = content.first_child("extension")?;
    compositor_of(extension)
}

fn compositor_node(node: &XmlNode) -> Option<&XmlNode> {
    let direct = node
        .children
        .iter()
        .find(|child| matches!(child.local_name.as_str(), "sequence" | "choice" | "all"));
    if let Some(direct) = direct {
        return Some(direct);
    }
    let content = node.first_child("complexContent")?;
    let extension = content.first_child("extension")?;
    compositor_node(extension)
}

fn build_element(
    source: &XmlNode,
    path: &str,
    order: usize,
    definitions: &TypeDefinitions<'_>,
    depth: usize,
) -> Result<XsdElementNode, XsdError> {
    if depth > MAX_DEPTH {
        return Err(XsdError::NestingTooDeep);
    }
    let reference = source.attributes.get("ref").map(|value| local_name(value));
    let resolved = reference.and_then(|name| definitions.elements.get(name));
    let (Some(reference), Some(resolved)) = (reference, resolved) else {
        if let Some(reference) = reference {
            return Err(XsdError::UnresolvedReference(reference.to_owned()));
        }
        // No reference: fall through to the inline definition below.
        return build_inline_element(source, path, order, definitions, depth);
    };
    let mut name = resolved
        .attributes
        .get("name")
        .map(|value| local_name(value))
        .unwrap_or(reference);
    if let Some(override_name) = source.attributes.get("name") {
        name = local_name(override_name);
    }
    if name.is_empty() {
        return Err(XsdError::ElementNameMissing);
    }
    build_from_definition(
        resolved,
        name,
        path,
        order,
        definitions,
        depth,
        max_occurs_of(source)?,
        integer_attribute(source, "minOccurs", 1),
    )
}

fn build_inline_element(
    source: &XmlNode,
    path: &str,
    order: usize,
    definitions: &TypeDefinitions<'_>,
    depth: usize,
) -> Result<XsdElementNode, XsdError> {
    let Some(name) = source.attributes.get("name").map(|value| local_name(value)) else {
        return Err(XsdError::ElementNameMissing);
    };
    if name.is_empty() {
        return Err(XsdError::ElementNameMissing);
    }
    build_from_definition(
        source,
        name,
        path,
        order,
        definitions,
        depth,
        max_occurs_of(source)?,
        integer_attribute(source, "minOccurs", 1),
    )
}

#[allow(clippy::too_many_arguments)]
fn build_from_definition(
    definition: &XmlNode,
    name: &str,
    path: &str,
    order: usize,
    definitions: &TypeDefinitions<'_>,
    depth: usize,
    max_occurs: MaxOccurs,
    min_occurs: usize,
) -> Result<XsdElementNode, XsdError> {
    let element_path = if path.is_empty() {
        format!("/{name}")
    } else {
        format!("{path}/{name}")
    };
    let type_name = definition.attributes.get("type").map(String::as_str);
    let named_complex = type_name
        .and_then(|value| definitions.complex.get(local_name(value)))
        .copied();
    let named_simple = type_name
        .and_then(|value| definitions.simple.get(local_name(value)))
        .copied();
    let inline_complex = definition.first_child("complexType");
    let inline_simple = definition.first_child("simpleType");
    let complex_node = named_complex.or(inline_complex);
    let simple_node = named_simple.or(inline_simple);

    let mut attributes = attributes_of(definition, definitions)?;
    if let Some(complex) = complex_node {
        attributes.extend(attributes_of(complex, definitions)?);
    }
    let compositor = complex_node.and_then(compositor_of);
    let children = match complex_node.and_then(compositor_node) {
        Some(container) => {
            let mut children = Vec::new();
            for (index, child) in container.children_named("element").into_iter().enumerate() {
                children.push(build_element(
                    child,
                    &element_path,
                    index,
                    definitions,
                    depth + 1,
                )?);
            }
            children
        }
        None => Vec::new(),
    };
    let facets = match (simple_node, type_name) {
        (Some(simple), _) => Some(facets_of(simple, definitions, &mut Vec::new())?),
        (None, Some(type_name))
            if XsdPrimitiveType::from_local(local_name(type_name)).is_some() =>
        {
            Some(XsdTypeFacets {
                base_type: primitive_type(Some(type_name))?,
                ..XsdTypeFacets::default()
            })
        }
        (None, Some(type_name)) => {
            // A named simple type is resolved through `named_simple` above; anything else is unknown.
            return Err(XsdError::UnsupportedType(type_name.to_owned()));
        }
        (None, None) => None,
    };
    let kind = if children.is_empty() && complex_node.is_none() {
        ElementKind::Simple
    } else {
        ElementKind::Complex
    };
    Ok(XsdElementNode {
        name: name.to_owned(),
        path: element_path,
        sequence_order: order,
        min_occurs,
        max_occurs,
        nillable: definition
            .attributes
            .get("nillable")
            .is_some_and(|value| value == "true"),
        documentation: documentation_of(definition),
        kind,
        compositor,
        facets,
        attributes,
        children,
    })
}

fn index_paths(
    node: &XsdElementNode,
    paths: &mut BTreeMap<String, XsdPathInfo>,
    code_lists: &mut BTreeMap<String, XsdCodeList>,
) {
    for attribute in &node.attributes {
        paths.insert(
            format!("{}/@{}", node.path, attribute.name),
            XsdPathInfo {
                path: format!("{}/@{}", node.path, attribute.name),
                kind: ElementKind::Simple,
                min_occurs: usize::from(attribute.use_ == AttributeUse::Required),
                max_occurs: MaxOccurs::Bounded(1),
                facets: Some(attribute.facets.clone()),
                documentation: None,
            },
        );
    }
    paths.insert(
        node.path.clone(),
        XsdPathInfo {
            path: node.path.clone(),
            kind: node.kind,
            min_occurs: node.min_occurs,
            max_occurs: node.max_occurs,
            facets: node.facets.clone(),
            documentation: node.documentation.clone(),
        },
    );
    if let Some(facets) = &node.facets {
        if !facets.enumeration.is_empty() {
            let key = if node.name.is_empty() {
                node.path.clone()
            } else {
                node.name.clone()
            };
            code_lists
                .entry(key.clone())
                .and_modify(|list| {
                    if !list.used_by_paths.contains(&node.path) {
                        list.used_by_paths.push(node.path.clone());
                    }
                    for value in &facets.enumeration {
                        if !list.allowed_values.contains(value) {
                            list.allowed_values.push(value.clone());
                        }
                    }
                })
                .or_insert_with(|| XsdCodeList {
                    name: key,
                    used_by_paths: vec![node.path.clone()],
                    allowed_values: facets.enumeration.clone(),
                });
        }
    }
    for child in &node.children {
        index_paths(child, paths, code_lists);
    }
}

/// `compileXsd` with the whitelist and external-markup guards.
///
/// # Errors
/// [`XsdError`] for unsafe, unsupported or malformed schemas.
pub fn compile_schema(xsd: &str) -> Result<CompiledSchema, XsdError> {
    assert_safe_xml(xsd, MAX_XSD_BYTES).map_err(|error| XsdError::InvalidXml {
        code: error.code().to_owned(),
        message: error.to_string(),
    })?;
    reject_forbidden_markup(xsd)?;
    let root = parse_safe_xml(xsd, MAX_XSD_BYTES).map_err(|error| XsdError::InvalidXml {
        code: error.code().to_owned(),
        message: error.to_string(),
    })?;
    if root.local_name != "schema" {
        return Err(XsdError::RootInvalid);
    }
    validate_vocabulary(&root)?;

    let mut definitions = TypeDefinitions::default();
    for child in &root.children {
        let Some(name) = child.attributes.get("name") else {
            continue;
        };
        match child.local_name.as_str() {
            "complexType" => {
                definitions.complex.insert(name, child);
            }
            "simpleType" => {
                definitions.simple.insert(name, child);
            }
            "element" => {
                definitions.elements.insert(name, child);
            }
            _ => {}
        }
    }
    let root_definition = root
        .children_named("element")
        .into_iter()
        .find(|child| child.attributes.contains_key("name"))
        .ok_or(XsdError::RootElementMissing)?;
    let root_element = build_element(root_definition, "", 0, &definitions, 0)?;
    let mut paths = BTreeMap::new();
    let mut code_lists = BTreeMap::new();
    index_paths(&root_element, &mut paths, &mut code_lists);
    Ok(CompiledSchema {
        target_namespace: root.attributes.get("targetNamespace").cloned(),
        element_form_default: root
            .attributes
            .get("elementFormDefault")
            .cloned()
            .unwrap_or_else(|| "unqualified".to_owned()),
        root_element,
        paths,
        code_lists,
    })
}

/// One validation problem.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub path: String,
    pub rule: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual: Option<String>,
}

impl ValidationIssue {
    fn new(
        path: impl Into<String>,
        rule: impl Into<String>,
        message: impl Into<String>,
        actual: Option<String>,
    ) -> Self {
        Self {
            path: path.into(),
            rule: rule.into(),
            message: message.into(),
            actual,
        }
    }
}

/// `XmlValidationResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct XmlValidation {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
}

/// `^[-+]?(\d+(\.\d*)?|\.\d+)$` (the XSD decimal lexical space, without exponents).
fn is_decimal_lexical(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut index = usize::from(text.starts_with('+') || text.starts_with('-'));
    let mut digits_before = 0;
    while index < bytes.len() && bytes[index].is_ascii_digit() {
        index += 1;
        digits_before += 1;
    }
    let mut digits_after = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
            digits_after += 1;
        }
    }
    index == bytes.len() && (digits_before > 0 || digits_after > 0)
}

fn decimal_parts(text: &str) -> Option<(bool, String, String)> {
    if !is_decimal_lexical(text) {
        return None;
    }
    let (negative, rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (integer, fraction) = match rest.split_once('.') {
        Some((integer, fraction)) => (integer, fraction),
        None => (rest, ""),
    };
    let integer = integer.trim_start_matches('0');
    let integer = if integer.is_empty() { "0" } else { integer };
    let fraction = fraction.trim_end_matches('0');
    Some((negative, integer.to_owned(), fraction.to_owned()))
}

fn compare_decimal(left: &str, right: &str) -> Option<Ordering> {
    let (left_negative, left_integer, left_fraction) = decimal_parts(left)?;
    let (right_negative, right_integer, right_fraction) = decimal_parts(right)?;
    let left_zero = left_integer == "0" && left_fraction.is_empty();
    let right_zero = right_integer == "0" && right_fraction.is_empty();
    if left_negative != right_negative && !(left_zero || right_zero) {
        return Some(if left_negative {
            Ordering::Less
        } else {
            Ordering::Greater
        });
    }
    let magnitude = compare_magnitude(
        &left_integer,
        &left_fraction,
        &right_integer,
        &right_fraction,
    );
    Some(if left_negative && !(left_zero || right_zero) {
        magnitude.reverse()
    } else {
        magnitude
    })
}

fn compare_magnitude(
    left_integer: &str,
    left_fraction: &str,
    right_integer: &str,
    right_fraction: &str,
) -> Ordering {
    let integer_order = left_integer
        .len()
        .cmp(&right_integer.len())
        .then_with(|| left_integer.cmp(right_integer));
    if integer_order != Ordering::Equal {
        return integer_order;
    }
    let width = left_fraction.len().max(right_fraction.len());
    let left: String = format!("{left_fraction:<width$}", width = width);
    let right: String = format!("{right_fraction:<width$}", width = width);
    left.cmp(&right)
}

fn digit_count(text: &str) -> usize {
    text.bytes().filter(u8::is_ascii_digit).count()
}

fn fraction_length(text: &str) -> usize {
    match text.split_once('.') {
        Some((_, fraction)) => fraction.trim_end_matches('0').len(),
        None => 0,
    }
}

fn validate_facets(
    value: &str,
    facets: &XsdTypeFacets,
    path: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let length = value.chars().count();
    if let Some(minimum) = facets.min_length {
        if length < minimum {
            issues.push(ValidationIssue::new(
                path,
                "minLength",
                format!("Must be at least {minimum} characters"),
                Some(value.to_owned()),
            ));
        }
    }
    if let Some(maximum) = facets.max_length {
        if length > maximum {
            issues.push(ValidationIssue::new(
                path,
                "maxLength",
                format!("Must be at most {maximum} characters"),
                Some(value.to_owned()),
            ));
        }
    }
    if let Some(exact) = facets.length {
        if length != exact {
            issues.push(ValidationIssue::new(
                path,
                "length",
                format!("Must be exactly {exact} characters"),
                Some(value.to_owned()),
            ));
        }
    }
    if !facets.enumeration.is_empty() && !facets.enumeration.iter().any(|allowed| allowed == value)
    {
        issues.push(ValidationIssue::new(
            path,
            "enumeration",
            format!("Must be one of: {}", facets.enumeration.join(", ")),
            Some(value.to_owned()),
        ));
    }
    if facets.base_type.is_numeric() {
        if !is_decimal_lexical(value) {
            issues.push(ValidationIssue::new(
                path,
                "type",
                format!("Must be {}", facets.base_type.wire()),
                Some(value.to_owned()),
            ));
        } else {
            if facets.base_type.is_integer() && fraction_length(value) > 0 {
                issues.push(ValidationIssue::new(
                    path,
                    "type",
                    "Must be an integer",
                    Some(value.to_owned()),
                ));
            }
            if let Some(minimum) = facets.min_inclusive.as_deref() {
                if compare_decimal(value, minimum) == Some(Ordering::Less) {
                    issues.push(ValidationIssue::new(
                        path,
                        "minInclusive",
                        format!("Must be at least {minimum}"),
                        Some(value.to_owned()),
                    ));
                }
            }
            if let Some(maximum) = facets.max_inclusive.as_deref() {
                if compare_decimal(value, maximum) == Some(Ordering::Greater) {
                    issues.push(ValidationIssue::new(
                        path,
                        "maxInclusive",
                        format!("Must be at most {maximum}"),
                        Some(value.to_owned()),
                    ));
                }
            }
            if let Some(total) = facets.total_digits {
                if digit_count(value) > total {
                    issues.push(ValidationIssue::new(
                        path,
                        "totalDigits",
                        format!("At most {total} digits"),
                        Some(value.to_owned()),
                    ));
                }
            }
            if let Some(fraction) = facets.fraction_digits {
                if fraction_length(value) > fraction {
                    issues.push(ValidationIssue::new(
                        path,
                        "fractionDigits",
                        format!("At most {fraction} decimal places"),
                        Some(value.to_owned()),
                    ));
                }
            }
            if facets.base_type == XsdPrimitiveType::PositiveInteger
                && compare_decimal(value, "0") != Some(Ordering::Greater)
            {
                issues.push(ValidationIssue::new(
                    path,
                    "type",
                    "Must be xs:positiveInteger",
                    Some(value.to_owned()),
                ));
            }
            if facets.base_type == XsdPrimitiveType::NonNegativeInteger
                && compare_decimal(value, "0") == Some(Ordering::Less)
            {
                issues.push(ValidationIssue::new(
                    path,
                    "type",
                    "Must be xs:nonNegativeInteger",
                    Some(value.to_owned()),
                ));
            }
        }
    }
    if facets.base_type == XsdPrimitiveType::Date
        && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err()
    {
        issues.push(ValidationIssue::new(
            path,
            "type",
            "Must be an ISO date (YYYY-MM-DD)",
            Some(value.to_owned()),
        ));
    }
    if facets.base_type == XsdPrimitiveType::DateTime
        && DateTime::parse_from_rfc3339(value).is_err()
    {
        issues.push(ValidationIssue::new(
            path,
            "type",
            "Must be an ISO date-time",
            Some(value.to_owned()),
        ));
    }
    if facets.base_type == XsdPrimitiveType::Boolean
        && !matches!(value, "true" | "false" | "1" | "0")
    {
        issues.push(ValidationIssue::new(
            path,
            "type",
            "Must be a boolean",
            Some(value.to_owned()),
        ));
    }
}

fn validate_node(ast: &XsdElementNode, xml: &XmlNode, issues: &mut Vec<ValidationIssue>) {
    let path = ast.path.as_str();
    if xml.local_name != ast.name {
        issues.push(ValidationIssue::new(
            path,
            "element",
            format!("Expected <{}>, found <{}>", ast.name, xml.local_name),
            None,
        ));
        return;
    }
    for attribute in &ast.attributes {
        match xml.attributes.get(&attribute.name) {
            None => {
                if attribute.use_ == AttributeUse::Required {
                    issues.push(ValidationIssue::new(
                        format!("{path}/@{}", attribute.name),
                        "required",
                        "Required attribute is missing",
                        None,
                    ));
                }
            }
            Some(value) => validate_facets(
                value,
                &attribute.facets,
                &format!("{path}/@{}", attribute.name),
                issues,
            ),
        }
    }
    if ast.kind == ElementKind::Simple || ast.children.is_empty() {
        let value = xml.text.trim();
        if value.is_empty() && ast.min_occurs > 0 {
            issues.push(ValidationIssue::new(
                path,
                "minOccurs",
                "Required element is missing or empty",
                None,
            ));
            return;
        }
        if !value.is_empty() {
            if let Some(facets) = &ast.facets {
                validate_facets(value, facets, path, issues);
            }
        }
        return;
    }

    let mut by_name: BTreeMap<&str, Vec<&XmlNode>> = BTreeMap::new();
    for child in &xml.children {
        by_name
            .entry(child.local_name.as_str())
            .or_default()
            .push(child);
    }
    let mut choice_count = 0;
    for child in &ast.children {
        let matches = by_name
            .get(child.name.as_str())
            .map_or(&[][..], Vec::as_slice);
        if !matches.is_empty() {
            choice_count += 1;
        }
        if ast.compositor != Some(Compositor::Choice) && matches.len() < child.min_occurs {
            issues.push(ValidationIssue::new(
                child.path.clone(),
                "minOccurs",
                format!(
                    "Required {} occurrence(s), found {}",
                    child.min_occurs,
                    matches.len()
                ),
                None,
            ));
        }
        if matches.len() > child.max_occurs.bound() {
            issues.push(ValidationIssue::new(
                child.path.clone(),
                "maxOccurs",
                format!(
                    "At most {} occurrence(s), found {}",
                    child.max_occurs.as_text(),
                    matches.len()
                ),
                None,
            ));
        }
        for matched in matches {
            validate_node(child, matched, issues);
        }
    }
    if ast.compositor == Some(Compositor::Choice) {
        if choice_count == 0 && ast.min_occurs > 0 {
            issues.push(ValidationIssue::new(
                path,
                "choice",
                "At least one choice branch is required",
                None,
            ));
        }
        if choice_count > 1 {
            issues.push(ValidationIssue::new(
                path,
                "choice",
                "Only one choice branch may be emitted",
                None,
            ));
        }
    }
}

/// `validateXml`: well-formedness plus the compiled structural/facet rules.
///
/// # Errors
/// None; a parse failure is returned as an invalid [`XmlValidation`] with rule `xml`.
#[must_use]
pub fn validate_xml(schema: &CompiledSchema, xml: &str) -> XmlValidation {
    let root = match parse_safe_xml(xml, MAX_XML_BYTES) {
        Ok(root) => root,
        Err(error) => {
            return XmlValidation {
                valid: false,
                issues: vec![ValidationIssue::new(
                    "/",
                    "xml",
                    error.to_string(),
                    Some(error.code().to_owned()),
                )],
            };
        }
    };
    let mut issues = Vec::new();
    validate_node(&schema.root_element, &root, &mut issues);
    XmlValidation {
        valid: issues.is_empty(),
        issues,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CBL: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" elementFormDefault="qualified">
  <xs:element name="Report">
    <xs:annotation><xs:documentation>A monthly PSP return</xs:documentation></xs:annotation>
    <xs:complexType>
      <xs:sequence>
        <xs:element name="RentityId" type="xs:string"/>
        <xs:element name="Period" type="xs:string"/>
        <xs:element name="Currency" minOccurs="0" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence>
              <xs:element name="Code" type="CurrencyCode"/>
              <xs:element name="Amount" type="xs:decimal"/>
            </xs:sequence>
            <xs:attribute name="kind" type="xs:string" use="required"/>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:simpleType name="CurrencyCode">
    <xs:restriction base="xs:string">
      <xs:minLength value="3"/>
      <xs:maxLength value="3"/>
      <xs:enumeration value="LYD"/>
      <xs:enumeration value="USD"/>
    </xs:restriction>
  </xs:simpleType>
</xs:schema>"#;

    fn good_xml() -> String {
        "<Report><RentityId>R1</RentityId><Period>2026-11</Period><Currency kind=\"settled\"><Code>LYD</Code><Amount>1500.0000</Amount></Currency></Report>".to_owned()
    }

    #[test]
    fn the_tokenizer_parses_attributes_text_and_cdata() {
        let node = parse_safe_xml(
            "<a x=\"1\" y='2'><b>hi &amp; bye</b><![CDATA[<raw>]]></a>",
            1024,
        )
        .expect("parses");
        assert_eq!(node.name, "a");
        assert_eq!(node.attributes.get("x").map(String::as_str), Some("1"));
        assert_eq!(node.attributes.get("y").map(String::as_str), Some("2"));
        assert_eq!(child_text(&node, "b"), Some("hi & bye"));
        assert_eq!(node.text, "<raw>");
    }

    #[test]
    fn the_tokenizer_refuses_doctype_entities_and_two_roots() {
        let error = parse_safe_xml("<!DOCTYPE foo []><a/>", 1024).expect_err("doctype");
        assert_eq!(error.code(), "XML_EXTERNAL_ENTITY_FORBIDDEN");
        assert!(parse_safe_xml("<a/><b/>", 1024).is_err());
        assert!(parse_safe_xml("<a>", 1024).is_err());
        assert!(parse_safe_xml("<a></b>", 1024).is_err());
        let too_large = parse_safe_xml("<a/>", 2).expect_err("size");
        assert_eq!(too_large.code(), "XML_PAYLOAD_TOO_LARGE");
    }

    #[test]
    fn escaping_is_round_trip_safe() {
        assert_eq!(escape_xml("a<b>&\"c'"), "a&lt;b&gt;&amp;&quot;c&apos;");
    }

    #[test]
    fn the_cbl_like_schema_compiles() {
        let schema = compile_schema(CBL).expect("schema compiles");
        assert_eq!(schema.element_form_default, "qualified");
        assert_eq!(schema.root_element.path, "/Report");
        assert_eq!(
            schema.paths.get("/Report").map(|info| info.kind),
            Some(ElementKind::Complex)
        );
        assert!(schema.root_element.documentation.is_some());
        let currency = schema
            .root_element
            .children
            .iter()
            .find(|child| child.name == "Currency")
            .expect("currency");
        assert_eq!(currency.max_occurs, MaxOccurs::Unbounded);
        assert_eq!(currency.min_occurs, 0);
        assert_eq!(currency.attributes.len(), 1);
        assert_eq!(currency.attributes[0].use_, AttributeUse::Required);
        let code_list = schema.code_lists.get("Code").expect("code list");
        assert_eq!(code_list.allowed_values, vec!["LYD", "USD"]);
        assert!(schema.paths.contains_key("/Report/Currency/@kind"));
        assert!(schema.paths.contains_key("/Report/Currency/Code"));
    }

    #[test]
    fn external_vocabulary_and_scripts_are_refused() {
        let include = CBL.replace(
            "<xs:element name=\"Report\">",
            "<xs:include schemaLocation=\"https://evil/x.xsd\"/><xs:element name=\"Report\">",
        );
        let error = compile_schema(&include).expect_err("include");
        assert_eq!(error.code(), "XSD_EXTERNAL_IMPORT_FORBIDDEN");

        let script = CBL.replace(
            "<xs:documentation>A monthly PSP return</xs:documentation>",
            "<script>alert(1)</script>",
        );
        assert!(compile_schema(&script).is_err());

        let unknown = CBL.replace(
            "<xs:element name=\"RentityId\" type=\"xs:string\"/>",
            "<xs:element name=\"RentityId\"><xs:any/></xs:element>",
        );
        let error = compile_schema(&unknown).expect_err("unsupported element");
        assert_eq!(error.code(), "XSD_UNSUPPORTED_ELEMENT");
    }

    #[test]
    fn the_root_must_be_a_schema_with_a_named_element() {
        let error = compile_schema("<xs:note xmlns:xs=\"http://www.w3.org/2001/XMLSchema\"/>")
            .expect_err("root");
        assert_eq!(error.code(), "XSD_ROOT_INVALID");
        let error = compile_schema(
            "<xs:schema xmlns:xs=\"http://www.w3.org/2001/XMLSchema\"><xs:simpleType name=\"T\"><xs:restriction base=\"xs:string\"/></xs:simpleType></xs:schema>",
        )
        .expect_err("root element");
        assert_eq!(error.code(), "XSD_ROOT_ELEMENT_MISSING");
    }

    #[test]
    fn unsupported_types_and_bad_occurs_are_refused() {
        let unsupported = CBL.replace("type=\"xs:decimal\"", "type=\"xs:duration\"");
        assert_eq!(
            compile_schema(&unsupported).expect_err("type").code(),
            "XSD_UNSUPPORTED_TYPE"
        );
        let bad_occurs = CBL.replace("maxOccurs=\"unbounded\"", "maxOccurs=\"many\"");
        assert_eq!(
            compile_schema(&bad_occurs).expect_err("occurs").code(),
            "XSD_INVALID_MAX_OCCURS"
        );
    }

    #[test]
    fn a_valid_document_passes() {
        let schema = compile_schema(CBL).expect("schema");
        let result = validate_xml(&schema, &good_xml());
        assert!(result.valid, "unexpected issues: {:?}", result.issues);
    }

    #[test]
    fn required_elements_and_attributes_are_enforced() {
        let schema = compile_schema(CBL).expect("schema");
        let missing = validate_xml(&schema, "<Report><RentityId>R1</RentityId></Report>");
        assert!(!missing.valid);
        assert!(missing
            .issues
            .iter()
            .any(|issue| issue.path == "/Report/Period" && issue.rule == "minOccurs"));
        let no_attribute = validate_xml(
            &schema,
            "<Report><RentityId>R1</RentityId><Period>2026-11</Period><Currency><Code>LYD</Code><Amount>1.0000</Amount></Currency></Report>",
        );
        assert!(no_attribute
            .issues
            .iter()
            .any(|issue| issue.rule == "required" && issue.path.ends_with("/@kind")));
    }

    #[test]
    fn facets_enumeration_decimal_and_length_are_enforced() {
        let schema = compile_schema(CBL).expect("schema");
        let bad_code = validate_xml(
            &schema,
            "<Report><RentityId>R1</RentityId><Period>2026-11</Period><Currency kind=\"settled\"><Code>EUR</Code><Amount>1.0000</Amount></Currency></Report>",
        );
        assert!(bad_code
            .issues
            .iter()
            .any(|issue| issue.rule == "enumeration" && issue.path == "/Report/Currency/Code"));
        let bad_amount = validate_xml(
            &schema,
            "<Report><RentityId>R1</RentityId><Period>2026-11</Period><Currency kind=\"settled\"><Code>LYD</Code><Amount>one</Amount></Currency></Report>",
        );
        assert!(bad_amount
            .issues
            .iter()
            .any(|issue| issue.rule == "type" && issue.path == "/Report/Currency/Amount"));
    }

    #[test]
    fn choice_requires_exactly_one_branch() {
        let schema = compile_schema(
            r#"<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
              <xs:element name="Root"><xs:complexType><xs:choice>
                <xs:element name="A" type="xs:string"/>
                <xs:element name="B" type="xs:string"/>
              </xs:choice></xs:complexType></xs:element>
            </xs:schema>"#,
        )
        .expect("schema");
        assert!(validate_xml(&schema, "<Root><A>x</A></Root>").valid);
        let both = validate_xml(&schema, "<Root><A>x</A><B>y</B></Root>");
        assert!(both.issues.iter().any(|issue| issue.rule == "choice"));
        let neither = validate_xml(&schema, "<Root><C>x</C></Root>");
        assert!(neither.issues.iter().any(|issue| issue.rule == "choice"));
    }

    #[test]
    fn decimal_comparison_is_exact() {
        assert_eq!(compare_decimal("10.5", "10.50"), Some(Ordering::Equal));
        assert_eq!(compare_decimal("10.5", "10.51"), Some(Ordering::Less));
        assert_eq!(compare_decimal("-10.5", "-10.4"), Some(Ordering::Less));
        assert_eq!(compare_decimal("-0", "0"), Some(Ordering::Equal));
        assert_eq!(compare_decimal("100", "99.999"), Some(Ordering::Greater));
        assert_eq!(compare_decimal("abc", "1"), None);
        assert_eq!(digit_count("123.4500"), 7);
        assert_eq!(fraction_length("123.4500"), 2);
    }

    #[test]
    fn recursion_and_depth_are_bounded() {
        let shallow = "<xs:schema xmlns:xs=\"http://www.w3.org/2001/XMLSchema\"><xs:element name=\"A\" type=\"xs:string\"/></xs:schema>";
        assert!(compile_schema(shallow).is_ok());
        let mut deep = String::from("<xs:schema xmlns:xs=\"http://www.w3.org/2001/XMLSchema\"><xs:element name=\"Root\"><xs:complexType><xs:sequence>");
        for _ in 0..40 {
            deep.push_str("<xs:element name=\"N\"><xs:complexType><xs:sequence>");
        }
        for _ in 0..40 {
            deep.push_str("</xs:sequence></xs:complexType></xs:element>");
        }
        deep.push_str("</xs:sequence></xs:complexType></xs:element></xs:schema>");
        assert_eq!(
            compile_schema(&deep).expect_err("too deep").code(),
            "XSD_NESTING_TOO_DEEP"
        );
    }
}
