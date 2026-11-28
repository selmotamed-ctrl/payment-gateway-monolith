//! Office document structure for the regulatory reporting engine.
//!
//! Port of `core-back/lib/contentDisposition.ts`, `core-back/lib/docx/regulatoryDocx.ts` and
//! `core-back/lib/xlsx/regulatoryWorkbook.ts` (the data structures only, task P8-T03).
//!
//! - [`content_disposition`] produces the RFC 6266 header value (ASCII fallback plus
//!   `filename*=UTF-8''`) that keeps an Arabic file name from breaking the download.
//! - [`regulatory_filename`] is the fixed `report-<id>.xlsx|docx` name and
//!   [`X_CONTENT_SHA256`] the header that pins the approved bytes.
//! - [`DocxSpec`] and [`XlsxSheet`] are the narrative/workbook descriptions the compliance
//!   generator fills; rendering (`rust_xlsxwriter` / WordprocessingML) is a later step and
//!   deliberately absent here.

#![forbid(unsafe_code)]
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic)
)]

pub mod disposition;
pub mod docx;
pub mod error;
pub mod names;
pub mod xlsx;

pub use disposition::{
    content_disposition, content_disposition_with, encode_rfc5987, DispositionKind, MAX_NAME_CHARS,
};
pub use docx::{DocxSection, DocxSpec, DocxTable, DOCX_MODE, DOCX_SCHEMA_VERSION};
pub use error::OfficeError;
pub use names::{
    regulatory_disposition, regulatory_filename, OfficeFormat, CONTENT_TYPE_DOCX,
    CONTENT_TYPE_XLSX, CONTENT_TYPE_XML, REGULATORY_FILENAME_PREFIX, X_CONTENT_SHA256,
};
pub use xlsx::{
    validate_workbook, TotalFunction, XlsxCell, XlsxCellKind, XlsxColumn, XlsxColumnType, XlsxRow,
    XlsxSheet, XlsxTotal, MAX_SHEET_NAME_CHARS, XLSX_SCHEMA_VERSION,
};
