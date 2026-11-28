//! Multipart parsing, magic-byte sniffing and the `x-upload-*` contract.
//!
//! Port of `admin-back/api/upload.ts`, `admin-back/lib/zReady/index.ts`
//! (`detectUploadMime`, `assertAllowedUpload`) and the asset sniffing in
//! `admin-back/api/protected/assets.ts`.
//!
//! Express/multer buffers the whole file in memory before core sees it, so the edge owns the
//! limits: a declared `Content-Length` above `MAX_UPLOAD_BYTES + 256 KiB` is refused before a byte
//! is read, the multipart parser enforces the file limit while scanning, and the magic bytes must
//! match the declared MIME type.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::error::ApiError;

/// Port of `MULTIPART_OVERHEAD_BYTES`.
pub const MULTIPART_OVERHEAD_BYTES: u64 = 256 * 1024;

/// One file part.
#[derive(Debug, Clone)]
pub struct UploadFile {
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A parsed multipart body.
#[derive(Debug, Clone, Default)]
pub struct MultipartForm {
    pub fields: Vec<(String, String)>,
    pub file: Option<UploadFile>,
}

impl MultipartForm {
    #[must_use]
    pub fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// The fields as a JSON object (multer exposes them on `req.body`).
    #[must_use]
    pub fn fields_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        for (key, value) in &self.fields {
            map.insert(key.clone(), Value::String(value.clone()));
        }
        Value::Object(map)
    }
}

fn boundary_of(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    if !lower.starts_with("multipart/form-data") {
        return None;
    }
    let boundary_index = lower.find("boundary=")?;
    let raw = &content_type[boundary_index + "boundary=".len()..];
    let raw = raw.split(';').next().unwrap_or(raw).trim();
    let raw = raw.trim_matches('"');
    if raw.is_empty() || raw.len() > 200 {
        return None;
    }
    Some(raw.to_owned())
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let mut index = from;
    while index + needle.len() <= haystack.len() {
        if &haystack[index..index + needle.len()] == needle {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn parse_disposition(value: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut filename = None;
    for part in value.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix("name=") {
            name = Some(rest.trim_matches('"').to_owned());
        } else if let Some(rest) = part.strip_prefix("filename=") {
            filename = Some(rest.trim_matches('"').to_owned());
        }
    }
    (name, filename)
}

/// Parse a multipart body.
///
/// `field` is the expected file field (`uploadSingle(field)`); a file in any other field is
/// refused with `400 UPLOAD_UNEXPECTED_FIELD`, exactly like multer's `LIMIT_UNEXPECTED_FILE`.
pub fn parse_multipart(
    content_type: &str,
    body: &[u8],
    expected_field: &str,
    max_file_bytes: u64,
    max_fields: usize,
) -> Result<MultipartForm, ApiError> {
    let Some(boundary) = boundary_of(content_type) else {
        return Err(ApiError::new(
            400,
            "UPLOAD_INVALID",
            "The multipart payload could not be parsed",
        ));
    };
    let delimiter = format!("--{boundary}").into_bytes();
    let mut form = MultipartForm::default();
    let mut cursor = match find(body, &delimiter, 0) {
        Some(index) => index + delimiter.len(),
        None => {
            return Err(ApiError::new(
                400,
                "UPLOAD_INVALID",
                "The multipart payload could not be parsed",
            ));
        }
    };
    loop {
        // Closing delimiter: `--`.
        if body.get(cursor..cursor + 2) == Some(b"--") {
            break;
        }
        if body.get(cursor..cursor + 2) == Some(b"\r\n") {
            cursor += 2;
        }
        let Some(header_end) = find(body, b"\r\n\r\n", cursor) else {
            return Err(ApiError::new(
                400,
                "UPLOAD_INVALID",
                "The multipart payload could not be parsed",
            ));
        };
        let headers = String::from_utf8_lossy(&body[cursor..header_end]).to_string();
        let content_start = header_end + 4;
        let Some(next) = find(body, &delimiter, content_start) else {
            return Err(ApiError::new(
                400,
                "UPLOAD_INVALID",
                "The multipart payload could not be parsed",
            ));
        };
        // The CRLF before the delimiter belongs to the framing, not the content.
        let mut content_end = next;
        if content_end >= 2 && body.get(content_end - 2..content_end) == Some(b"\r\n") {
            content_end -= 2;
        }
        let mut name = None;
        let mut filename = None;
        let mut part_type = "application/octet-stream".to_owned();
        for line in headers.split("\r\n") {
            let Some((header, value)) = line.split_once(':') else {
                continue;
            };
            let header = header.trim().to_ascii_lowercase();
            let value = value.trim();
            if header == "content-disposition" {
                let (parsed_name, parsed_filename) = parse_disposition(value);
                name = parsed_name;
                filename = parsed_filename;
            } else if header == "content-type" {
                part_type = value.to_owned();
            }
        }
        let name = name.unwrap_or_default();
        match filename {
            Some(filename) => {
                if name != expected_field {
                    return Err(ApiError::new(
                        400,
                        "UPLOAD_UNEXPECTED_FIELD",
                        "Unexpected file field in the multipart payload",
                    ));
                }
                if form.file.is_some() {
                    return Err(ApiError::new(
                        400,
                        "UPLOAD_INVALID",
                        "The multipart payload could not be parsed",
                    ));
                }
                let bytes = body[content_start..content_end].to_vec();
                if bytes.len() as u64 > max_file_bytes {
                    return Err(ApiError::new(
                        413,
                        "UPLOAD_TOO_LARGE",
                        "The uploaded statement exceeds the size limit",
                    ));
                }
                form.file = Some(UploadFile {
                    filename,
                    content_type: part_type,
                    bytes,
                });
            }
            None => {
                if form.fields.len() >= max_fields {
                    return Err(ApiError::new(
                        400,
                        "UPLOAD_INVALID",
                        "The multipart payload could not be parsed",
                    ));
                }
                form.fields.push((
                    name,
                    String::from_utf8_lossy(&body[content_start..content_end]).to_string(),
                ));
            }
        }
        cursor = next + delimiter.len();
    }
    Ok(form)
}

const BINARY_SIGNATURES: &[(&str, &[u8])] = &[
    (
        "image/png",
        &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ),
    ("image/jpeg", &[0xff, 0xd8, 0xff]),
    ("application/pdf", &[0x25, 0x50, 0x44, 0x46, 0x2d]),
];

/// Port of `detectUploadMime`.
#[must_use]
pub fn detect_upload_mime(buffer: &[u8]) -> Option<&'static str> {
    for (mime, signature) in BINARY_SIGNATURES {
        if buffer.len() >= signature.len() && buffer.starts_with(signature) {
            return Some(mime);
        }
    }
    if buffer.len() >= 2 && buffer[0] == 0xff && buffer[1] == 0xfe {
        return Some("text/csv");
    }
    if buffer.len() >= 2 && buffer[0] == 0xef && buffer[1] == 0xbb {
        return Some("text/csv");
    }
    if buffer.len() >= 8 && buffer[..8] == [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] {
        return Some("application/vnd.ms-excel");
    }
    let text = String::from_utf8_lossy(&buffer[..buffer.len().min(4096)]);
    let trimmed = text.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return Some("application/json");
    }
    if trimmed.contains(',') || trimmed.contains(';') {
        return Some("text/csv");
    }
    None
}

