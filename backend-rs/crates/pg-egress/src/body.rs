//! Request bodies for the outbound gateway executor.
//!
//! Port of `FetchBody` / `serializeBody` / `payloadToString` in
//! `core-back/engine/apiConsumer/ApiConsumer.ts:77`, `:611-637`, `:289-306` and the content types
//! listed in chapter 2 §28 ("JSON, form, multipart, XML … text").
//!
//! The TS consumer accepts a `string`, `URLSearchParams`, `ArrayBuffer`, typed array, `Blob` or
//! `FormData`. Rust models those as a closed enum with an explicit content type, so a caller cannot
//! accidentally send `JSON.stringify(FormData)` (`{}`) — the exact bug that
//! `test/engine/multipart-and-content-type.test.ts` guards in TS.

#![forbid(unsafe_code)]

use serde_json::Value;

/// Default JSON content type (`serializeBody`, `ApiConsumer.ts:634`).
pub const JSON_CONTENT_TYPE: &str = "application/json";
/// WHATWG form encoding (`URLSearchParams` → fetch).
pub const FORM_CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
/// XML body content type (chapter 2 §28).
pub const XML_CONTENT_TYPE: &str = "application/xml";
/// Plain-text body content type.
pub const TEXT_CONTENT_TYPE: &str = "text/plain; charset=utf-8";

/// One file part of a multipart body (`FormData` file entries).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultipartFile {
    pub field: String,
    pub filename: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// A multipart/form-data body: field map plus file parts.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MultipartBody {
    pub fields: Vec<(String, String)>,
    pub files: Vec<MultipartFile>,
}

impl MultipartBody {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn field(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.fields.push((name.into(), value.into()));
        self
    }

    #[must_use]
    pub fn file(
        mut self,
        field: impl Into<String>,
        filename: impl Into<String>,
        content_type: impl Into<String>,
        bytes: impl Into<Vec<u8>>,
    ) -> Self {
        self.files.push(MultipartFile {
            field: field.into(),
            filename: filename.into(),
            content_type: content_type.into(),
            bytes: bytes.into(),
        });
        self
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.files.is_empty()
    }
}

/// A request body before serialization.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum RequestBody {
    /// No body; a GET/DELETE body is dropped even when set, exactly like `ApiConsumer.ts:550-554`.
    #[default]
    None,
    /// A JSON document (`application/json`).
    Json(Value),
    /// A form body in field order (`application/x-www-form-urlencoded`).
    Form(Vec<(String, String)>),
    /// An XML document (`application/xml`).
    Xml(String),
    /// Plain text (`text/plain; charset=utf-8`).
    Text(String),
    /// Pre-serialized bytes with an optional explicit content type (`ArrayBuffer`/`Blob` bodies).
    Bytes {
        content_type: Option<String>,
        bytes: Vec<u8>,
    },
    /// A multipart body (`FormData`).
    Multipart(MultipartBody),
}

impl RequestBody {
    /// Build a form body from pairs.
    #[must_use]
    pub fn form(pairs: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>) -> Self {
        Self::Form(
            pairs
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        )
    }

    #[must_use]
    pub fn is_none(&self) -> bool {
        matches!(self, Self::None)
    }

    /// Serialize to the exact wire bytes and content type.
    ///
    /// The bytes are produced once and then used both for transmission and for the request
    /// signature, so a signature always covers what is sent (`ApiConsumer.ts:524-527`).
    pub fn prepare(&self) -> Result<PreparedBody, BodyError> {
        match self {
            Self::None => Ok(PreparedBody::empty()),
            Self::Json(value) => {
                let bytes = serde_json::to_vec(value).map_err(|_| BodyError::NotSerializable)?;
                Ok(PreparedBody {
                    bytes: Some(bytes),
                    content_type: Some(JSON_CONTENT_TYPE.to_owned()),
                    kind: if value.is_array() {
                        BodyKind::JsonArray
                    } else {
                        BodyKind::Json
                    },
                })
            }
            Self::Form(fields) => {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                for (key, value) in fields {
                    serializer.append_pair(key, value);
                }
                Ok(PreparedBody {
                    bytes: Some(serializer.finish().into_bytes()),
                    content_type: Some(FORM_CONTENT_TYPE.to_owned()),
                    kind: BodyKind::Form,
                })
            }
            Self::Xml(text) => Ok(PreparedBody {
                bytes: Some(text.clone().into_bytes()),
                content_type: Some(XML_CONTENT_TYPE.to_owned()),
                kind: BodyKind::Xml,
            }),
            Self::Text(text) => Ok(PreparedBody {
                bytes: Some(text.clone().into_bytes()),
                content_type: Some(TEXT_CONTENT_TYPE.to_owned()),
                kind: BodyKind::Text,
            }),
            Self::Bytes {
                content_type,
                bytes,
            } => Ok(PreparedBody {
                bytes: Some(bytes.clone()),
                content_type: content_type.clone(),
                kind: BodyKind::Binary,
            }),
            Self::Multipart(multipart) => {
                let (bytes, content_type) = serialize_multipart(multipart)?;
                Ok(PreparedBody {
                    bytes: Some(bytes),
                    content_type: Some(content_type),
                    kind: BodyKind::Multipart,
                })
            }
        }
    }
}

