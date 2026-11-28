//! Shared office-document errors.
//!
//! One error type for the DOCX and XLSX structures so the compliance layer can surface a single
//! `400` with a stable code (the TS writers throw `Error` with a message).

#![forbid(unsafe_code)]

/// A document that cannot be rendered faithfully.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OfficeError {
    /// `mode` is not `DOCX`.
    #[error("The DOCX document mode must be DOCX, found '{0}'")]
    InvalidDocxMode(String),
    /// The document title is blank.
    #[error("The document title is empty")]
    EmptyTitle,
    /// A section key is blank.
    #[error("Document section \"{0}\" has an empty key")]
    EmptySectionKey(String),
    /// Two sections share a key.
    #[error("Document section key \"{0}\" is used more than once")]
    DuplicateSectionKey(String),
    /// A section title is blank.
    #[error("Document section \"{0}\" has an empty title")]
    EmptySectionTitle(String),
    /// A heading level outside 1..=3.
    #[error("Heading level {0} is outside 1..=3")]
    InvalidHeadingLevel(u8),
    /// A table without headers.
    #[error("Table \"{0}\" has no headers")]
    EmptyTableHeaders(String),
    /// A table row whose width differs from the header count.
    #[error("Table \"{table}\" row {row} has {cells} cells for {headers} headers")]
    TableRowWidth {
        /// The table title.
        table: String,
        /// The zero-based row index.
        row: usize,
        /// Cells in the row.
        cells: usize,
        /// Declared headers.
        headers: usize,
    },
    /// A sheet name Excel would refuse.
    #[error("Sheet name \"{0}\" is not a valid Excel title")]
    InvalidSheetName(String),
    /// Two sheets share a name.
    #[error("Sheet name \"{0}\" is used more than once")]
    DuplicateSheetName(String),
    /// Two sheets share an order.
    #[error("Sheet order {0} is used more than once")]
    DuplicateSheetOrder(u32),
    /// A column key is blank or duplicated.
    #[error("Sheet \"{sheet}\" column \"{column}\" is declared more than once")]
    DuplicateColumn {
        /// The sheet name.
        sheet: String,
        /// The column key.
        column: String,
    },
    /// A row uses a column the sheet does not declare.
    #[error("Sheet \"{sheet}\" row {row} uses unknown column \"{column}\"")]
    UnknownColumn {
        /// The sheet name.
        sheet: String,
        /// The zero-based row index.
        row: usize,
        /// The unknown key.
        column: String,
    },
    /// A required column has an empty cell.
    #[error("Sheet \"{sheet}\" row {row} is missing the required column \"{column}\"")]
    MissingRequiredCell {
        /// The sheet name.
        sheet: String,
        /// The zero-based row index.
        row: usize,
        /// The column key.
        column: String,
    },
    /// A list column without allowed values.
    #[error("Sheet \"{sheet}\" list column \"{column}\" has no allowed values")]
    EmptyListColumn {
        /// The sheet name.
        sheet: String,
        /// The column key.
        column: String,
    },
    /// A total that references an unknown column.
    #[error("Sheet \"{sheet}\" total references unknown column \"{column}\"")]
    UnknownTotalColumn {
        /// The sheet name.
        sheet: String,
        /// The column key.
        column: String,
    },
    /// A total on a non-numeric column.
    #[error("Sheet \"{sheet}\" total column \"{column}\" is not numeric")]
    NonNumericTotal {
        /// The sheet name.
        sheet: String,
        /// The column key.
        column: String,
    },
}

impl OfficeError {
    /// A stable API code (`OFFICE_*`).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::InvalidDocxMode(_) => "OFFICE_DOCX_MODE_INVALID",
            Self::EmptyTitle => "OFFICE_TITLE_EMPTY",
            Self::EmptySectionKey(_) => "OFFICE_SECTION_KEY_EMPTY",
            Self::DuplicateSectionKey(_) => "OFFICE_SECTION_KEY_DUPLICATE",
            Self::EmptySectionTitle(_) => "OFFICE_SECTION_TITLE_EMPTY",
            Self::InvalidHeadingLevel(_) => "OFFICE_HEADING_LEVEL_INVALID",
            Self::EmptyTableHeaders(_) => "OFFICE_TABLE_HEADERS_EMPTY",
            Self::TableRowWidth { .. } => "OFFICE_TABLE_ROW_WIDTH",
            Self::InvalidSheetName(_) => "OFFICE_SHEET_NAME_INVALID",
            Self::DuplicateSheetName(_) => "OFFICE_SHEET_NAME_DUPLICATE",
            Self::DuplicateSheetOrder(_) => "OFFICE_SHEET_ORDER_DUPLICATE",
            Self::DuplicateColumn { .. } => "OFFICE_COLUMN_DUPLICATE",
            Self::UnknownColumn { .. } => "OFFICE_COLUMN_UNKNOWN",
            Self::MissingRequiredCell { .. } => "OFFICE_CELL_REQUIRED",
            Self::EmptyListColumn { .. } => "OFFICE_LIST_EMPTY",
            Self::UnknownTotalColumn { .. } => "OFFICE_TOTAL_COLUMN_UNKNOWN",
            Self::NonNumericTotal { .. } => "OFFICE_TOTAL_NON_NUMERIC",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable() {
        assert_eq!(OfficeError::EmptyTitle.code(), "OFFICE_TITLE_EMPTY");
        assert_eq!(
            OfficeError::TableRowWidth {
                table: "t".to_owned(),
                row: 0,
                cells: 1,
                headers: 2
            }
            .code(),
            "OFFICE_TABLE_ROW_WIDTH"
        );
        assert_eq!(
            OfficeError::MissingRequiredCell {
                sheet: "s".to_owned(),
                row: 3,
                column: "c".to_owned()
            }
            .to_string(),
            "Sheet \"s\" row 3 is missing the required column \"c\""
        );
    }
}
