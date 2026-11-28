//! Strict five-field cron analysis for the backup policy.
//!
//! Port of `analyzeCron` / `expandCronField` in `admin-back/api/protected/backups.ts`: numbers,
//! ranges, lists and steps only; no names, no macros. The caller enforces a minimum gap between
//! runs so a policy cannot schedule a backup storm (full ≥ 60 min, delta ≥ 5 min, drill ≥ 60 min).

#![forbid(unsafe_code)]

/// The smallest gap in minutes between two runs inside a day.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CronAnalysis {
    pub min_gap_minutes: u32,
}

const FIELDS: [(u32, u32); 5] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];

fn expand_field(raw: &str, min: u32, max: u32) -> Option<Vec<u32>> {
    let mut values = Vec::new();
    for part in raw.split(',') {
        let (base, step_raw) = match part.split_once('/') {
            Some((base, step)) => (base, Some(step)),
            None => (part, None),
        };
        if step_raw.is_some_and(|step| step.is_empty() || !step.chars().all(|c| c.is_ascii_digit()))
        {
            return None;
        }
        if base.is_empty()
            || !base
                .chars()
                .all(|character| character.is_ascii_digit() || character == '*' || character == '-')
        {
            return None;
        }
        let step: u32 = match step_raw {
            Some(step) => step.parse().ok()?,
            None => 1,
        };
        if step == 0 {
            return None;
        }
        let (from, to) = if base == "*" {
            (min, max)
        } else if let Some((from, to)) = base.split_once('-') {
            (from.parse().ok()?, to.parse().ok()?)
        } else {
            let value: u32 = base.parse().ok()?;
            if step_raw.is_some() {
                (value, max)
            } else {
                (value, value)
            }
        };
        if from < min || to > max || from > to {
            return None;
        }
        let mut value = from;
        while value <= to {
            values.push(value);
            value += step;
        }
    }
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

/// Parse a cron expression and return the smallest gap between runs inside one day.
#[must_use]
pub fn analyze_cron(expression: &str) -> Option<CronAnalysis> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        return None;
    }
    let mut sets: Vec<Vec<u32>> = Vec::with_capacity(5);
    for (index, field) in fields.iter().enumerate() {
        let (min, max) = FIELDS.get(index).copied()?;
        sets.push(expand_field(field, min, max)?);
    }
    let mut times: Vec<u32> = Vec::new();
    for hour in &sets[1] {
        for minute in &sets[0] {
            times.push(hour * 60 + minute);
        }
    }
    times.sort_unstable();
    times.dedup();
    if times.is_empty() {
        return None;
    }
    let mut gap = 1440u32;
    for index in 1..times.len() {
        gap = gap.min(times[index].saturating_sub(times[index - 1]));
    }
    if times.len() > 1 {
        let last = *times.last().unwrap_or(&0);
        let first = *times.first().unwrap_or(&0);
        gap = gap.min(1440 - last + first);
    }
    Some(CronAnalysis {
        min_gap_minutes: gap,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_daily_and_step_expressions() {
        assert_eq!(
            analyze_cron("0 2 * * 0").map(|value| value.min_gap_minutes),
            Some(1440)
        );
        assert_eq!(
            analyze_cron("*/5 * * * *").map(|value| value.min_gap_minutes),
            Some(5)
        );
        assert_eq!(
            analyze_cron("0 */6 * * *").map(|value| value.min_gap_minutes),
            Some(360)
        );
        assert_eq!(
            analyze_cron("0 3 * * *").map(|value| value.min_gap_minutes),
            Some(1440)
        );
    }

    #[test]
    fn rejects_invalid_syntax_and_ranges() {
        for bad in [
            "",
            "* * * *",
            "* * * * * *",
            "60 * * * *",
            "*/0 * * * *",
            "0 25 * * *",
            "0 0 0 * *",
            "0 0 * 13 *",
            "0 0 * * 8",
            "0 0 * * MON",
            "@daily",
            "1,,2 * * * *",
        ] {
            assert!(analyze_cron(bad).is_none(), "{bad:?} should be invalid");
        }
    }
}
