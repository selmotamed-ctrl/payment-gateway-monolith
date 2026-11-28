//! Streaming multipart metadata parser.
//!
//! Port of the multipart handling in `{admin,merchant}-back/api/upload.ts` (multer memory storage
//! with `limits: { fileSize, files: 1, fields: 32 }`), re-implemented as a streaming scanner:
//! **file bytes are never buffered** — only the bytes of the current part header and at most
//! `delimiter.len() - 1` trailing bytes are retained between chunks. The scanner reports part
//! name, filename, content type and byte size, and refuses a missing boundary, a missing closing
//! boundary, an oversized part and an oversized total body.
//!
//! Multer itself buffers the file, which is exactly why the TypeScript guards run before the
//! parser. The Rust parser can be fed the request stream directly; callers that already buffered
//! can use [`scan_multipart`].
//!
//! Delimiter grammar (RFC 7578 / busboy):
//! ```text
//! --BOUNDARY\r\n
//! Content-Disposition: form-data; name="file"; filename="a.csv"\r\n
//! Content-Type: text/csv\r\n
//! \r\n
//! <bytes>\r\n
//! --BOUNDARY\r\n
//! …\r\n
//! --BOUNDARY--\r\n
//! ```

#![forbid(unsafe_code)]

use std::collections::HashMap;

use thiserror::Error;

use crate::error::{EdgeError, UploadKind};

pub const DEFAULT_MAX_HEADER_BYTES: usize = 16 * 1024;
/// One file plus 32 non-file fields, matching the multer limits.
pub const DEFAULT_MAX_PARTS: usize = 33;
/// Busboy's boundary limit is 70; allow a little more but stay bounded.
pub const MAX_BOUNDARY_BYTES: usize = 200;
const MAX_PREAMBLE_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MultipartLimits {
    pub max_part_bytes: u64,
    pub max_total_bytes: u64,
    pub max_header_bytes: usize,
    pub max_parts: usize,
}

impl MultipartLimits {
    /// `files: 1` semantics with the multipart framing budget on top.
    #[must_use]
    pub fn with_file_limit(max_part_bytes: u64) -> Self {
        Self {
            max_part_bytes,
            max_total_bytes: max_part_bytes.saturating_add(256 * 1024),
            max_header_bytes: DEFAULT_MAX_HEADER_BYTES,
            max_parts: DEFAULT_MAX_PARTS,
        }
    }
}

