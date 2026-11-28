//! Canonical authoring/runtime contract versions.
//!
//! Port of `core-back/lib/reportEngineSdk/version.ts`.
//!
//! The engine major version is the compatibility gate for stored specs: a major bump means
//! previously stored reports and chrome are no longer executable without migration. Spec
//! versions identify the serialised schema; transcript versions identify the AI authoring
//! contract. These strings are released artefacts (chapter 2 §29): never change them without a
//! migration and a new transcript snapshot.

#![forbid(unsafe_code)]

/// `REPORT_ENGINE_VERSION` — verbatim from the TS SDK.
pub const REPORT_ENGINE_VERSION: &str = "1.0.0";
/// `REPORT_SPEC_VERSION`.
pub const REPORT_SPEC_VERSION: &str = "1.0";
/// `REPORT_TRANSCRIPT_VERSION`.
pub const REPORT_TRANSCRIPT_VERSION: &str = "1.1";
/// `REPORT_CHROME_SPEC_VERSION`.
pub const REPORT_CHROME_SPEC_VERSION: &str = "1.0";
/// `REPORT_CHROME_TRANSCRIPT_VERSION`.
pub const REPORT_CHROME_TRANSCRIPT_VERSION: &str = "1.1";

/// `SUPPORTED_REPORT_ENGINE_MAJORS`.
pub const SUPPORTED_REPORT_ENGINE_MAJORS: &[u32] = &[1];
/// `SUPPORTED_REPORT_SPEC_VERSIONS`.
pub const SUPPORTED_REPORT_SPEC_VERSIONS: &[&str] = &[REPORT_SPEC_VERSION];
/// `SUPPORTED_REPORT_CHROME_SPEC_VERSIONS`.
pub const SUPPORTED_REPORT_CHROME_SPEC_VERSIONS: &[&str] = &[REPORT_CHROME_SPEC_VERSION];

/// `REPORT_ENGINE_VERSION_MAJOR` (`Number.parseInt("1.0.0", 10)`).
pub const REPORT_ENGINE_VERSION_MAJOR: u32 = 1;

/// The leading integer of a version string, mirroring `majorVersionOf`:
/// `^(\d+)` on the trimmed value, `null` when there is no leading digit.
///
/// `Number.parseInt` yields a JavaScript number for arbitrarily long digit runs; this port
/// returns `None` when the run does not fit `u32`, which only affects impossible versions.
#[must_use]
pub fn major_version_of(version: Option<&str>) -> Option<u32> {
    let trimmed = version?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u32>().ok()
}

/// `isSupportedEngineVersion`.
#[must_use]
pub fn is_supported_engine_version(version: Option<&str>) -> bool {
    major_version_of(version).is_some_and(|major| SUPPORTED_REPORT_ENGINE_MAJORS.contains(&major))
}

/// `isSupportedReportSpecVersion` (`Boolean(version) && includes(String(version))`).
#[must_use]
pub fn is_supported_report_spec_version(version: Option<&str>) -> bool {
    version.is_some_and(|value| SUPPORTED_REPORT_SPEC_VERSIONS.contains(&value))
}

/// `isSupportedChromeSpecVersion`.
#[must_use]
pub fn is_supported_chrome_spec_version(version: Option<&str>) -> bool {
    version.is_some_and(|value| SUPPORTED_REPORT_CHROME_SPEC_VERSIONS.contains(&value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_the_released_contract() {
        assert_eq!(REPORT_ENGINE_VERSION, "1.0.0");
        assert_eq!(REPORT_SPEC_VERSION, "1.0");
        assert_eq!(REPORT_TRANSCRIPT_VERSION, "1.1");
        assert_eq!(REPORT_CHROME_SPEC_VERSION, "1.0");
        assert_eq!(REPORT_CHROME_TRANSCRIPT_VERSION, "1.1");
        assert_eq!(REPORT_ENGINE_VERSION_MAJOR, 1);
    }

    #[test]
    fn major_version_matches_the_ts_regex() {
        assert_eq!(major_version_of(Some("1.0.0")), Some(1));
        assert_eq!(major_version_of(Some(" 2.7")), Some(2));
        assert_eq!(major_version_of(Some("10")), Some(10));
        assert_eq!(major_version_of(Some("v1")), None);
        assert_eq!(major_version_of(Some("")), None);
        assert_eq!(major_version_of(None), None);
    }

    #[test]
    fn supported_version_gates() {
        assert!(is_supported_engine_version(Some("1.0.0")));
        assert!(is_supported_engine_version(Some("1")));
        assert!(!is_supported_engine_version(Some("2.0.0")));
        assert!(!is_supported_engine_version(None));
        assert!(is_supported_report_spec_version(Some("1.0")));
        assert!(!is_supported_report_spec_version(Some("1.1")));
        assert!(is_supported_chrome_spec_version(Some("1.0")));
        assert!(!is_supported_chrome_spec_version(Some("0.9")));
    }
}