/// The serialized body, ready for transmission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedBody {
    pub bytes: Option<Vec<u8>>,
    pub content_type: Option<String>,
    pub kind: BodyKind,
}

impl PreparedBody {
    #[must_use]
    pub fn empty() -> Self {
        Self {
            bytes: None,
            content_type: None,
            kind: BodyKind::None,
        }
    }

    /// The transmitted payload as text (`payloadToString`, `ApiConsumer.ts:289-306`).
    ///
    /// A binary body is decoded as UTF-8 with replacement, like `Buffer.toString("utf8")`.
    #[must_use]
    pub fn payload_text(&self) -> String {
        match &self.bytes {
            Some(bytes) => String::from_utf8_lossy(bytes).into_owned(),
            None => String::new(),
        }
    }
}

/// The body shape, used for error messages and signature/canonicalisation rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    None,
    Json,
    JsonArray,
    Form,
    Xml,
    Text,
    Binary,
    Multipart,
}

impl BodyKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::None => "empty",
            Self::Json => "JSON object",
            Self::JsonArray => "JSON array",
            Self::Form => "form",
            Self::Xml => "XML",
            Self::Text => "text",
            Self::Binary => "binary",
            Self::Multipart => "multipart",
        }
    }

    #[must_use]
    pub const fn is_json_object(self) -> bool {
        matches!(self, Self::Json)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BodyError {
    #[error("The request body cannot be serialized")]
    NotSerializable,
    #[error("A multipart field name cannot contain CR, LF or a double quote")]
    InvalidFieldName,
    #[error("A multipart filename cannot contain CR, LF or a double quote")]
    InvalidFilename,
}

impl BodyError {
    /// The API code (`API_REQUEST_INVALID` mirrors the TS `STEP_REQUEST_INVALID` refusal).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        "API_REQUEST_INVALID"
    }
}

fn assert_mime_safe(value: &str, error: BodyError) -> Result<(), BodyError> {
    if value.contains(['\r', '\n', '"']) {
        Err(error)
    } else {
        Ok(())
    }
}

