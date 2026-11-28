//! Content sniffing and executable rejection.
//!
//! Port of `core-back/lib/objectStorageSdk/sniff.ts` (magic numbers and the executable block).
//! SVG is sanitised elsewhere; this module only classifies.

#![forbid(unsafe_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectedKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Pdf,
    Zip,
    Svg,
    Json,
    Text,
    Executable,
    Unknown,
}

impl DetectedKind {
    #[must_use]
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Pdf => "application/pdf",
            Self::Zip => "application/zip",
            Self::Svg => "image/svg+xml",
            Self::Json => "application/json",
            Self::Text => "text/plain",
            Self::Executable => "application/octet-stream",
            Self::Unknown => "application/octet-stream",
        }
    }
}

/// True when the bytes are a native executable or a script with a shebang.
#[must_use]
pub fn is_executable(data: &[u8]) -> bool {
    if data.len() >= 2 && data[0] == b'M' && data[1] == b'Z' {
        return true;
    }
    if data.starts_with(b"\x7fELF") {
        return true;
    }
    if data.len() >= 4 {
        let magic = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        // Mach-O 32/64-bit, fat binaries.
        if matches!(
            magic,
            0xFEED_FACE | 0xFEED_FACF | 0xCEFA_EDFE | 0xCFFA_EDFE | 0xCAFE_BABE
        ) {
            return true;
        }
    }
    data.starts_with(b"#!")
}

/// Detect the content kind from magic bytes. Text/JSON/HTML are best-effort.
#[must_use]
pub fn detect_mime(data: &[u8]) -> DetectedKind {
    if data.len() >= 8 && data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return DetectedKind::Png;
    }
    if data.len() >= 3 && data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return DetectedKind::Jpeg;
    }
    if data.len() >= 6 && (data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a")) {
        return DetectedKind::Gif;
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return DetectedKind::Webp;
    }
    if data.starts_with(b"%PDF-") {
        return DetectedKind::Pdf;
    }
    if data.len() >= 4 && data.starts_with(b"PK\x03\x04") {
        return DetectedKind::Zip;
    }
    if is_executable(data) {
        return DetectedKind::Executable;
    }
    let trimmed = data
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|index| &data[index..])
        .unwrap_or(&[]);
    if trimmed.starts_with(b"<svg") || trimmed.starts_with(b"<?xml") && contains_svg(trimmed) {
        return DetectedKind::Svg;
    }
    if trimmed.starts_with(b"{") || trimmed.starts_with(b"[") {
        return DetectedKind::Json;
    }
    if !data.is_empty()
        && data.iter().all(|byte| {
            *byte == 0x09
                || *byte == 0x0A
                || *byte == 0x0D
                || (0x20..0x7F).contains(byte)
                || *byte >= 0x80
        })
    {
        return DetectedKind::Text;
    }
    DetectedKind::Unknown
}

fn contains_svg(data: &[u8]) -> bool {
    data.windows(4).any(|window| window == b"<svg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_images_and_pdf() {
        assert_eq!(detect_mime(b"\x89PNG\r\n\x1a\nrest"), DetectedKind::Png);
        assert_eq!(detect_mime(b"%PDF-1.7"), DetectedKind::Pdf);
        assert_eq!(detect_mime(b"PK\x03\x04"), DetectedKind::Zip);
    }

    #[test]
    fn rejects_executables() {
        assert!(is_executable(b"MZ\x90\x00"));
        assert!(is_executable(b"\x7fELF"));
        assert!(is_executable(b"#!/bin/sh\n"));
        assert_eq!(detect_mime(b"MZ\x90\x00"), DetectedKind::Executable);
    }

    #[test]
    fn detects_svg_and_json() {
        assert_eq!(
            detect_mime(b"  <svg xmlns=\"...\"></svg>"),
            DetectedKind::Svg
        );
        assert_eq!(detect_mime(br#"{"a":1}"#), DetectedKind::Json);
    }
}
