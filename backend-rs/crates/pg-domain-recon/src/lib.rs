//! Reconciliation domain: statement CSV, amounts, dates and settlement context.
//!
//! Ports `core-back/engine/reconciliation/StatementIngestor.ts`, the money helpers of
//! `core-back/engine/db/money.ts` it uses, and the settlement-sweep grouping of
//! `core-back/engine/workers/BackgroundJobHandlers.ts:124-267`.
//!
//! Scope: parsing and classification only. Matching against attempts, fee-variance posting and the
//! `RECONCILIATION_RUN` job need the database and live in the worker layer.
//!
//! `StatementIngestor` defaults a source to `Africa/Tripoli`; [`DEFAULT_STATEMENT_TIMEZONE`] keeps
//! that default. The XLSX parser of the TS is deliberately unwired there
//! (`XLSX_PARSER_UNAVAILABLE`), so no XLSX code exists here either.

#![forbid(unsafe_code)]

pub mod amount;
pub mod context;
pub mod csv;
pub mod date;
pub mod statement;

pub use amount::{
    amount_minor, format_amount, is_money_literal, parse_amount, validate_currency_code,
    ReconError, MONEY_DECIMALS, MONEY_SCALE,
};
pub use context::{AttemptContext, CurrencyContext, StatementSourceContext};
pub use csv::parse_csv_rows;
pub use date::{
    midnight_in_timezone, parse_statement_date, parse_statement_date_opt, parse_statement_datetime,
    statement_timezone, DEFAULT_STATEMENT_TIMEZONE,
};
pub use statement::{
    detect_row_type, parse_source_currency, ReconciliationResult, StatementLine, StatementRowType,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_statement_line_end_to_end() {
        let rows = parse_csv_rows(
            "\u{feff}our_reference,amount,fee,currency,occurredAt,type\nPAY-1,1250.00,12.5,lyd,01/11/2026,SETTLEMENT\n",
            ',',
        );
        assert_eq!(rows.len(), 2);
        let line = StatementLine::new(
            parse_amount(&rows[1][1]).expect("amount"),
            parse_amount(&rows[1][2]).expect("fee"),
        )
        .with_our_reference(&rows[1][0])
        .with_currency(&rows[1][3])
        .with_occurred_on(parse_statement_date(&rows[1][4], Some("DD/MM/YYYY")).expect("date"))
        .with_row_type(detect_row_type(Some(&rows[1][5])));
        assert_eq!(line.statement_amount_text(), "1250.0000");
        assert_eq!(line.normalised_currency(None).as_deref(), Some("LYD"));
        assert_eq!(line.occurred_on.expect("date").to_string(), "2026-11-01");
        assert_eq!(line.row_type, StatementRowType::Settlement);
        assert_eq!(line.dedupe_key(), "PAY-1");

        // A quoted thousands separator is kept by the CSV reader but is not a plain decimal,
        // exactly like the TS `MONEY_PATTERN` (the parser must strip it first).
        let quoted = parse_csv_rows("amount\n\"1,250.00\"\n", ',');
        assert_eq!(quoted[1][0], "1,250.00");
        assert!(parse_amount(&quoted[1][0]).is_err());
    }
}
