//! Buffered multipart/form-data parsing for the merchant upload routes.
//!
//! Port of the `multer` memory-storage behaviour used by `merchant-back/api/upload.ts`:
//! `limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 32 }`, the field allow-lists of
//! `uploadSingle(field)` / `uploadSingleAny(fields)`, and the `LIMIT_*` mapping.
//!
//! The edge refuses an oversized `Content-Length` and a credential that is not shaped like a live
//! merchant session **before** this parser runs (see `crate::routes::upload`), so the buffer this
//! module sees is already bounded. It still re-checks every size while walking the body.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::error::EdgeApiError;

/// Hard cap on non-file fields (`fields: 32` in the multer limits).
pub const MAX_FIELDS: usize = 32;
/// Cap on header bytes of one part.
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// One file part.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedPart {
    pub field: String,
    pub filename: String,
    pub content_type: Option<String>,
    pub bytes: Vec<u8>,
}

/// The parsed body: non-file fields plus the accepted file parts.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedMultipart {
    pub fields: Map<String, Value>,
    pub files: Vec<UploadedPart>,
}

impl ParsedMultipart {
    /// The first file whose field is accepted (`req.file` after `uploadSingle*`).
    #[must_use]
    pub fn file_for(&self, accepted: &[&str]) -> Option<&UploadedPart> {
        self.files
            .iter()
            .find(|file| accepted.contains(&file.field.as_str()))
    }
}

/// Multer `limits` expressed for this parser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UploadLimits {
    pub max_file_bytes: u64,
    pub max_parts: usize,
}

impl UploadLimits {
    #[must_use]
    pub fn with_file_limit(max_file_bytes: u64) -> Self {
        Self {
            max_file_bytes,
            max_parts: MAX_FIELDS + 1,
        }
    }
}

/// Parse a request body. `accepted_fields` is the multer field allow-list; a file in any other
/// field is `LIMIT_UNEXPECTED_FIELD`.
pub fn parse(
    content_type: Option<&str>,
    body: &[u8],
    limits: UploadLimits,
    accepted_fields: &[&str],
) -> Result<ParsedMultipart, EdgeApiError> {
    let Some(content_type) = content_type.filter(|value| !value.trim().is_empty()) else {
        return Ok(ParsedMultipart::default());
    };
    if !content_type
        .trim()
        .to_ascii_lowercase()
        .starts_with("multipart/form-data")
    {
        // Multer passes a non-multipart body through; the handler then answers UPLOAD_REQUIRED.
        return Ok(ParsedMultipart::default());
    }
    let boundary = pg_edge::multipart::extract_boundary(content_type)
        .map_err(|_| multer_error("LIMIT_UNEXPECTED_FILE"))?;
    let boundary = boundary.into_bytes();
    let mut parsed = ParsedMultipart::default();
    let mut cursor = 0usize;
    let mut part_count = 0usize;

    // A preamble before the first boundary is allowed by RFC 7578.
    let first = find(&body[cursor..], &prefixed(b"--", &boundary))
        .ok_or_else(|| multer_error("MULTIPART_BOUNDARY"))?;
    cursor += first + 2 + boundary.len();

    loop {
        if body.get(cursor..cursor.saturating_add(2)) == Some(&b"--"[..]) {
            return Ok(parsed);
        }
        if body.get(cursor..cursor.saturating_add(2)) != Some(&b"\r\n"[..]) {
            return Err(multer_error("MULTIPART_BOUNDARY"));
        }
        cursor += 2;
        part_count += 1;
        if part_count > limits.max_parts {
            return Err(multer_error("LIMIT_PART_COUNT"));
        }
        let header_end =
            find(&body[cursor..], b"\r\n\r\n").ok_or_else(|| multer_error("MULTIPART_HEADER"))?;
        if header_end > MAX_HEADER_BYTES {
            return Err(multer_error("MULTIPART_HEADER"));
        }
        let header = &body[cursor..cursor + header_end];
        cursor += header_end + 4;
        let disposition = parse_disposition(header);
        let next = find(&body[cursor..], &prefixed(b"\r\n--", &boundary))
            .ok_or_else(|| multer_error("MULTIPART_BOUNDARY"))?;
        let bytes = &body[cursor..cursor + next];
        cursor += next + 4 + boundary.len();

        let Some(field) = disposition.name else {
            return Err(multer_error("MULTIPART_HEADER"));
        };
        match disposition.filename {
            Some(filename) => {
                if !accepted_fields.contains(&field.as_str()) {
                    return Err(multer_error("LIMIT_UNEXPECTED_FILE"));
                }
                if bytes.len() as u64 > limits.max_file_bytes {
                    return Err(multer_error("LIMIT_FILE_SIZE"));
                }
                if parsed.files.iter().any(|existing| existing.field == field) {
                    // `maxCount: 1`.
                    return Err(multer_error("LIMIT_UNEXPECTED_FILE"));
                }
                parsed.files.push(UploadedPart {
                    field,
                    filename,
                    content_type: parse_content_type(header),
                    bytes: bytes.to_vec(),
                });
            }
            None => {
                let text = String::from_utf8_lossy(bytes).into_owned();
                match parsed.fields.get_mut(&field) {
                    Some(Value::Array(items)) => items.push(Value::String(text)),
                    Some(existing) => {
                        let first = existing.take();
                        *existing = Value::Array(vec![first, Value::String(text)]);
                    }
                    None => {
                        parsed.fields.insert(field, Value::String(text));
                    }
                }
                if parsed.fields.len() > MAX_FIELDS {
                    return Err(multer_error("LIMIT_FIELD_COUNT"));
                }
            }
        }
    }
}

