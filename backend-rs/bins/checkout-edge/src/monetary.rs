//! The checkout zero-trust monetary-field scanner.
//!
//! Port of `checkout-back/lib/zReady/index.ts` (`FORBIDDEN_MONETARY_NAMES`, `normalizeFieldName`,
//! `isForbiddenMonetaryField`, `findForbiddenMonetaryField`, `assertNoMonetaryFields`).
//!
//! The payer-facing edge must never accept money, currency or a fee from the browser: the core
//! resolves them from the payment link. The scanner refuses a forbidden key at any depth (up to
//! 8) anywhere in the parsed body, including inside `formData`, with the dotted path in
//! `details.field`.

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::error::EdgeFailure;

/// `FORBIDDEN_MONETARY_NAMES`, copied verbatim.
pub const FORBIDDEN_MONETARY_NAMES: [&str; 19] = [
    "amount",
    "amountminor",
    "amountmajor",
    "amountlyd",
    "amountminorunits",
    "currency",
    "currencycode",
    "total",
    "totalamount",
    "fee",
    "fees",
    "commission",
    "commissionamount",
    "exchangerate",
    "price",
    "netamount",
    "grossamount",
    "debitamount",
    "creditamount",
];

/// `normalizeFieldName`: lowercase and drop everything that is not `a-z0-9`.
#[must_use]
pub fn normalize_field_name(name: &str) -> String {
    name.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// `isForbiddenMonetaryField`.
#[must_use]
pub fn is_forbidden_monetary_field(name: &str) -> bool {
    FORBIDDEN_MONETARY_NAMES.contains(&normalize_field_name(name).as_str())
}

/// `findForbiddenMonetaryField`, with the same depth (8) and node (2000) budgets.
#[must_use]
pub fn find_forbidden_monetary_field(payload: &Value) -> Option<String> {
    let mut budget = 0_u32;
    find_at(payload, "", 0, &mut budget)
}

fn find_at(payload: &Value, path: &str, depth: u32, budget: &mut u32) -> Option<String> {
    if depth > 8 || *budget > 2000 {
        return None;
    }
    match payload {
        Value::Array(entries) => {
            for entry in entries {
                if let Some(found) = find_at(entry, path, depth + 1, budget) {
                    return Some(found);
                }
            }
            None
        }
        Value::Object(object) => {
            for (key, value) in object {
                *budget += 1;
                if is_forbidden_monetary_field(key) {
                    return Some(if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    });
                }
                let nested_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                if let Some(found) = find_at(value, &nested_path, depth + 1, budget) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

/// `assertNoMonetaryFields`: the `400 AMOUNT_NOT_ACCEPTED` failure.
pub fn assert_no_monetary_fields(payload: Option<&Value>) -> Result<(), EdgeFailure> {
    let Some(payload) = payload else {
        return Ok(());
    };
    match find_forbidden_monetary_field(payload) {
        Some(field) => Err(EdgeFailure::amount_not_accepted(&field)),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn forbidden_names_are_normalised() {
        for variant in [
            "amount",
            "AMOUNT",
            "amountMinor",
            "amount-minor",
            "amount_minor",
            "amountLYD",
            "amountMinorUnits",
            "currency",
            "currencyCode",
            "total",
            "totalAmount",
            "fee",
            "fees",
            "commission",
            "commissionAmount",
            "exchangeRate",
            "price",
            "netAmount",
            "grossAmount",
            "debitAmount",
            "creditAmount",
        ] {
            assert!(
                is_forbidden_monetary_field(variant),
                "{variant} must be refused"
            );
        }
    }

    #[test]
    fn safe_names_are_accepted() {
        for name in [
            "phone",
            "otp",
            "reference",
            "customerName",
            "birthYear",
            "walletId",
            "cardLast4",
            "sessionId",
            "note",
            "language",
            "subMode",
            "railCode",
        ] {
            assert!(
                !is_forbidden_monetary_field(name),
                "{name} must be accepted"
            );
        }
    }

    #[test]
    fn nested_and_array_paths_are_reported() {
        let payload = json!({ "formData": { "amount": "10" } });
        assert_eq!(
            find_forbidden_monetary_field(&payload).as_deref(),
            Some("formData.amount")
        );

        let array = json!({ "items": [{ "ok": true }, { "fee": 1 }] });
        assert_eq!(
            find_forbidden_monetary_field(&array).as_deref(),
            Some("items.fee")
        );

        let clean = json!({ "formData": { "phone": "0912345678" } });
        assert_eq!(find_forbidden_monetary_field(&clean), None);
    }

    #[test]
    fn the_scanner_stops_at_the_depth_budget() {
        let mut payload = json!({ "amount": "1" });
        for _ in 0..20 {
            payload = json!({ "child": payload });
        }
        assert_eq!(find_forbidden_monetary_field(&payload), None);
    }

    #[test]
    fn assertion_reports_the_dotted_field_and_accepts_missing_bodies() {
        assert!(assert_no_monetary_fields(None).is_ok());
        let failure = assert_no_monetary_fields(Some(&json!({ "currency": "LYD" })))
            .expect_err("must refuse");
        assert_eq!(failure.status, 400);
        assert_eq!(failure.code, "AMOUNT_NOT_ACCEPTED");
        assert_eq!(failure.details, Some(json!({ "field": "currency" })));
    }
}