impl Default for MultipartLimits {
    fn default() -> Self {
        Self::with_file_limit(10 * 1024 * 1024)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MultipartError {
    #[error("The request has no Content-Type")]
    MissingContentType,
    #[error("The multipart Content-Type is not form-data")]
    NotMultipart,
    #[error("The multipart Content-Type has no boundary")]
    MissingBoundary,
    #[error("The multipart boundary is invalid")]
    InvalidBoundary,
    #[error("A part header exceeds the header limit")]
    HeaderTooLarge,
    #[error("The multipart payload has too many parts")]
    TooManyParts,
    #[error("A part exceeds {limit} bytes")]
    TooLarge { limit: u64 },
    #[error("The multipart payload is malformed: {0}")]
    Malformed(&'static str),
    #[error("The upload field is invalid")]
    InvalidField,
}

impl MultipartError {
    /// Map to the client-visible edge error (`UPLOAD_INVALID` or `UPLOAD_TOO_LARGE`).
    #[must_use]
    pub fn to_edge_error(&self, kind: UploadKind) -> EdgeError {
        match self {
            Self::TooLarge { .. } => EdgeError::UploadTooLarge(kind),
            _ => EdgeError::UploadInvalid,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartMetadata {
    pub name: Option<String>,
    pub filename: Option<String>,
    pub content_type: Option<String>,
    pub size: u64,
}

impl PartMetadata {
    #[must_use]
    pub fn is_file(&self) -> bool {
        self.filename.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MultipartMetadata {
    pub parts: Vec<PartMetadata>,
}

impl MultipartMetadata {
    /// The first part carrying a filename (multer's `req.file`).
    #[must_use]
    pub fn file(&self) -> Option<&PartMetadata> {
        self.parts.iter().find(|part| part.is_file())
    }

    #[must_use]
    pub fn total_bytes(&self) -> u64 {
        self.parts.iter().map(|part| part.size).sum()
    }
}

#[derive(Debug, Clone)]
struct PartBuilder {
    name: Option<String>,
    filename: Option<String>,
    content_type: Option<String>,
    size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Preamble,
    Headers,
    Body,
    AfterDelimiter,
    Done,
}

/// A streaming multipart scanner. Feed request chunks with [`Self::feed`], then [`Self::finish`].
#[derive(Debug)]
pub struct MultipartScanner {
    first_delimiter: Vec<u8>,
    body_delimiter: Vec<u8>,
    state: ScanState,
    buffer: Vec<u8>,
    current: Option<PartBuilder>,
    parts: Vec<PartMetadata>,
    limits: MultipartLimits,
    total_body_bytes: u64,
    preamble_bytes: u64,
}

impl MultipartScanner {
    pub fn new(content_type: &str, limits: MultipartLimits) -> Result<Self, MultipartError> {
        let boundary = extract_boundary(content_type)?;
        let mut first_delimiter = b"--".to_vec();
        first_delimiter.extend_from_slice(boundary.as_bytes());
        let mut body_delimiter = b"\r\n--".to_vec();
        body_delimiter.extend_from_slice(boundary.as_bytes());
        Ok(Self {
            first_delimiter,
            body_delimiter,
            state: ScanState::Preamble,
            buffer: Vec::new(),
            current: None,
            parts: Vec::new(),
            limits,
            total_body_bytes: 0,
            preamble_bytes: 0,
        })
    }

    /// Feed the next bytes of the body. Nothing is retained except the current header block and a
    /// possible partial delimiter.
    pub fn feed(&mut self, chunk: &[u8]) -> Result<(), MultipartError> {
        if chunk.is_empty() || self.state == ScanState::Done {
            return Ok(());
        }
        self.buffer.extend_from_slice(chunk);
        self.scan()
    }

    /// Validate the closing boundary and return the captured metadata.
    pub fn finish(mut self) -> Result<MultipartMetadata, MultipartError> {
        // Drain whatever is left so an over-limit tail is still detected.
        self.scan()?;
        if self.state != ScanState::Done {
            return Err(MultipartError::Malformed(
                "the multipart body ended before the closing boundary",
            ));
        }
        Ok(MultipartMetadata { parts: self.parts })
    }

    fn scan(&mut self) -> Result<(), MultipartError> {
        loop {
            match self.state {
                ScanState::Preamble => {
                    if let Some(position) = find(&self.buffer, &self.first_delimiter) {
                        self.preamble_bytes = self
                            .preamble_bytes
                            .saturating_add(u64::try_from(position).unwrap_or(u64::MAX));
                        if self.preamble_bytes > MAX_PREAMBLE_BYTES {
                            return Err(MultipartError::Malformed("the preamble is too long"));
                        }
                        let end = position + self.first_delimiter.len();
                        self.buffer.drain(..end);
                        self.state = ScanState::AfterDelimiter;
                        continue;
                    }
                    let keep = self.first_delimiter.len().saturating_sub(1);
                    if self.buffer.len() > keep {
                        let drain = self.buffer.len() - keep;
                        self.preamble_bytes = self
                            .preamble_bytes
                            .saturating_add(u64::try_from(drain).unwrap_or(u64::MAX));
                        if self.preamble_bytes > MAX_PREAMBLE_BYTES {
                            return Err(MultipartError::Malformed("the preamble is too long"));
                        }
                        self.buffer.drain(..drain);
                    }
                    return Ok(());
                }
                ScanState::Headers => {
                    if let Some(position) = find(&self.buffer, b"\r\n\r\n") {
                        if position > self.limits.max_header_bytes {
                            return Err(MultipartError::HeaderTooLarge);
                        }
                        let headers: Vec<u8> = self.buffer.drain(..position).collect();
                        self.buffer.drain(..4);
                        self.start_part(&headers)?;
                        self.state = ScanState::Body;
                        continue;
                    }
                    if self.buffer.len() > self.limits.max_header_bytes {
                        return Err(MultipartError::HeaderTooLarge);
                    }
                    return Ok(());
                }
                ScanState::Body => {
                    if let Some(position) = find(&self.buffer, &self.body_delimiter) {
                        self.add_body_bytes(u64::try_from(position).unwrap_or(u64::MAX))?;
                        let end = position + self.body_delimiter.len();
                        self.buffer.drain(..end);
                        self.finish_part();
                        self.state = ScanState::AfterDelimiter;
                        continue;
                    }
                    let keep = self.body_delimiter.len().saturating_sub(1);
                    if self.buffer.len() > keep {
                        let drain = self.buffer.len() - keep;
                        self.add_body_bytes(u64::try_from(drain).unwrap_or(u64::MAX))?;
                        self.buffer.drain(..drain);
                    }
                    return Ok(());
                }
                ScanState::AfterDelimiter => {
                    if self.buffer.len() < 2 {
                        return Ok(());
                    }
                    if self.buffer.starts_with(b"--") {
                        self.buffer.drain(..2);
                        self.buffer.clear();
                        self.state = ScanState::Done;
                        return Ok(());
                    }
                    if self.buffer.starts_with(b"\r\n") {
                        self.buffer.drain(..2);
                        self.state = ScanState::Headers;
                        continue;
                    }
                    return Err(MultipartError::Malformed(
                        "the boundary is not followed by CRLF or --",
                    ));
                }
                ScanState::Done => {
                    self.buffer.clear();
                    return Ok(());
                }
            }
        }
    }

    fn start_part(&mut self, header_bytes: &[u8]) -> Result<(), MultipartError> {
        if self.parts.len() + 1 > self.limits.max_parts {
            return Err(MultipartError::TooManyParts);
        }
        let headers = parse_part_headers(header_bytes);
        let (name, filename) = match headers.get("content-disposition") {
            Some(value) => parse_content_disposition(value),
            None => (None, None),
        };
        self.current = Some(PartBuilder {
            name,
            filename,
            content_type: headers.get("content-type").cloned(),
            size: 0,
        });
        Ok(())
    }

    fn finish_part(&mut self) {
        let Some(part) = self.current.take() else {
            return;
        };
        self.parts.push(PartMetadata {
            name: part.name,
            filename: part.filename,
            content_type: part.content_type,
            size: part.size,
        });
    }

    fn add_body_bytes(&mut self, count: u64) -> Result<(), MultipartError> {
        self.total_body_bytes = self.total_body_bytes.saturating_add(count);
        if self.total_body_bytes > self.limits.max_total_bytes {
            return Err(MultipartError::TooLarge {
                limit: self.limits.max_total_bytes,
            });
        }
        let Some(current) = self.current.as_mut() else {
            return Err(MultipartError::Malformed(
                "body bytes arrived before the part header",
            ));
        };
        current.size = current.size.saturating_add(count);
        if current.size > self.limits.max_part_bytes {
            return Err(MultipartError::TooLarge {
                limit: self.limits.max_part_bytes,
            });
        }
        Ok(())
    }
}

/// Convenience for an already buffered body (tests, or a body that was read for another reason).
pub fn scan_multipart(
    content_type: &str,
    body: &[u8],
    limits: MultipartLimits,
) -> Result<MultipartMetadata, MultipartError> {
    let mut scanner = MultipartScanner::new(content_type, limits)?;
    scanner.feed(body)?;
    scanner.finish()
}

/// Extract the `boundary` parameter of a `multipart/form-data` content type.
pub fn extract_boundary(content_type: &str) -> Result<String, MultipartError> {
    let content_type = content_type.trim();
    if content_type.is_empty() {
        return Err(MultipartError::MissingContentType);
    }
    let mut segments = content_type.split(';');
    let media_type = segments.next().unwrap_or_default().trim();
    if !media_type.eq_ignore_ascii_case("multipart/form-data") {
        return Err(MultipartError::NotMultipart);
    }
    for segment in segments {
        let Some((name, raw)) = segment.split_once('=') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("boundary") {
            continue;
        }
        let boundary = unquote(raw.trim());
        validate_boundary(&boundary)?;
        return Ok(boundary);
    }
    Err(MultipartError::MissingBoundary)
}

fn validate_boundary(boundary: &str) -> Result<(), MultipartError> {
    if boundary.is_empty()
        || boundary.len() > MAX_BOUNDARY_BYTES
        || boundary.ends_with(' ')
        || !boundary
            .bytes()
            .all(|byte| byte == b' ' || (0x21..=0x7e).contains(&byte))
    {
        return Err(MultipartError::InvalidBoundary);
    }
    Ok(())
}

fn unquote(raw: &str) -> String {
    if raw.len() < 2 || !raw.starts_with('"') || !raw.ends_with('"') {
        return raw.to_owned();
    }
    let inner = &raw[1..raw.len() - 1];
    let mut output = String::with_capacity(inner.len());
    let mut escaped = false;
    for character in inner.chars() {
        if escaped {
            output.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            output.push(character);
        }
    }
    output
}

fn parse_part_headers(header_bytes: &[u8]) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    let text = String::from_utf8_lossy(header_bytes);
    for line in text.split("\r\n") {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    headers
}

fn parse_content_disposition(value: &str) -> (Option<String>, Option<String>) {
    let mut segments = value.split(';');
    let kind = segments.next().unwrap_or_default().trim();
    if !kind.eq_ignore_ascii_case("form-data") {
        return (None, None);
    }
    let mut name = None;
    let mut filename = None;
    for segment in segments {
        let Some((key, raw)) = segment.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.eq_ignore_ascii_case("name") {
            name = Some(unquote(raw.trim()));
        } else if key.eq_ignore_ascii_case("filename") {
            filename = Some(unquote(raw.trim()));
        }
    }
    (name, filename)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOUNDARY: &str = "----pgBoundary7MA4YWxkTrZu0gW";

    type TestPart<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [u8]);

    fn body(parts: &[TestPart<'_>]) -> Vec<u8> {
        let mut output = Vec::new();
        for (name, filename, content_type, content) in parts {
            output.extend_from_slice(format!("--{BOUNDARY}\r\n").as_bytes());
            match filename {
                Some(filename) => output.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\n"
                    )
                    .as_bytes(),
                ),
                None => output.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n").as_bytes(),
                ),
            }
            if let Some(content_type) = content_type {
                output.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
            }
            output.extend_from_slice(b"\r\n");
            output.extend_from_slice(content);
            output.extend_from_slice(b"\r\n");
        }
        output.extend_from_slice(format!("--{BOUNDARY}--\r\n").as_bytes());
        output
    }

    fn limits() -> MultipartLimits {
        MultipartLimits {
            max_part_bytes: 1_024,
            max_total_bytes: 4_096,
            ..MultipartLimits::default()
        }
    }

    #[test]
    fn boundary_extraction() {
        assert_eq!(
            extract_boundary(&format!("multipart/form-data; boundary={BOUNDARY}")),
            Ok(BOUNDARY.to_owned())
        );
        assert_eq!(
            extract_boundary("Multipart/Form-Data; charset=utf-8; boundary=\"abc\""),
            Ok("abc".to_owned())
        );
        assert_eq!(
            extract_boundary("multipart/form-data"),
            Err(MultipartError::MissingBoundary)
        );
        assert_eq!(
            extract_boundary("application/json"),
            Err(MultipartError::NotMultipart)
        );
        assert_eq!(
            extract_boundary(""),
            Err(MultipartError::MissingContentType)
        );
        assert_eq!(
            extract_boundary("multipart/form-data; boundary="),
            Err(MultipartError::InvalidBoundary)
        );
        assert_eq!(
            extract_boundary("multipart/form-data; boundary=\"a b\""),
            Ok("a b".to_owned())
        );
    }

    #[test]
    fn single_file_metadata() {
        let payload = body(&[(
            "file",
            Some("statement.csv"),
            Some("text/csv"),
            b"a,b\n1,2\n",
        )]);
        let metadata = scan_multipart(
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            &payload,
            limits(),
        )
        .expect("parses");
        assert_eq!(metadata.parts.len(), 1);
        let part = metadata.file().expect("file part");
        assert_eq!(part.name.as_deref(), Some("file"));
        assert_eq!(part.filename.as_deref(), Some("statement.csv"));
        assert_eq!(part.content_type.as_deref(), Some("text/csv"));
        assert_eq!(part.size, 8);
        assert_eq!(metadata.total_bytes(), 8);
    }

    #[test]
    fn field_and_files_are_all_captured() {
        let payload = body(&[
            ("note", None, None, b"hello"),
            ("file", Some("a.pdf"), Some("application/pdf"), b"%PDF-1.7"),
            (
                "other",
                Some("b.bin"),
                Some("application/octet-stream"),
                &[0_u8, 1, 2, 255],
            ),
        ]);
        let metadata = scan_multipart(
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            &payload,
            limits(),
        )
        .expect("parses");
        assert_eq!(metadata.parts.len(), 3);
        assert_eq!(metadata.parts[0].name.as_deref(), Some("note"));
        assert!(!metadata.parts[0].is_file());
        assert_eq!(metadata.parts[1].size, 8);
        assert_eq!(metadata.parts[2].size, 4);
        assert_eq!(
            metadata.file().and_then(|p| p.filename.as_deref()),
            Some("a.pdf")
        );
    }

    #[test]
    fn chunking_never_changes_the_result() {
        let payload = body(&[(
            "file",
            Some("a b.csv"),
            Some("text/csv"),
            b"0123456789\r\n--not-a-boundary",
        )]);
        let content_type = format!("multipart/form-data; boundary={BOUNDARY}");
        let expected = scan_multipart(&content_type, &payload, limits()).expect("whole body");

        for chunk_size in [1_usize, 2, 3, 5, 7, 11, 13, 64, 1_024] {
            let mut scanner = MultipartScanner::new(&content_type, limits()).expect("scanner");
            for chunk in payload.chunks(chunk_size) {
                scanner.feed(chunk).expect("chunk");
            }
            assert_eq!(
                scanner.finish().expect("finish"),
                expected,
                "chunk={chunk_size}"
            );
        }
    }

    #[test]
    fn missing_closing_boundary_is_rejected() {
        let mut payload = body(&[("file", Some("a.csv"), Some("text/csv"), b"x")]);
        payload.truncate(payload.len() - (BOUNDARY.len() + 6));
        let error = scan_multipart(
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            &payload,
            limits(),
        )
        .expect_err("truncated");
        assert!(matches!(error, MultipartError::Malformed(_)));
    }

    #[test]
    fn oversized_part_is_rejected() {
        let payload = body(&[("file", Some("a.csv"), Some("text/csv"), &[b'x'; 64])]);
        let tight = MultipartLimits {
            max_part_bytes: 10,
            max_total_bytes: 1_000,
            ..limits()
        };
        let error = scan_multipart(
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            &payload,
            tight,
        )
        .expect_err("too large");
        assert_eq!(error, MultipartError::TooLarge { limit: 10 });
        assert_eq!(
            error.to_edge_error(UploadKind::Statement),
            EdgeError::UploadTooLarge(UploadKind::Statement)
        );
    }

    #[test]
    fn too_many_parts_are_rejected() {
        let payload = body(&[
            ("a", None, None, b"1"),
            ("b", None, None, b"2"),
            ("c", None, None, b"3"),
        ]);
        let tight = MultipartLimits {
            max_parts: 2,
            ..limits()
        };
        assert_eq!(
            scan_multipart(
                &format!("multipart/form-data; boundary={BOUNDARY}"),
                &payload,
                tight
            ),
            Err(MultipartError::TooManyParts)
        );
    }

    #[test]
    fn oversized_headers_are_rejected() {
        let mut payload = format!("--{BOUNDARY}\r\nContent-Disposition: form-data; name=\"x\"\r\n");
        payload.push_str(&"A".repeat(200));
        payload.push_str("\r\n\r\nv\r\n");
        payload.push_str(&format!("--{BOUNDARY}--\r\n"));
        let tight = MultipartLimits {
            max_header_bytes: 64,
            ..limits()
        };
        assert_eq!(
            scan_multipart(
                &format!("multipart/form-data; boundary={BOUNDARY}"),
                payload.as_bytes(),
                tight
            ),
            Err(MultipartError::HeaderTooLarge)
        );
    }

    #[test]
    fn quoted_filenames_are_unescaped() {
        let mut payload = format!("--{BOUNDARY}\r\n");
        payload
            .push_str("Content-Disposition: form-data; name=\"file\"; filename=\"a\\\"b.csv\"\r\n");
        payload.push_str("\r\nv\r\n");
        payload.push_str(&format!("--{BOUNDARY}--\r\n"));
        let metadata = scan_multipart(
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            payload.as_bytes(),
            limits(),
        )
        .expect("parses");
        assert_eq!(metadata.parts[0].filename.as_deref(), Some("a\"b.csv"));
    }

    #[test]
    fn empty_multipart_is_valid_and_has_no_file() {
        let payload = format!("--{BOUNDARY}--\r\n");
        let metadata = scan_multipart(
            &format!("multipart/form-data; boundary={BOUNDARY}"),
            payload.as_bytes(),
            limits(),
        )
        .expect("parses");
        assert!(metadata.parts.is_empty());
        assert!(metadata.file().is_none());
    }

    #[test]
    fn malformed_errors_map_to_upload_invalid() {
        for error in [
            MultipartError::MissingContentType,
            MultipartError::NotMultipart,
            MultipartError::MissingBoundary,
            MultipartError::InvalidBoundary,
            MultipartError::HeaderTooLarge,
            MultipartError::TooManyParts,
            MultipartError::Malformed("x"),
        ] {
            assert_eq!(
                error.to_edge_error(UploadKind::Document),
                EdgeError::UploadInvalid
            );
        }
    }

    #[test]
    fn default_limits_are_bounded() {
        let defaults = MultipartLimits::default();
        assert_eq!(defaults.max_part_bytes, 10_485_760);
        assert_eq!(defaults.max_header_bytes, 16_384);
        assert_eq!(defaults.max_parts, 33);
    }
}
