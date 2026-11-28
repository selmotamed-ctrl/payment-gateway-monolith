//! Exact decimal-string money helpers.
//!
//! The TS emulator parses wire amounts with `Number` and stores 4-decimal LYD strings; the Rust
//! port keeps the same **string contract** but performs the arithmetic on scaled integers
//! (`1 LYD = 10_000 micros`), never on `f32`/`f64`. This is stricter than the TS code and removes
//! float rounding from every fake balance.

#![forbid(unsafe_code)]

/// Parses a decimal string into an integer scaled by `10^dp`, rounding half-up on extra digits.
/// Returns `None` when the string has no digits.
#[must_use]
pub fn parse_scaled(value: &str, dp: u32) -> Option<i128> {
    let mut filtered = String::new();
    for (index, ch) in value.chars().enumerate() {
        let keep = ch.is_ascii_digit()
            || (ch == '-' && index == 0)
            || (ch == '.' && !filtered.contains('.'));
        if keep {
            filtered.push(ch);
        }
    }
    if filtered.is_empty() || filtered == "-" || filtered == "." {
        return None;
    }
    let negative = filtered.starts_with('-');
    let unsigned = filtered.trim_start_matches('-');
    let (whole, fraction) = unsigned.split_once('.').unwrap_or((unsigned, ""));
    let whole: i128 = if whole.is_empty() {
        0
    } else {
        whole.parse().ok()?
    };
    let mut scale = 10i128.checked_pow(dp)?;
    let mut fractional: i128 = 0;
    let mut digits = 0u32;
    for ch in fraction.chars() {
        if digits == dp {
            // Round half-up on the first dropped digit.
            if ch.to_digit(10).unwrap_or_default() >= 5 {
                fractional += 1;
            }
            break;
        }
        fractional = fractional
            .checked_mul(10)?
            .checked_add(i128::from(ch.to_digit(10)?))?;
        digits += 1;
    }
    while digits < dp {
        fractional *= 10;
        digits += 1;
    }
    scale = scale.max(1);
    let scaled = whole.checked_mul(scale)?.checked_add(fractional)?;
    Some(if negative { -scaled } else { scaled })
}

/// Formats a scaled integer as a fixed-point decimal string.
#[must_use]
pub fn format_scaled(value: i128, dp: u32) -> String {
    let scale = 10i128.pow(dp);
    let sign = if value < 0 { "-" } else { "" };
    let absolute = value.abs();
    let whole = absolute / scale;
    let fraction = absolute % scale;
    if dp == 0 {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction:0width$}", width = dp as usize)
    }
}

/// TS `toMicros`: 4-decimal LYD to integer micros (half-up).
#[must_use]
pub fn micros(lyd: &str) -> i64 {
    parse_scaled(lyd, 4)
        .and_then(|value| i64::try_from(value).ok())
        .unwrap_or(0)
}

/// TS `fromMicros`: integer micros to a 4-decimal LYD string.
#[must_use]
pub fn lyd(micros: i64) -> String {
    format_scaled(i128::from(micros), 4)
}

/// `Number(value).toFixed(4)` for a wire amount, without a float.
#[must_use]
pub fn fixed4(value: &str) -> String {
    format_scaled(parse_scaled(value, 4).unwrap_or(0), 4)
}

/// Whole-number rounding used by the Moamalat integer-dirhams wire (`Math.round(x)`).
#[must_use]
pub fn round_whole(value: &str) -> i128 {
    parse_scaled(value, 0).unwrap_or(0)
}

/// Per-gateway amount normalisation. Returns `(wire, lyd, scale)` like `normalizeAmount`.
#[must_use]
pub fn normalize_amount(gateway_code: &str, wire: &str) -> (String, String, i64) {
    let trimmed = wire.trim();
    match gateway_code {
        "moamalat" => {
            // Moamalat transmits integer dirhams (LYD * 1000).
            let integer = if !trimmed.is_empty() && trimmed.chars().all(|ch| ch.is_ascii_digit()) {
                trimmed.parse::<i128>().unwrap_or(0)
            } else {
                parse_scaled(trimmed, 3).unwrap_or(0)
            };
            let micros = integer.saturating_mul(10);
            (integer.to_string(), format_scaled(micros, 4), 1000)
        }
        "ly_pay" | "neompay" => (
            trimmed.to_owned(),
            format_scaled(parse_scaled(trimmed, 4).unwrap_or(0), 4),
            1000,
        ),
        _ => (
            trimmed.to_owned(),
            format_scaled(parse_scaled(trimmed, 4).unwrap_or(0), 4),
            100,
        ),
    }
}

/// `zMaskPhone`.
#[must_use]
pub fn mask_phone(value: &str) -> String {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    if digits.len() < 4 {
        return "****".to_owned();
    }
    format!(
        "{}{}",
        "*".repeat(digits.len() - 4),
        &digits[digits.len() - 4..]
    )
}

/// `zMaskCard`.
#[must_use]
pub fn mask_card(value: &str) -> String {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    if digits.len() >= 4 {
        format!("**** **** **** {}", &digits[digits.len() - 4..])
    } else {
        "****".to_owned()
    }
}

/// `zMaskWallet`.
#[must_use]
pub fn mask_wallet(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() >= 4 {
        let head: String = chars[..3].iter().collect();
        let tail: String = chars[chars.len() - 3..].iter().collect();
        format!("{head}***{tail}")
    } else {
        "***".to_owned()
    }
}

/// `maskCustomer`: card-shaped gateways mask as a card, NeomPay as a wallet, everything else as a
/// phone number.
#[must_use]
pub fn mask_customer(gateway_code: &str, customer: Option<&str>) -> Option<String> {
    let customer = customer?;
    if customer.is_empty() {
        return None;
    }
    Some(if gateway_code == "moamalat" || gateway_code == "mpgs" {
        mask_card(customer)
    } else if gateway_code == "neompay" {
        mask_wallet(customer)
    } else {
        mask_phone(customer)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_four_decimals() {
        assert_eq!(fixed4("100.00"), "100.0000");
        assert_eq!(fixed4("10.5"), "10.5000");
        assert_eq!(fixed4("0"), "0.0000");
        assert_eq!(fixed4("1.23456"), "1.2346");
        assert_eq!(micros("200.0000"), 2_000_000);
        assert_eq!(lyd(2_000_000), "200.0000");
        assert_eq!(lyd(-5), "-0.0005");
    }

    #[test]
    fn normalises_moamalat_integer_dirhams() {
        let (wire, lyd_value, scale) = normalize_amount("moamalat", "10500");
        assert_eq!(wire, "10500");
        assert_eq!(lyd_value, "10.5000");
        assert_eq!(scale, 1000);
        let (_, lyd_value, _) = normalize_amount("edfali", "100.5");
        assert_eq!(lyd_value, "100.5000");
    }

    #[test]
    fn masks_identifiers() {
        assert_eq!(mask_phone("0911234567"), "******4567");
        assert_eq!(mask_card("628000010000001"), "**** **** **** 0001");
        assert_eq!(mask_wallet("NEOM-WALLET-0-RICH"), "NEO***ICH");
        assert_eq!(mask_phone("12"), "****");
    }
}
