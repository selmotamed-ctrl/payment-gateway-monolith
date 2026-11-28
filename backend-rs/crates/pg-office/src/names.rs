//! Regulatory output names and headers.
//!
//! Port of the regulatory download branch in `core-back/api/internal/admin.ts`
//! (`GET /aml/reports/:id/output`).
//!
//! The office artefacts are served with a hard-coded `report-<id>.<ext>` name (never a user
//! string) and an `X-Content-SHA256` header that pins the bytes the checker approved. XML is
//! served inline without a filename.

#![forbid(unsafe_code)]

/// `X-Content-SHA256` — the SHA-256 of the downloaded artefact.
pub const X_CONTENT_SHA256: &str = "X-Content-SHA256";

/// `report-` — the fixed regulatory output stem.
pub const REGULATORY_FILENAME_PREFIX: &str = "report-";

/// `application/xml; charset=utf-8`.
pub const CONTENT_TYPE_XML: &str = "application/xml; charset=utf-8";
/// `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
pub const CONTENT_TYPE_XLSX: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/// `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
pub const CONTENT_TYPE_DOCX: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// The office formats a regulatory report can be filed as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeFormat {
    /// `.xlsx`.
    Xlsx,
    /// `.docx`.
    Docx,
}

impl OfficeFormat {
    /// `xlsx` / `docx`.
    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Xlsx => "xlsx",
            Self::Docx => "docx",
        }
    }

    /// The download `Content-Type`.
    #[must_use]
    pub const fn content_type(self) -> &'static str {
        match self {
            Self::Xlsx => CONTENT_TYPE_XLSX,
            Self::Docx => CONTENT_TYPE_DOCX,
        }
    }
}

/// `report-<id>.<ext>`.
#[must_use]
pub fn regulatory_filename(report_id: &str, format: OfficeFormat) -> String {
    format!(
        "{REGULATORY_FILENAME_PREFIX}{report_id}.{}",
        format.extension()
    )
}

/// The `Content-Disposition` value for a regulatory office artefact.
#[must_use]
pub fn regulatory_disposition(report_id: &str, format: OfficeFormat) -> String {
    format!(
        "attachment; filename=\"{}\"",
        regulatory_filename(report_id, format)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regulatory_names_are_fixed_per_format() {
        assert_eq!(
            regulatory_filename("0f8fad5b-d9cb-469f-a165-70867728950e", OfficeFormat::Xlsx),
            "report-0f8fad5b-d9cb-469f-a165-70867728950e.xlsx"
        );
        assert_eq!(
            regulatory_filename("0f8fad5b-d9cb-469f-a165-70867728950e", OfficeFormat::Docx),
            "report-0f8fad5b-d9cb-469f-a165-70867728950e.docx"
        );
        assert_eq!(
            regulatory_disposition("abc", OfficeFormat::Docx),
            "attachment; filename=\"report-abc.docx\""
        );
    }

    #[test]
    fn headers_and_content_types_are_the_ts_constants() {
        assert_eq!(X_CONTENT_SHA256, "X-Content-SHA256");
        assert_eq!(CONTENT_TYPE_XML, "application/xml; charset=utf-8");
        assert!(CONTENT_TYPE_XLSX.ends_with("spreadsheetml.sheet"));
        assert!(CONTENT_TYPE_DOCX.ends_with("wordprocessingml.document"));
        assert_eq!(OfficeFormat::Xlsx.content_type(), CONTENT_TYPE_XLSX);
        assert_eq!(OfficeFormat::Xlsx.extension(), "xlsx");
    }
}
