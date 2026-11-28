//! The hand-written CSV reader of the statement ingestor.
//!
//! Port of `core-back/engine/reconciliation/StatementIngestor.ts:113-168` (`parseCsvRows`).
//!
//! Faithful details:
//!
//! - a `"` opens quoted mode anywhere in a field; inside quotes `""` is a literal quote and every
//!   other character (including `\r` and the delimiter) is content;
//! - outside quotes a `\r` is dropped, so CRLF and a lone CR both collapse; `\n` ends the row;
//! - a delimiter is a single character (the TS compares `input[index] === delimiter`, so a
//!   multi-character delimiter never matches; the Rust signature takes a `char` to make that
//!   explicit);
//! - at end of input a pending field/row is flushed only when either is non-empty, and the result
//!   drops rows whose every cell is blank;
//! - an unterminated quote consumes the rest of the input.
//!
//! Intentional difference: a leading UTF-8 BOM (`\u{feff}`) is stripped. The TS parses a
//! BOM-prefixed file with the BOM glued to the first header cell, which then never matches the
//! configured `ourReference` column; every real bank export starts with a BOM, so stripping is the
//! correct behaviour and is covered by a test.

#![forbid(unsafe_code)]

/// Parse CSV text into rows of fields.
#[must_use]
pub fn parse_csv_rows(input: &str, delimiter: char) -> Vec<Vec<String>> {
    let input = input.strip_prefix('\u{feff}').unwrap_or(input);
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut characters = input.chars().peekable();
    while let Some(character) = characters.next() {
        if in_quotes {
            if character == '"' {
                if characters.peek() == Some(&'"') {
                    characters.next();
                    field.push('"');
                    continue;
                }
                in_quotes = false;
                continue;
            }
            field.push(character);
            continue;
        }
        if character == '"' {
            in_quotes = true;
            continue;
        }
        if character == delimiter {
            current.push(std::mem::take(&mut field));
            continue;
        }
        if character == '\r' {
            continue;
        }
        if character == '\n' {
            current.push(std::mem::take(&mut field));
            rows.push(std::mem::take(&mut current));
            continue;
        }
        field.push(character);
    }
    if !field.is_empty() || !current.is_empty() {
        current.push(field);
        rows.push(current);
    }
    rows.retain(|row| row.iter().any(|cell| !cell.trim().is_empty()));
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(input: &str) -> Vec<Vec<String>> {
        parse_csv_rows(input, ',')
    }

    fn owned(cells: &[&str]) -> Vec<String> {
        cells.iter().map(|cell| (*cell).to_owned()).collect()
    }

    #[test]
    fn plain_rows_and_trailing_newline() {
        assert_eq!(
            rows("a,b\nc,d\n"),
            vec![owned(&["a", "b"]), owned(&["c", "d"])]
        );
        assert_eq!(
            rows("a,b\nc,d"),
            vec![owned(&["a", "b"]), owned(&["c", "d"])]
        );
        assert_eq!(rows("a,b"), vec![owned(&["a", "b"])]);
        assert!(rows("").is_empty());
        assert!(rows("\n\n").is_empty());
        assert_eq!(
            rows("a,b\n\nc,d\n"),
            vec![owned(&["a", "b"]), owned(&["c", "d"])]
        );
        assert_eq!(rows("a,b,,"), vec![owned(&["a", "b", "", ""])]);
        assert_eq!(rows(",a"), vec![owned(&["", "a"])]);
    }

    #[test]
    fn crlf_is_a_line_break_and_a_lone_cr_is_skipped() {
        assert_eq!(
            rows("a,b\r\nc,d\r\n"),
            vec![owned(&["a", "b"]), owned(&["c", "d"])]
        );
        // The TS reader only treats `\n` as a row break: a lone `\r` is skipped and the text
        // continues in the same field (`a,b\rc,d` -> `["a", "bc", "d"]`).
        assert_eq!(rows("a,b\rc,d\r"), vec![owned(&["a", "bc", "d"])]);
        assert_eq!(rows("ab\rcd,e"), vec![owned(&["abcd", "e"])]);
    }

    #[test]
    fn quotes_and_doubled_quotes() {
        assert_eq!(rows("\"a,b\",c"), vec![owned(&["a,b", "c"])]);
        assert_eq!(
            rows("\"say \"\"hi\"\"\",x"),
            vec![owned(&["say \"hi\"", "x"])]
        );
        // A quote in the middle of a field starts quoted mode; the text before it is kept.
        assert_eq!(rows("ab\"cd,ef\",gh"), vec![owned(&["abcd,ef", "gh"])]);
        // A quoted field keeps CR and newlines.
        assert_eq!(rows("\"a\r\nb\",c"), vec![owned(&["a\r\nb", "c"])]);
        // Unterminated quote consumes the rest.
        assert_eq!(rows("\"abc,def"), vec![owned(&["abc,def"])]);
        // Text after the closing quote is appended.
        assert_eq!(rows("\"a\"b,c"), vec![owned(&["ab", "c"])]);
    }

    #[test]
    fn blank_rows_are_dropped_and_delimiter_is_single_char() {
        assert_eq!(rows("a,b\n , \n"), vec![owned(&["a", "b"])]);
        assert_eq!(parse_csv_rows("a;b;c", ';'), vec![owned(&["a", "b", "c"])]);
        assert_eq!(
            parse_csv_rows("a\tb\tc", '\t'),
            vec![owned(&["a", "b", "c"])]
        );
        // A tab is content under the comma delimiter.
        assert_eq!(parse_csv_rows("a\tb,c", ','), vec![owned(&["a\tb", "c"])]);
    }

    #[test]
    fn a_leading_bom_is_stripped() {
        assert_eq!(
            rows("\u{feff}our_reference,amount"),
            vec![owned(&["our_reference", "amount"])]
        );
        // Only a leading BOM: one inside a field is data.
        assert_eq!(rows("a,\u{feff}b"), vec![owned(&["a", "\u{feff}b"])]);
    }

    #[test]
    fn a_bank_style_statement() {
        let csv =
            "\u{feff}our_reference,provider_reference,amount,fee,currency,occurredAt,type\r\n\
                   PAY-1,GW-9,\"1,250.00\",12.5,LYD,2026-11-01,SETTLEMENT\r\n\
                   PAY-2,GW-10,\"10.00\",0.5,LYD,01/11/2026,CHARGEBACK\r\n";
        let parsed = rows(csv);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0][0], "our_reference");
        // A quoted thousands separator keeps the comma in the cell.
        assert_eq!(parsed[1][2], "1,250.00");
        assert_eq!(parsed[2][6], "CHARGEBACK");
    }
}
