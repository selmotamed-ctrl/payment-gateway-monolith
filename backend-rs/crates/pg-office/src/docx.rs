//! DOCX narrative document structure.
//!
//! Port of the `DocxNarrativeSchema` types in `core-back/lib/docx/regulatoryDocx.ts`.
//!
//! Structures only: building the WordprocessingML zip is a later P8-T03 step. Paragraphs are
//! plain strings (the renderer escapes them), so no markup reaches this layer.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

use crate::error::OfficeError;

/// `mode`.
pub const DOCX_MODE: &str = "DOCX";
/// `schemaVersion`.
pub const DOCX_SCHEMA_VERSION: u8 = 1;

fn default_schema_version() -> u8 {
    DOCX_SCHEMA_VERSION
}

fn default_mode() -> String {
    DOCX_MODE.to_owned()
}

/// One narrative section (`DocxNarrativeSection` extended with its rendered paragraphs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocxSection {
    pub key: String,
    pub title: String,
    /// 1, 2 or 3.
    #[serde(default = "default_heading_level")]
    pub heading_level: u8,
    #[serde(default)]
    pub required: bool,
    /// Context path the renderer reads (`xpath`-style, e.g. `transactions`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_path: Option<String>,
    /// Paragraphs in document order; each is escaped by the renderer.
    #[serde(default)]
    pub paragraphs: Vec<String>,
}

fn default_heading_level() -> u8 {
    1
}

impl Default for DocxSection {
    fn default() -> Self {
        Self {
            key: String::new(),
            title: String::new(),
            heading_level: 1,
            required: false,
            context_path: None,
            paragraphs: Vec::new(),
        }
    }
}

impl DocxSection {
    /// A section with a key, title and heading level.
    #[must_use]
    pub fn new(key: impl Into<String>, title: impl Into<String>, heading_level: u8) -> Self {
        Self {
            key: key.into(),
            title: title.into(),
            heading_level,
            ..Self::default()
        }
    }

    /// Marks the section as required for filing.
    #[must_use]
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }

    /// Appends one paragraph.
    #[must_use]
    pub fn with_paragraph(mut self, paragraph: impl Into<String>) -> Self {
        self.paragraphs.push(paragraph.into());
        self
    }
}

/// A narrative table (`DocxNarrativeTable` with materialised rows).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocxTable {
    pub title: String,
    /// Context path the rows came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows_path: Option<String>,
    pub headers: Vec<String>,
    /// Every row must have exactly `headers.len()` cells.
    #[serde(default)]
    pub rows: Vec<Vec<String>>,
}

impl DocxTable {
    /// A table with headers and no rows.
    #[must_use]
    pub fn new(
        title: impl Into<String>,
        headers: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            title: title.into(),
            rows_path: None,
            headers: headers.into_iter().map(Into::into).collect(),
            rows: Vec::new(),
        }
    }
}

/// A DOCX narrative document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocxSpec {
    #[serde(default = "default_schema_version")]
    pub schema_version: u8,
    #[serde(default = "default_mode")]
    pub mode: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub sections: Vec<DocxSection>,
    #[serde(default)]
    pub tables: Vec<DocxTable>,
}

impl Default for DocxSpec {
    fn default() -> Self {
        Self {
            schema_version: DOCX_SCHEMA_VERSION,
            mode: DOCX_MODE.to_owned(),
            title: String::new(),
            subtitle: None,
            sections: Vec::new(),
            tables: Vec::new(),
        }
    }
}

