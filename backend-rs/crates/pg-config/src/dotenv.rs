//! Minimal dotenv parser with dotenvy-compatible semantics for the subset the repository uses:
//!
//! - `KEY=value`, optional `export ` prefix;
//! - single quotes are literal, double quotes support `\n`, `\r`, `\t`, `\\`, `\"`;
//! - unquoted values trim surrounding whitespace and stop at an unescaped `#`;
//! - a quoted value may be followed by a comment;
//! - blank lines and `#` comments are ignored;
//! - duplicate keys: last one wins (dotenvy behaviour).
//!
//! Invalid lines produce an error rather than being ignored, so a typo cannot silently weaken a
//! production configuration.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

#[derive(Debug)]
pub enum DotenvError {
    Io {
        path: String,
        source: std::io::Error,
    },
    Syntax {
        line: usize,
        message: String,
    },
}

impl fmt::Display for DotenvError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "cannot read environment file {path}: {source}"),
            Self::Syntax { line, message } => {
                write!(f, "invalid environment file line {line}: {message}")
            }
        }
    }
}

impl std::error::Error for DotenvError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Syntax { .. } => None,
        }
    }
}

/// Parse an environment file into a key/value map.
pub fn parse_dotenv(path: &Path) -> Result<BTreeMap<String, String>, DotenvError> {
    let text = std::fs::read_to_string(path).map_err(|source| DotenvError::Io {
        path: path.display().to_string(),
        source,
    })?;
    parse_dotenv_str(&text)
}

/// Parse environment-file text.
pub fn parse_dotenv_str(text: &str) -> Result<BTreeMap<String, String>, DotenvError> {
    let mut values = BTreeMap::new();
    for (index, raw_line) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw_line.trim_start_matches('\u{feff}').trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").map_or(line, str::trim_start);
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            return Err(DotenvError::Syntax {
                line: line_no,
                message: "expected KEY=VALUE".to_owned(),
            });
        };
        let key = raw_key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '.')
        {
            return Err(DotenvError::Syntax {
                line: line_no,
                message: format!("invalid key {key:?}"),
            });
        }
        let value = parse_value(raw_value.trim(), line_no)?;
        values.insert(key.to_owned(), value);
    }
    Ok(values)
}

fn parse_value(raw: &str, line: usize) -> Result<String, DotenvError> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    let mut chars = raw.chars();
    match chars.next() {
        Some('"') => {
            let mut value = String::new();
            let mut escaped = false;
            let mut closed = false;
            let mut rest = String::new();
            for ch in chars {
                if escaped {
                    match ch {
                        'n' => value.push('\n'),
                        'r' => value.push('\r'),
                        't' => value.push('\t'),
                        '\\' => value.push('\\'),
                        '"' => value.push('"'),
                        '$' => value.push('$'),
                        other => {
                            value.push('\\');
                            value.push(other);
                        }
                    }
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '"' {
                    closed = true;
                } else if closed {
                    rest.push(ch);
                } else {
                    value.push(ch);
                }
            }
            if !closed {
                return Err(DotenvError::Syntax {
                    line,
                    message: "unterminated double-quoted value".to_owned(),
                });
            }
            let trailing = rest.trim();
            if !trailing.is_empty() && !trailing.starts_with('#') {
                return Err(DotenvError::Syntax {
                    line,
                    message: "unexpected text after quoted value".to_owned(),
                });
            }
            Ok(value)
        }
        Some('\'') => {
            let mut value = String::new();
            let mut closed = false;
            let mut rest = String::new();
            for ch in chars {
                if ch == '\'' && !closed {
                    closed = true;
                } else if closed {
                    rest.push(ch);
                } else {
                    value.push(ch);
                }
            }
            if !closed {
                return Err(DotenvError::Syntax {
                    line,
                    message: "unterminated single-quoted value".to_owned(),
                });
            }
            let trailing = rest.trim();
            if !trailing.is_empty() && !trailing.starts_with('#') {
                return Err(DotenvError::Syntax {
                    line,
                    message: "unexpected text after quoted value".to_owned(),
                });
            }
            Ok(value)
        }
        _ => {
            let mut value = String::new();
            let mut escaped = false;
            for ch in raw.chars() {
                if escaped {
                    value.push(ch);
                    escaped = false;
                } else if ch == '\\' {
                    escaped = true;
                } else if ch == '#' && (value.is_empty() || value.ends_with(char::is_whitespace)) {
                    break;
                } else {
                    value.push(ch);
                }
            }
            Ok(value.trim().to_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quotes_comments_and_exports() {
        let values = parse_dotenv_str(
            "# comment\nA=1\nexport B=two\nC=\"x y # z\"\nD=plain # note\nE='lit#eral'\nF=\n",
        )
        .expect("valid");
        assert_eq!(values["A"], "1");
        assert_eq!(values["B"], "two");
        assert_eq!(values["C"], "x y # z");
        assert_eq!(values["D"], "plain");
        assert_eq!(values["E"], "lit#eral");
        assert_eq!(values["F"], "");
    }

    #[test]
    fn rejects_unterminated_quotes() {
        assert!(parse_dotenv_str("A=\"x").is_err());
    }
}