/// Port of `assertAllowedUpload`.
pub fn assert_allowed_upload(
    buffer: &[u8],
    declared_mime: Option<&str>,
    allowed_mimes: &[String],
    max_bytes: u64,
) -> Result<&'static str, ApiError> {
    if buffer.is_empty() {
        return Err(ApiError::new(
            400,
            "UPLOAD_EMPTY",
            "The uploaded statement is empty",
        ));
    }
    if buffer.len() as u64 > max_bytes {
        return Err(ApiError::new(
            413,
            "UPLOAD_TOO_LARGE",
            "The uploaded statement exceeds the size limit",
        )
        .with_details(serde_json::json!({
            "maxBytes": max_bytes,
            "receivedBytes": buffer.len(),
        })));
    }
    let normalized = declared_mime
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if !allowed_mimes.contains(&normalized) {
        return Err(ApiError::new(
            415,
            "UNSUPPORTED_UPLOAD_TYPE",
            "The uploaded statement type is not accepted",
        )
        .with_details(serde_json::json!({
            "allowed": allowed_mimes,
            "received": normalized,
        })));
    }
    let Some(detected) = detect_upload_mime(buffer) else {
        return Err(ApiError::new(
            415,
            "UPLOAD_SIGNATURE_MISMATCH",
            "The uploaded statement is not a CSV, XLSX or JSON file",
        ));
    };
    if detected != normalized {
        return Err(ApiError::new(
            415,
            "UPLOAD_SIGNATURE_MISMATCH",
            "The uploaded statement content does not match its declared type",
        )
        .with_details(serde_json::json!({
            "declared": normalized,
            "detected": detected,
        })));
    }
    Ok(detected)
}