fn serialize_multipart(body: &MultipartBody) -> Result<(Vec<u8>, String), BodyError> {
    let boundary = format!("----pgw{}", uuid::Uuid::now_v7().simple());
    let mut output: Vec<u8> = Vec::new();
    for (name, value) in &body.fields {
        assert_mime_safe(name, BodyError::InvalidFieldName)?;
        output.extend_from_slice(
            format!("--{boundary}\r\ncontent-disposition: form-data; name=\"{name}\"\r\n\r\n")
                .as_bytes(),
        );
        output.extend_from_slice(value.as_bytes());
        output.extend_from_slice(b"\r\n");
    }
    for file in &body.files {
        assert_mime_safe(&file.field, BodyError::InvalidFieldName)?;
        assert_mime_safe(&file.filename, BodyError::InvalidFilename)?;
        output.extend_from_slice(
            format!(
                "--{boundary}\r\ncontent-disposition: form-data; name=\"{}\"; filename=\"{}\"\r\ncontent-type: {}\r\n\r\n",
                file.field, file.filename, file.content_type
            )
            .as_bytes(),
        );
        output.extend_from_slice(&file.bytes);
        output.extend_from_slice(b"\r\n");
    }
    output.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok((output, format!("multipart/form-data; boundary={boundary}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_bodies_are_application_json() {
        let prepared = RequestBody::Json(serde_json::json!({ "amount": "1.00" }))
            .prepare()
            .expect("json");
        assert_eq!(prepared.content_type.as_deref(), Some(JSON_CONTENT_TYPE));
        assert_eq!(prepared.kind, BodyKind::Json);
        assert_eq!(
            prepared.payload_text(),
            r#"{"amount":"1.00"}"#,
            "serde_json preserves insertion order with the preserve_order feature"
        );
    }

    #[test]
    fn arrays_are_marked_as_arrays() {
        let prepared = RequestBody::Json(serde_json::json!(["one", "two"]))
            .prepare()
            .expect("array");
        assert_eq!(prepared.kind, BodyKind::JsonArray);
        assert_eq!(prepared.payload_text(), r#"["one","two"]"#);
    }

    #[test]
    fn form_bodies_use_whatwg_encoding() {
        let prepared = RequestBody::form([("a b", "1+2"), ("empty", "")])
            .prepare()
            .expect("form");
        assert_eq!(prepared.content_type.as_deref(), Some(FORM_CONTENT_TYPE));
        assert_eq!(prepared.payload_text(), "a+b=1%2B2&empty=");
        assert_eq!(prepared.kind, BodyKind::Form);
    }

    #[test]
    fn xml_and_text_have_explicit_content_types() {
        let xml = RequestBody::Xml("<a>1</a>".to_owned())
            .prepare()
            .expect("xml");
        assert_eq!(xml.content_type.as_deref(), Some(XML_CONTENT_TYPE));
        assert_eq!(xml.payload_text(), "<a>1</a>");

        let text = RequestBody::Text("hello".to_owned())
            .prepare()
            .expect("text");
        assert_eq!(text.content_type.as_deref(), Some(TEXT_CONTENT_TYPE));
    }

    #[test]
    fn bytes_keep_their_content_type_or_none() {
        let prepared = RequestBody::Bytes {
            content_type: Some("application/octet-stream".to_owned()),
            bytes: vec![0, 159, 146, 150],
        }
        .prepare()
        .expect("bytes");
        assert_eq!(
            prepared.content_type.as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(prepared.kind, BodyKind::Binary);
        assert!(!prepared.payload_text().is_empty());
    }

    #[test]
    fn multipart_serialises_fields_and_files_with_one_boundary() {
        let body = MultipartBody::new().field("amount", "1.00").file(
            "receipt",
            "r.txt",
            "text/plain",
            b"proof".to_vec(),
        );
        let prepared = RequestBody::Multipart(body).prepare().expect("multipart");
        let content_type = prepared.content_type.clone().expect("content type");
        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .expect("boundary");
        let text = prepared.payload_text();
        assert!(text.starts_with(&format!("--{boundary}\r\n")));
        assert!(text.contains("name=\"amount\"\r\n\r\n1.00\r\n"));
        assert!(text.contains(
            "name=\"receipt\"; filename=\"r.txt\"\r\ncontent-type: text/plain\r\n\r\nproof\r\n"
        ));
        assert!(text.ends_with(&format!("--{boundary}--\r\n")));
        assert_eq!(prepared.kind, BodyKind::Multipart);
    }

    #[test]
    fn multipart_rejects_header_injection() {
        let body = MultipartBody::new().field("bad\r\nname", "x");
        assert_eq!(
            RequestBody::Multipart(body).prepare().expect_err("name"),
            BodyError::InvalidFieldName
        );
        let body = MultipartBody::new().file("f", "bad\"name", "text/plain", Vec::new());
        assert_eq!(
            RequestBody::Multipart(body)
                .prepare()
                .expect_err("filename"),
            BodyError::InvalidFilename
        );
    }

    #[test]
    fn an_empty_body_has_no_bytes() {
        let prepared = RequestBody::None.prepare().expect("none");
        assert!(prepared.bytes.is_none());
        assert!(prepared.content_type.is_none());
        assert_eq!(prepared.payload_text(), "");
        assert_eq!(BodyKind::None.as_str(), "empty");
        assert!(RequestBody::None.is_none());
    }

    #[test]
    fn body_kinds_describe_themselves() {
        assert!(BodyKind::Json.is_json_object());
        assert!(!BodyKind::JsonArray.is_json_object());
        assert_eq!(BodyKind::Multipart.as_str(), "multipart");
        assert_eq!(BodyError::NotSerializable.code(), "API_REQUEST_INVALID");
    }
}