impl DocxSpec {
    /// A document with a title.
    #[must_use]
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            ..Self::default()
        }
    }

    /// Finds a section by key.
    #[must_use]
    pub fn section(&self, key: &str) -> Option<&DocxSection> {
        self.sections.iter().find(|section| section.key == key)
    }

    /// Required section keys that carry no text (a filing blocker).
    #[must_use]
    pub fn empty_required_sections(&self) -> Vec<&str> {
        self.sections
            .iter()
            .filter(|section| {
                section.required && section.paragraphs.iter().all(|text| text.trim().is_empty())
            })
            .map(|section| section.key.as_str())
            .collect()
    }

    /// Structural validation before rendering.
    ///
    /// # Errors
    /// [`OfficeError`] when the document cannot be rendered faithfully.
    pub fn validate(&self) -> Result<(), OfficeError> {
        if self.mode != DOCX_MODE {
            return Err(OfficeError::InvalidDocxMode(self.mode.clone()));
        }
        if self.title.trim().is_empty() {
            return Err(OfficeError::EmptyTitle);
        }
        let mut keys: Vec<&str> = Vec::new();
        for section in &self.sections {
            if section.key.trim().is_empty() {
                return Err(OfficeError::EmptySectionKey(section.title.clone()));
            }
            if keys.contains(&section.key.as_str()) {
                return Err(OfficeError::DuplicateSectionKey(section.key.clone()));
            }
            keys.push(section.key.as_str());
            if !(1..=3).contains(&section.heading_level) {
                return Err(OfficeError::InvalidHeadingLevel(section.heading_level));
            }
            if section.title.trim().is_empty() {
                return Err(OfficeError::EmptySectionTitle(section.key.clone()));
            }
        }
        for table in &self.tables {
            if table.headers.is_empty() {
                return Err(OfficeError::EmptyTableHeaders(table.title.clone()));
            }
            for (index, row) in table.rows.iter().enumerate() {
                if row.len() != table.headers.len() {
                    return Err(OfficeError::TableRowWidth {
                        table: table.title.clone(),
                        row: index,
                        cells: row.len(),
                        headers: table.headers.len(),
                    });
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn section(key: &str) -> DocxSection {
        DocxSection::new(key, format!("Title {key}"), 1).with_paragraph("Body")
    }

    #[test]
    fn a_valid_document_passes_and_finds_sections() {
        let mut document = DocxSpec::new("Incident report");
        document.subtitle = Some("INC-2026-0001".to_owned());
        document.sections = vec![section("summary").required(), section("impact")];
        document.tables = vec![DocxTable {
            rows_path: Some("incident.affectedServices".to_owned()),
            ..DocxTable::new("Affected services", ["Service", "Impact"])
        }];
        document.tables[0]
            .rows
            .push(vec!["checkout".to_owned(), "degraded".to_owned()]);
        document.validate().expect("document validates");
        assert_eq!(
            document.section("impact").map(|found| found.title.as_str()),
            Some("Title impact")
        );
        assert!(document.section("missing").is_none());
        assert!(document.empty_required_sections().is_empty());
        assert_eq!(document.schema_version, 1);
        assert_eq!(document.mode, "DOCX");
    }

    #[test]
    fn missing_required_text_is_reported_without_blocking_render() {
        let mut document = DocxSpec::new("Incident report");
        let mut empty = DocxSection::new("summary", "Summary", 1).required();
        empty.paragraphs.push("  ".to_owned());
        document.sections = vec![empty];
        document.validate().expect("structure is valid");
        assert_eq!(document.empty_required_sections(), vec!["summary"]);
    }

    #[test]
    fn structural_problems_are_rejected() {
        assert_eq!(DocxSpec::default().validate(), Err(OfficeError::EmptyTitle));
        let mut duplicate = DocxSpec::new("T");
        duplicate.sections = vec![section("summary"), section("summary")];
        assert_eq!(
            duplicate.validate(),
            Err(OfficeError::DuplicateSectionKey("summary".to_owned()))
        );
        let mut heading = DocxSpec::new("T");
        heading.sections = vec![DocxSection::new("s", "S", 4)];
        assert_eq!(heading.validate(), Err(OfficeError::InvalidHeadingLevel(4)));
        let mut width = DocxSpec::new("T");
        let mut table = DocxTable::new("T", ["a", "b"]);
        table.rows.push(vec!["only one".to_owned()]);
        width.tables = vec![table];
        assert_eq!(
            width.validate(),
            Err(OfficeError::TableRowWidth {
                table: "T".to_owned(),
                row: 0,
                cells: 1,
                headers: 2,
            })
        );
        let mut mode = DocxSpec::new("T");
        mode.mode = "XLSX".to_owned();
        assert_eq!(
            mode.validate(),
            Err(OfficeError::InvalidDocxMode("XLSX".to_owned()))
        );
    }
}