/// `detectBrandAssetMime`: PNG magic or an SVG text container, 5 MiB cap.
pub fn brand_asset_mime(buffer: &[u8]) -> Result<&'static str, ApiError> {
    if buffer.is_empty() {
        return Err(ApiError::new(
            400,
            "UPLOAD_EMPTY",
            "The uploaded asset is empty",
        ));
    }
    if buffer.len() > 5 * 1024 * 1024 {
        return Err(ApiError::new(
            413,
            "UPLOAD_TOO_LARGE",
            "Brand assets must be 5 MiB or smaller",
        ));
    }
    if buffer.len() >= 8 && buffer.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Ok("image/png");
    }
    let text = String::from_utf8_lossy(&buffer[..buffer.len().min(4096)]);
    let trimmed = text.trim_start();
    if trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg")) {
        return Ok("image/svg+xml");
    }
    Err(ApiError::new(
        415,
        "UNSUPPORTED_UPLOAD_TYPE",
        "Brand assets must be a PNG or SVG image",
    ))
}

/// `encodeURIComponent` for the `x-upload-filename` header.
#[must_use]
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

/// Base64url without padding (`Buffer.toString("base64url")`).
#[must_use]
pub fn base64url(value: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn multipart(boundary: &str, parts: &[(&str, Option<&str>, &str, &[u8])]) -> Vec<u8> {
        let mut body = Vec::new();
        for (name, filename, content_type, content) in parts {
            body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
            match filename {
                Some(filename) => body.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
                    )
                    .as_bytes(),
                ),
                None => body.extend_from_slice(
                    format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
                ),
            }
            body.extend_from_slice(content);
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        body
    }

    #[test]
    fn parses_fields_and_one_file() {
        let body = multipart(
            "xyz",
            &[
                ("documentType", None, "", b"PASSPORT"),
                ("file", Some("doc.pdf"), "application/pdf", b"%PDF-1.7"),
            ],
        );
        let form = parse_multipart("multipart/form-data; boundary=xyz", &body, "file", 1024, 32)
            .expect("parsed");
        assert_eq!(form.field("documentType"), Some("PASSPORT"));
        let file = form.file.expect("file");
        assert_eq!(file.filename, "doc.pdf");
        assert_eq!(file.bytes, b"%PDF-1.7");
    }

    #[test]
    fn refuses_a_file_in_the_wrong_field() {
        let body = multipart(
            "xyz",
            &[("other", Some("a.pdf"), "application/pdf", b"%PDF")],
        );
        let error = parse_multipart("multipart/form-data; boundary=xyz", &body, "file", 1024, 32)
            .expect_err("error");
        assert_eq!(error.code, "UPLOAD_UNEXPECTED_FIELD");
    }

    #[test]
    fn refuses_an_oversized_file() {
        let body = multipart(
            "xyz",
            &[("file", Some("a.bin"), "application/pdf", b"1234567890")],
        );
        let error = parse_multipart("multipart/form-data; boundary=xyz", &body, "file", 4, 32)
            .expect_err("error");
        assert_eq!(error.status, 413);
        assert_eq!(error.code, "UPLOAD_TOO_LARGE");
    }

    #[test]
    fn sniffs_csv_json_png_and_pdf() {
        assert_eq!(detect_upload_mime(b"a,b\n1,2"), Some("text/csv"));
        assert_eq!(detect_upload_mime(br#"{"a":1}"#), Some("application/json"));
        assert_eq!(
            detect_upload_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("image/png")
        );
        assert_eq!(detect_upload_mime(b"%PDF-1.7"), Some("application/pdf"));
        assert_eq!(detect_upload_mime(b"hello"), None);
    }

    #[test]
    fn declared_and_detected_types_must_match() {
        let allowed = vec!["text/csv".to_owned(), "application/json".to_owned()];
        assert_eq!(
            assert_allowed_upload(b"a,b", Some("text/csv"), &allowed, 100).expect("ok"),
            "text/csv"
        );
        let error = assert_allowed_upload(b"a,b", Some("application/json"), &allowed, 100)
            .expect_err("error");
        assert_eq!(error.code, "UPLOAD_SIGNATURE_MISMATCH");
        let error =
            assert_allowed_upload(b"a,b", Some("image/png"), &allowed, 100).expect_err("error");
        assert_eq!(error.code, "UNSUPPORTED_UPLOAD_TYPE");
    }

    #[test]
    fn brand_assets_are_png_or_svg_only() {
        assert_eq!(
            brand_asset_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
            Ok("image/svg+xml")
        );
        assert_eq!(
            brand_asset_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
            Ok("image/png")
        );
        assert!(brand_asset_mime(b"GIF89a").is_err());
    }

    #[test]
    fn percent_encoding_matches_encode_uri_component() {
        assert_eq!(encode_uri_component("a b/c.pdf"), "a%20b%2Fc.pdf");
        assert_eq!(encode_uri_component("a_b-c.d~e"), "a_b-c.d~e");
    }
}
