//! `Content-Disposition` header values (RFC 6266 + RFC 5987).
//!
//! Port of `core-back/lib/contentDisposition.ts`.
//!
//! HTTP header values are Latin-1. A file named in Arabic (the normal case: KYB documents,
//! dispute evidence, bank statements) would make the download answer 500 if the raw name were
//! placed in the header. The name is therefore sent twice, as RFC 6266 §4.3 recommends:
//!
//! ```text
//! attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded UTF-8>
//! ```
//!
//! Every current browser uses `filename*`; the plain `filename` is pure printable ASCII with
//! quotes, backslashes, control characters and path separators removed, so it can neither break
//! out of the quoted string nor start a new header. A name that is pure printable ASCII and needs
//! no replacement is sent once.

#![forbid(unsafe_code)]

/// Maximum file-name characters kept from the caller's value.
pub const MAX_NAME_CHARS: usize = 200;

/// `kind` of the disposition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DispositionKind {
    /// `attachment`.
    Attachment,
    /// `inline`.
    Inline,
}

impl DispositionKind {
    /// The header token.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Attachment => "attachment",
            Self::Inline => "inline",
        }
    }
}

/// A header value for a file whose name comes from a user (attachment, fallback `download`).
#[must_use]
pub fn content_disposition(file_name: Option<&str>) -> String {
    content_disposition_with(DispositionKind::Attachment, file_name, "download")
}

/// A header value for `kind`, with an explicit ASCII fallback stem.
#[must_use]
pub fn content_disposition_with(
    kind: DispositionKind,
    file_name: Option<&str>,
    fallback_name: &str,
) -> String {
    let cleaned: String = file_name
        .unwrap_or_default()
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let last_segment = cleaned
        .split(['\\', '/'])
        .next_back()
        .unwrap_or_default()
        .trim();
    let truncated: String = last_segment.chars().take(MAX_NAME_CHARS).collect();
    let name = if truncated.is_empty() {
        fallback_name.to_owned()
    } else {
        truncated
    };

    let mut ascii = String::with_capacity(name.len());
    for character in name.chars() {
        let unsafe_ascii = !matches!(character, '\u{20}'..='\u{7e}')
            || matches!(
                character,
                '"' | '\\' | '/' | ':' | '*' | '?' | '<' | '>' | '|'
            );
        ascii.push(if unsafe_ascii { '_' } else { character });
    }
    // Collapse runs of '_' exactly like `.replace(/_{2,}/g, "_")`.
    let mut collapsed = String::with_capacity(ascii.len());
    let mut previous_underscore = false;
    for character in ascii.chars() {
        if character == '_' {
            if previous_underscore {
                continue;
            }
            previous_underscore = true;
        } else {
            previous_underscore = false;
        }
        collapsed.push(character);
    }

    // A name with no ASCII letters or digits left ("____.pdf") is useless as a fallback: use the
    // default stem and keep the extension when it is a plain one.
    let extension = trailing_extension(&collapsed);
    let stem = collapsed
        .get(..collapsed.len().saturating_sub(extension.len()))
        .unwrap_or_default();
    let has_alphanumeric = stem
        .chars()
        .any(|character| character.is_ascii_alphanumeric());
    let ascii_name = if has_alphanumeric {
        collapsed
    } else {
        format!("{fallback_name}{extension}")
    };

    let base = format!("{}; filename=\"{}\"", kind.as_str(), ascii_name);
    if ascii_name == name {
        base
    } else {
        format!("{base}; filename*=UTF-8''{}", encode_rfc5987(&name))
    }
}

/// The final `.<1-8 alphanumerics>` of an ASCII name.
fn trailing_extension(ascii: &str) -> &str {
    let Some(dot) = ascii.rfind('.') else {
        return "";
    };
    let extension = ascii.get(dot + 1..).unwrap_or_default();
    if extension.is_empty()
        || extension.len() > 8
        || !extension
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return "";
    }
    ascii.get(dot..).unwrap_or_default()
}

/// RFC 5987 `attr-char` encoding: `encodeURIComponent` plus the characters it leaves but the
/// grammar forbids (`'`, `(`, `)`, `*`).
#[must_use]
pub fn encode_rfc5987(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        let unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'!' | b'~');
        if unreserved {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_ascii_name_is_sent_once() {
        assert_eq!(
            content_disposition(Some("report.xlsx")),
            "attachment; filename=\"report.xlsx\""
        );
        assert_eq!(
            content_disposition_with(DispositionKind::Inline, Some("evidence.pdf"), "document"),
            "inline; filename=\"evidence.pdf\""
        );
    }

    #[test]
    fn an_arabic_name_gets_utf8_and_a_usable_ascii_fallback() {
        let header = content_disposition(Some("تقرير.pdf"));
        assert!(header.starts_with("attachment; filename=\"download.pdf\""));
        assert!(header.ends_with("; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1.pdf"));
    }

    #[test]
    fn path_segments_control_characters_and_quotes_cannot_escape() {
        assert_eq!(
            content_disposition(Some("../../etc/passwd")),
            "attachment; filename=\"passwd\""
        );
        assert_eq!(
            content_disposition(Some("a\"b:c*d?e<f>g|h.txt")),
            "attachment; filename=\"a_b_c_d_e_f_g_h.txt\"; filename*=UTF-8''a%22b%3Ac%2Ad%3Fe%3Cf%3Eg%7Ch.txt"
        );
        assert_eq!(
            content_disposition(Some("line\nbreak\rname.txt")),
            "attachment; filename=\"line break name.txt\""
        );
    }

    #[test]
    fn an_empty_or_symbol_only_name_falls_back() {
        assert_eq!(
            content_disposition(None),
            "attachment; filename=\"download\""
        );
        assert_eq!(
            content_disposition(Some("   ")),
            "attachment; filename=\"download\""
        );
        assert_eq!(
            content_disposition(Some("???.xlsx")),
            "attachment; filename=\"download.xlsx\"; filename*=UTF-8''%3F%3F%3F.xlsx"
        );
    }

    #[test]
    fn long_names_are_truncated_to_200_characters() {
        let name = "a".repeat(300);
        let header = content_disposition(Some(&name));
        assert_eq!(
            header,
            format!("attachment; filename=\"{}\"", "a".repeat(200))
        );
    }

    #[test]
    fn rfc5987_encoding_matches_encode_uri_component_plus_the_forbidden_characters() {
        assert_eq!(encode_rfc5987("a b"), "a%20b");
        assert_eq!(encode_rfc5987("'()*"), "%27%28%29%2A");
        assert_eq!(encode_rfc5987("!~-_. "), "!~-_.%20");
        assert_eq!(encode_rfc5987("%"), "%25");
        assert_eq!(encode_rfc5987("é"), "%C3%A9");
    }

    #[test]
    fn every_output_is_printable_ascii() {
        let header = content_disposition(Some("ملف تقرير 2026.docx"));
        assert!(header
            .chars()
            .all(|character| ('\u{20}'..='\u{7e}').contains(&character)));
    }
}