fn multer_error(code: &str) -> EdgeApiError {
    let error = pg_edge::upload_error(Some(code), pg_edge::UploadKind::Document);
    if code == "LIMIT_FILE_SIZE" {
        // `upload_error` already maps this; keep the branch explicit for readability.
        return EdgeApiError::from_edge(error);
    }
    if code == "LIMIT_UNEXPECTED_FILE" {
        return EdgeApiError::from_edge(error);
    }
    EdgeApiError::from_edge(pg_edge::EdgeError::UploadInvalid)
}

fn prefixed(prefix: &[u8], suffix: &[u8]) -> Vec<u8> {
    let mut output = prefix.to_vec();
    output.extend_from_slice(suffix);
    output
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[derive(Debug, Default)]
struct Disposition {
    name: Option<String>,
    filename: Option<String>,
}

fn header_value<'a>(header: &'a [u8], name: &str) -> Option<&'a str> {
    let text = std::str::from_utf8(header).ok()?;
    for line in text.split("\r\n") {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case(name) {
            return Some(value.trim());
        }
    }
    None
}

fn parse_content_type(header: &[u8]) -> Option<String> {
    header_value(header, "content-type")
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn parse_disposition(header: &[u8]) -> Disposition {
    let Some(value) = header_value(header, "content-disposition") else {
        return Disposition::default();
    };
    let mut disposition = Disposition::default();
    for parameter in value.split(';').skip(1) {
        let Some((key, raw)) = parameter.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = unquote(raw.trim());
        match key.as_str() {
            "name" => disposition.name = Some(value),
            "filename" => disposition.filename = Some(value),
            _ => {}
        }
    }
    disposition
}

fn unquote(raw: &str) -> String {
    let raw = raw.trim();
    let Some(inner) = raw
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return raw.to_owned();
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    type TestPart<'a> = (&'a str, Option<(&'a str, &'a str)>, &'a [u8]);

    fn body(parts: &[TestPart<'_>]) -> (String, Vec<u8>) {
        let boundary = "----edgeboundary123";
        let mut output = Vec::new();
        for (name, file, bytes) in parts {
            output.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            match file {
                Some((filename, mime)) => output.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {mime}\r\n\r\n"
                    )
                    .as_bytes(),
                ),
                None => output.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                ),
            }
            output.extend_from_slice(bytes);
            output.extend_from_slice(b"\r\n");
        }
        output.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        (format!("multipart/form-data; boundary={boundary}"), output)
    }

    #[test]
    fn parses_fields_and_one_file() {
        let (content_type, raw) = body(&[
            ("documentType", None, b"OTHER"),
            (
                "document",
                Some(("x.png", "image/png")),
                b"\x89PNG\r\n\x1a\npayload",
            ),
        ]);
        let parsed = parse(
            Some(&content_type),
            &raw,
            UploadLimits::with_file_limit(1024),
            &["document"],
        )
        .expect("parsed");
        assert_eq!(
            parsed.fields.get("documentType"),
            Some(&Value::String("OTHER".to_owned()))
        );
        let file = parsed.file_for(&["document"]).expect("file");
        assert_eq!(file.filename, "x.png");
        assert_eq!(file.content_type.as_deref(), Some("image/png"));
        assert_eq!(file.bytes, b"\x89PNG\r\n\x1a\npayload");
    }

    #[test]
    fn rejects_a_file_in_an_unexpected_field() {
        let (content_type, raw) = body(&[("other", Some(("x.png", "image/png")), b"abc")]);
        let error = parse(
            Some(&content_type),
            &raw,
            UploadLimits::with_file_limit(1024),
            &["document"],
        )
        .expect_err("unexpected field");
        assert_eq!(error.code, "UPLOAD_UNEXPECTED_FIELD");
        assert_eq!(error.status, 400);
    }

    #[test]
    fn rejects_an_oversized_file() {
        let (content_type, raw) = body(&[("document", Some(("x.png", "image/png")), b"abcdef")]);
        let error = parse(
            Some(&content_type),
            &raw,
            UploadLimits::with_file_limit(3),
            &["document"],
        )
        .expect_err("too large");
        assert_eq!(error.code, "UPLOAD_TOO_LARGE");
        assert_eq!(error.status, 413);
    }

    #[test]
    fn missing_file_yields_no_file_instead_of_an_error() {
        let (content_type, raw) = body(&[("documentType", None, b"OTHER")]);
        let parsed = parse(
            Some(&content_type),
            &raw,
            UploadLimits::with_file_limit(1024),
            &["document"],
        )
        .expect("parsed");
        assert!(parsed.file_for(&["document"]).is_none());
        assert_eq!(
            parsed.fields.get("documentType"),
            Some(&Value::String("OTHER".to_owned()))
        );
    }

    #[test]
    fn non_multipart_bodies_pass_through_like_multer() {
        let parsed = parse(
            Some("application/json"),
            b"{}",
            UploadLimits::with_file_limit(1024),
            &["document"],
        )
        .expect("pass through");
        assert!(parsed.files.is_empty());
        assert!(parsed.fields.is_empty());
    }

    #[test]
    fn repeated_fields_become_an_array() {
        let (content_type, raw) = body(&[("tag", None, b"a"), ("tag", None, b"b")]);
        let parsed = parse(
            Some(&content_type),
            &raw,
            UploadLimits::with_file_limit(1024),
            &["document"],
        )
        .expect("parsed");
        assert_eq!(
            parsed.fields.get("tag"),
            Some(&Value::Array(vec![
                Value::String("a".to_owned()),
                Value::String("b".to_owned()),
            ]))
        );
    }
}
