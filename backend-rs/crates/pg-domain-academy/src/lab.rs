//! Lab task scoring.
//!
//! Port of `admin-front/src/components/academy/labScoring.ts` (the Academy lab engine; the TS
//! doc comment calls it spec II-10). The module is pure there and is kept pure here.
//!
//! Scoring rules, copied exactly:
//!
//! - a task is worth `points`; the raw score is capped at that and full marks make the task
//!   `correct`;
//! - a used hint costs one point, with a floor of zero;
//! - `choice`: the selected option must be correct; selecting an option marked `critical` is a
//!   critical error (even when the option is the key — that is the TS behaviour);
//! - `multi`: `(correctSelected - wrongSelected) / totalCorrect`, floored at zero, where
//!   `wrongSelected` counts only ids that are options of the task; selecting an id in
//!   `criticalWrong` is a critical error;
//! - `ledger`: `(matchedLines - extraCells) / expectedLines`; an expected line matches when the
//!   entered cell equals its amount exactly; a non-empty, unparseable or non-zero cell on a
//!   non-expected account is an extra cell;
//! - `order`: the exact sequence earns full marks; otherwise `rightPositions / length` rounded
//!   DOWN to one decimal place, and items beyond the expected length subtract from the hit count;
//! - `checklist`: `rightItems / items`; ticking an id in `criticalWrong` that should not be ticked
//!   is a critical error;
//! - `numeric`: `|answer - key| <= |tolerance|`, full marks or zero.
//!
//! Money arithmetic: the TS uses decimal.js. This crate has no decimal dependency, so a small
//! exact decimal (`Decimal`, sign + integer + fraction strings) implements comparison and the
//! tolerance test without any floating point. Scores live on a `1e-4` point grid (`Score4`), the
//! same grid as `toDecimalPlaces(4, ROUND_HALF_UP)`, computed through an internal `1e-8` scale so
//! the hint penalty is applied before the final rounding like the TS.
//!
//! Limits: a literal longer than 40 characters is rejected (the TS lab regex has no such limit;
//! no realistic answer needs it) and a scaled comparison that would overflow `i128` is a mismatch.

#![forbid(unsafe_code)]

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Score arithmetic errors (a malformed lab definition, never learner input).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum LabError {
    #[error("the lab has no tasks")]
    EmptyLab,
    #[error("task '{0}' has no points")]
    NonPositivePoints(String),
}

const SCALE8: i128 = 100_000_000;
const SCALE4: i128 = 10_000;
const MAX_LITERAL: usize = 40;

/* ------------------------------------------------------------------ exact decimals */

/// An exact, sign-aware decimal literal (`^[+-]?(\d+\.?\d*|\.\d+)$`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decimal {
    negative: bool,
    /// Integer digits without leading zeros (empty means zero).
    int: String,
    /// Fraction digits without trailing zeros (empty means none).
    frac: String,
}

impl Decimal {
    pub const ZERO: Self = Self {
        negative: false,
        int: String::new(),
        frac: String::new(),
    };

    #[must_use]
    pub fn is_zero(&self) -> bool {
        self.int.is_empty() && self.frac.is_empty()
    }

    #[must_use]
    pub fn is_negative(&self) -> bool {
        self.negative && !self.is_zero()
    }

    fn compare_magnitude(&self, other: &Self) -> Ordering {
        match self.int.len().cmp(&other.int.len()) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
        match self.int.cmp(&other.int) {
            Ordering::Equal => {}
            ordering => return ordering,
        }
        let width = self.frac.len().max(other.frac.len());
        pad_right(&self.frac, width).cmp(&pad_right(&other.frac, width))
    }

    /// Sign-aware comparison.
    #[must_use]
    pub fn cmp_decimal(&self, other: &Self) -> Ordering {
        if self.negative != other.negative {
            return if self.negative {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        let magnitude = self.compare_magnitude(other);
        if self.negative {
            magnitude.reverse()
        } else {
            magnitude
        }
    }

    /// `|self - other| <= |tolerance|`, exactly.
    #[must_use]
    pub fn abs_diff_le(&self, other: &Self, tolerance: Self) -> bool {
        let width = self
            .frac
            .len()
            .max(other.frac.len())
            .max(tolerance.frac.len());
        let (Some(left), Some(right), Some(limit)) = (
            self.to_scaled(width),
            other.to_scaled(width),
            tolerance.to_scaled(width),
        ) else {
            return false;
        };
        let Some(difference) = left.checked_sub(right) else {
            return false;
        };
        difference.unsigned_abs() <= limit.unsigned_abs()
    }

    fn to_scaled(&self, width: usize) -> Option<i128> {
        if self.int.len() + width > 36 {
            return None;
        }
        let mut digits = String::with_capacity(self.int.len() + width + 1);
        if self.int.is_empty() {
            digits.push('0');
        } else {
            digits.push_str(&self.int);
        }
        digits.push_str(&pad_right(&self.frac, width));
        let magnitude = digits.parse::<i128>().ok()?;
        Some(if self.negative { -magnitude } else { magnitude })
    }
}

fn pad_right(value: &str, width: usize) -> String {
    let mut out = String::with_capacity(width);
    out.push_str(value);
    out.push_str(&"0".repeat(width - value.len()));
    out
}

/// Parse a learner decimal exactly; `None` for an empty or malformed literal.
#[must_use]
pub fn parse_decimal(raw: &str) -> Option<Decimal> {
    let text = raw.trim();
    if text.is_empty() || text.len() > MAX_LITERAL {
        return None;
    }
    let (negative, rest) = match text.as_bytes()[0] {
        b'-' => (true, &text[1..]),
        b'+' => (false, &text[1..]),
        _ => (false, text),
    };
    let (integer, fraction) = match rest.split_once('.') {
        Some((integer, fraction)) => (integer, fraction),
        None => (rest, ""),
    };
    if integer.is_empty() && fraction.is_empty() {
        return None;
    }
    if !integer.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let integer = integer.trim_start_matches('0');
    let fraction = fraction.trim_end_matches('0');
    if integer.is_empty() && fraction.is_empty() {
        return Some(Decimal::ZERO);
    }
    Some(Decimal {
        negative,
        int: integer.to_owned(),
        frac: fraction.to_owned(),
    })
}

/// Equality of two decimal literals (an unparseable entered value never matches).
#[must_use]
pub fn decimal_equals(entered: &str, expected: &str) -> bool {
    match (parse_decimal(entered), parse_decimal(expected)) {
        (Some(left), Some(right)) => left.cmp_decimal(&right) == Ordering::Equal,
        _ => false,
    }
}

/* ------------------------------------------------------------------ scores */

/// A score on the four-decimal point grid (`8.3333` is `83_333` units).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
#[serde(transparent)]
pub struct Score4(pub i64);

impl Score4 {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub fn from_points(points: i64) -> Self {
        Self(points.saturating_mul(10_000))
    }

    #[must_use]
    pub const fn units(self) -> i64 {
        self.0
    }

    /// `toFixed(4)`-style text (`8.3333`, `0.0000`).
    #[must_use]
    pub fn to_points_string(self) -> String {
        let negative = self.0 < 0;
        let magnitude = self.0.unsigned_abs();
        format!(
            "{}{}.{:04}",
            if negative { "-" } else { "" },
            magnitude / 10_000,
            magnitude % 10_000
        )
    }
}

fn round_half_up(numerator: i128, denominator: i128) -> i128 {
    if denominator <= 0 {
        return 0;
    }
    let sign = if numerator < 0 { -1_i128 } else { 1_i128 };
    let magnitude = numerator.unsigned_abs();
    let denominator = denominator.unsigned_abs();
    let rounded = (magnitude + denominator / 2) / denominator;
    i128::try_from(rounded).map_or(0, |value| sign * value)
}

/// `ratioScore`: `points * numerator / denominator` on the internal `1e-8` scale, floored at zero.
fn ratio8(points: i64, numerator: i64, denominator: i64) -> i128 {
    if denominator <= 0 || numerator <= 0 || points <= 0 {
        return 0;
    }
    let raw = i128::from(points) * SCALE8 * i128::from(numerator) / i128::from(denominator);
    raw.max(0)
}

/// `finish`: cap at `points`, decide `correct`, subtract the hint penalty, round to `1e-4`.
fn finish(
    points: i64,
    raw8: i128,
    critical_error: bool,
    hint: bool,
    detail: ScoreDetail,
) -> TaskScore {
    let max8 = i128::from(points) * SCALE8;
    let capped = raw8.min(max8);
    let correct = capped >= max8 && points > 0;
    let mut final8 = capped;
    if hint {
        final8 -= SCALE8;
    }
    if final8 < 0 {
        final8 = 0;
    }
    let units = round_half_up(final8, SCALE4);
    TaskScore {
        task_id: String::new(),
        score: Score4(i64::try_from(units).unwrap_or(i64::MAX)),
        max_score: points,
        critical_error,
        correct,
        hint_penalty: i64::from(hint),
        detail,
    }
}

/* ------------------------------------------------------------------ score detail */

/// The per-kind counters of `ScoreDetail`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScoreDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_lines: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra_cells: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correct_positions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correct_selected: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wrong_selected: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_correct: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub right_items: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_items: Option<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub critical_ids: Vec<String>,
}

/// One scored task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskScore {
    pub task_id: String,
    pub score: Score4,
    pub max_score: i64,
    pub critical_error: bool,
    /// Full marks before the hint penalty.
    pub correct: bool,
    pub hint_penalty: i64,
    pub detail: ScoreDetail,
}

/* ------------------------------------------------------------------ lab content */

/// The debit/credit side of a ledger line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Side {
    #[serde(rename = "DR")]
    Dr,
    #[serde(rename = "CR")]
    Cr,
}

impl Side {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Dr => "DR",
            Self::Cr => "CR",
        }
    }
}

/// `ChoiceTask` option.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChoiceOption {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub correct: bool,
    #[serde(default)]
    pub critical: bool,
    #[serde(default)]
    pub feedback: String,
}

/// `MultiTask` option (no per-option critical flag; `criticalWrong` on the task).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultiOption {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub correct: bool,
    #[serde(default)]
    pub feedback: String,
}

/// `LedgerTask.expected` line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpectedLine {
    pub account: String,
    pub side: Side,
    pub amount: String,
}

/// `OrderTask` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrderItem {
    pub id: String,
    #[serde(default)]
    pub label: String,
}

/// `ChecklistTask` item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecklistItem {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(rename = "shouldTick")]
    pub should_tick: bool,
    #[serde(default)]
    pub why: String,
}

/// `LabTask`, tagged by `kind` exactly like the generated content JSON.
///
/// The common fields (`id`, `title`, `prompt`, `points`, `hint`, `refs`) are declared on every
/// variant instead of a flattened struct: serde's internally tagged enum does not support
/// `flatten`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LabTask {
    Choice {
        id: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        prompt: String,
        points: i64,
        #[serde(default)]
        hint: Option<String>,
        #[serde(default)]
        refs: Vec<String>,
        options: Vec<ChoiceOption>,
    },
    Multi {
        id: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        prompt: String,
        points: i64,
        #[serde(default)]
        hint: Option<String>,
        #[serde(default)]
        refs: Vec<String>,
        options: Vec<MultiOption>,
        #[serde(default, rename = "criticalWrong")]
        critical_wrong: Vec<String>,
    },
    Ledger {
        id: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        prompt: String,
        points: i64,
        #[serde(default)]
        hint: Option<String>,
        #[serde(default)]
        refs: Vec<String>,
        #[serde(default)]
        accounts: Vec<String>,
        expected: Vec<ExpectedLine>,
        #[serde(default)]
        feedback: String,
    },
    Order {
        id: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        prompt: String,
        points: i64,
        #[serde(default)]
        hint: Option<String>,
        #[serde(default)]
        refs: Vec<String>,
        #[serde(default)]
        items: Vec<OrderItem>,
        #[serde(default, rename = "correctOrder")]
        correct_order: Vec<String>,
        #[serde(default)]
        feedback: String,
    },
    Checklist {
        id: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        prompt: String,
        points: i64,
        #[serde(default)]
        hint: Option<String>,
        #[serde(default)]
        refs: Vec<String>,
        items: Vec<ChecklistItem>,
        #[serde(default, rename = "criticalWrong")]
        critical_wrong: Vec<String>,
    },
    Numeric {
        id: String,
        #[serde(default)]
        title: String,
        #[serde(default)]
        prompt: String,
        points: i64,
        #[serde(default)]
        hint: Option<String>,
        #[serde(default)]
        refs: Vec<String>,
        answer: String,
        #[serde(default)]
        tolerance: String,
        #[serde(default)]
        unit: Option<String>,
        #[serde(default)]
        feedback: String,
    },
}

impl LabTask {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Choice { id, .. }
            | Self::Multi { id, .. }
            | Self::Ledger { id, .. }
            | Self::Order { id, .. }
            | Self::Checklist { id, .. }
            | Self::Numeric { id, .. } => id,
        }
    }

    #[must_use]
    pub fn points(&self) -> i64 {
        match self {
            Self::Choice { points, .. }
            | Self::Multi { points, .. }
            | Self::Ledger { points, .. }
            | Self::Order { points, .. }
            | Self::Checklist { points, .. }
            | Self::Numeric { points, .. } => *points,
        }
    }

    #[must_use]
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Choice { .. } => "choice",
            Self::Multi { .. } => "multi",
            Self::Ledger { .. } => "ledger",
            Self::Order { .. } => "order",
            Self::Checklist { .. } => "checklist",
            Self::Numeric { .. } => "numeric",
        }
    }

    /// A choice task with only the fields scoring needs.
    #[must_use]
    pub fn choice(id: impl Into<String>, points: i64, options: Vec<ChoiceOption>) -> Self {
        Self::Choice {
            id: id.into(),
            title: String::new(),
            prompt: String::new(),
            points,
            hint: None,
            refs: Vec::new(),
            options,
        }
    }

    /// A multi task with only the fields scoring needs.
    #[must_use]
    pub fn multi(
        id: impl Into<String>,
        points: i64,
        options: Vec<MultiOption>,
        critical_wrong: Vec<String>,
    ) -> Self {
        Self::Multi {
            id: id.into(),
            title: String::new(),
            prompt: String::new(),
            points,
            hint: None,
            refs: Vec::new(),
            options,
            critical_wrong,
        }
    }

    /// A ledger task with only the fields scoring needs.
    #[must_use]
    pub fn ledger(id: impl Into<String>, points: i64, expected: Vec<ExpectedLine>) -> Self {
        Self::Ledger {
            id: id.into(),
            title: String::new(),
            prompt: String::new(),
            points,
            hint: None,
            refs: Vec::new(),
            accounts: Vec::new(),
            expected,
            feedback: String::new(),
        }
    }

    /// An order task with only the fields scoring needs.
    #[must_use]
    pub fn order(
        id: impl Into<String>,
        points: i64,
        correct_order: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self::Order {
            id: id.into(),
            title: String::new(),
            prompt: String::new(),
            points,
            hint: None,
            refs: Vec::new(),
            items: Vec::new(),
            correct_order: correct_order.into_iter().map(Into::into).collect(),
            feedback: String::new(),
        }
    }

    /// A checklist task with only the fields scoring needs.
    #[must_use]
    pub fn checklist(
        id: impl Into<String>,
        points: i64,
        items: Vec<ChecklistItem>,
        critical_wrong: Vec<String>,
    ) -> Self {
        Self::Checklist {
            id: id.into(),
            title: String::new(),
            prompt: String::new(),
            points,
            hint: None,
            refs: Vec::new(),
            items,
            critical_wrong,
        }
    }

    /// A numeric task with only the fields scoring needs.
    #[must_use]
    pub fn numeric(
        id: impl Into<String>,
        points: i64,
        answer: impl Into<String>,
        tolerance: impl Into<String>,
    ) -> Self {
        Self::Numeric {
            id: id.into(),
            title: String::new(),
            prompt: String::new(),
            points,
            hint: None,
            refs: Vec::new(),
            answer: answer.into(),
            tolerance: tolerance.into(),
            unit: None,
            feedback: String::new(),
        }
    }
}

/// One submitted answer; fields are unused by task kinds that do not read them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAnswer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_multi: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cells: BTreeMap<String, LedgerCell>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ticked: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, rename = "hintUsed")]
    pub hint_used: bool,
}

/// One learner grid cell.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerCell {
    #[serde(default, rename = "DR", skip_serializing_if = "Option::is_none")]
    pub dr: Option<String>,
    #[serde(default, rename = "CR", skip_serializing_if = "Option::is_none")]
    pub cr: Option<String>,
}

impl TaskAnswer {
    #[must_use]
    pub fn choice(selected: impl Into<String>) -> Self {
        Self {
            selected: Some(selected.into()),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn multi(selected: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            selected_multi: selected.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn order(order: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            order: order.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn checklist(ticked: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            ticked: ticked.into_iter().map(Into::into).collect(),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn numeric(value: impl Into<String>) -> Self {
        Self {
            value: Some(value.into()),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn ledger(cells: BTreeMap<String, LedgerCell>) -> Self {
        Self {
            cells,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn with_hint(mut self) -> Self {
        self.hint_used = true;
        self
    }
}

/// A lab definition (only the fields scoring reads).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Lab {
    pub id: String,
    #[serde(default = "default_pass_percent", rename = "passPercent")]
    pub pass_percent: u32,
    pub tasks: Vec<LabTask>,
}

const fn default_pass_percent() -> u32 {
    80
}

impl Lab {
    /// Parse a generated content file (`labs.en.json` / a single lab object).
    pub fn from_json_slice(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice(bytes)
    }

    /// Parse a lab from an in-memory JSON value (the extractor's output).
    pub fn from_json_value(value: serde_json::Value) -> Result<Self, serde_json::Error> {
        serde_json::from_value(value)
    }
}

/// A whole lab's score.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabScore {
    /// Integer 0-100, round half up (the TS `computeLabResult`).
    pub score: u32,
    pub earned: Score4,
    pub possible: Score4,
    pub passed: bool,
    pub critical_errors: usize,
    pub tasks: Vec<TaskScore>,
}

/* ------------------------------------------------------------------ scoring */

/// Score one task. `answer` may be absent (unanswered scores zero).
#[must_use]
pub fn score_task(task: &LabTask, answer: Option<&TaskAnswer>, hint_used: bool) -> TaskScore {
    let hint = hint_used || answer.is_some_and(|answer| answer.hint_used);
    let points = task.points();
    let mut scored = match task {
        LabTask::Choice { options, .. } => score_choice(points, options, answer, hint),
        LabTask::Multi {
            options,
            critical_wrong,
            ..
        } => score_multi(points, options, critical_wrong, answer, hint),
        LabTask::Ledger { expected, .. } => score_ledger(points, expected, answer, hint),
        LabTask::Order { correct_order, .. } => score_order(points, correct_order, answer, hint),
        LabTask::Checklist {
            items,
            critical_wrong,
            ..
        } => score_checklist(points, items, critical_wrong, answer, hint),
        LabTask::Numeric {
            answer: key,
            tolerance,
            ..
        } => score_numeric(points, key, tolerance, answer, hint),
    };
    scored.task_id = task.id().to_owned();
    scored
}

fn score_choice(
    points: i64,
    options: &[ChoiceOption],
    answer: Option<&TaskAnswer>,
    hint: bool,
) -> TaskScore {
    let chosen = answer
        .and_then(|answer| answer.selected.as_deref())
        .and_then(|selected| options.iter().find(|option| option.id == selected));
    let critical = chosen.is_some_and(|option| option.critical);
    let raw = if chosen.is_some_and(|option| option.correct) {
        i128::from(points) * SCALE8
    } else {
        0
    };
    let detail = ScoreDetail {
        critical_ids: if critical {
            chosen
                .map(|option| vec![option.id.clone()])
                .unwrap_or_default()
        } else {
            Vec::new()
        },
        ..ScoreDetail::default()
    };
    finish(points, raw, critical, hint, detail)
}

fn score_multi(
    points: i64,
    options: &[MultiOption],
    critical_wrong: &[String],
    answer: Option<&TaskAnswer>,
    hint: bool,
) -> TaskScore {
    let selected = answer
        .map(|answer| unique(&answer.selected_multi))
        .unwrap_or_default();
    let total_correct = options.iter().filter(|option| option.correct).count();
    let correct_selected = options
        .iter()
        .filter(|option| option.correct && selected.contains(&option.id))
        .count();
    let wrong_selected = options
        .iter()
        .filter(|option| !option.correct && selected.contains(&option.id))
        .count();
    let critical_ids: Vec<String> = critical_wrong
        .iter()
        .filter(|id| selected.contains(*id))
        .cloned()
        .collect();
    let numerator =
        i64::try_from(correct_selected).unwrap_or(0) - i64::try_from(wrong_selected).unwrap_or(0);
    let raw = ratio8(points, numerator, i64::try_from(total_correct).unwrap_or(0));
    let detail = ScoreDetail {
        correct_selected: Some(correct_selected),
        wrong_selected: Some(wrong_selected),
        total_correct: Some(total_correct),
        critical_ids: critical_ids.clone(),
        ..ScoreDetail::default()
    };
    finish(points, raw, !critical_ids.is_empty(), hint, detail)
}

fn score_ledger(
    points: i64,
    expected: &[ExpectedLine],
    answer: Option<&TaskAnswer>,
    hint: bool,
) -> TaskScore {
    let empty = BTreeMap::new();
    let cells = answer.map_or(&empty, |answer| &answer.cells);
    let mut matched = 0_usize;
    for line in expected {
        let entered = cells
            .get(&line.account)
            .map(|cell| cell_value(cell, line.side))
            .unwrap_or_default();
        if decimal_equals(&entered, &line.amount) {
            matched += 1;
        }
    }
    let expected_accounts: BTreeSet<&str> =
        expected.iter().map(|line| line.account.as_str()).collect();
    let mut extra = 0_usize;
    for (account, cell) in cells {
        if expected_accounts.contains(account.as_str()) {
            continue;
        }
        for side in [Side::Dr, Side::Cr] {
            let text = cell_value(cell, side);
            if text.trim().is_empty() {
                continue;
            }
            match parse_decimal(&text) {
                Some(value) if !value.is_zero() => extra += 1,
                Some(_) => {}
                None => extra += 1,
            }
        }
    }
    let numerator = i64::try_from(matched).unwrap_or(0) - i64::try_from(extra).unwrap_or(0);
    let raw = ratio8(
        points,
        numerator,
        i64::try_from(expected.len()).unwrap_or(0),
    );
    let detail = ScoreDetail {
        matched_lines: Some(matched),
        expected_lines: Some(expected.len()),
        extra_cells: Some(extra),
        ..ScoreDetail::default()
    };
    finish(points, raw, false, hint, detail)
}

fn score_order(
    points: i64,
    correct_order: &[String],
    answer: Option<&TaskAnswer>,
    hint: bool,
) -> TaskScore {
    let order = answer
        .map(|answer| answer.order.clone())
        .unwrap_or_default();
    let length = correct_order.len();
    let mut right_positions = order
        .iter()
        .zip(correct_order)
        .filter(|(given, key)| given == key)
        .count();
    let exact = right_positions == length && order.len() == length && length > 0;
    if order.len() > length {
        right_positions = right_positions.saturating_sub(order.len() - length);
    }
    let raw = if exact {
        i128::from(points) * SCALE8
    } else if length > 0 {
        let unrounded = i128::from(points) * SCALE8 * i128::try_from(right_positions).unwrap_or(0)
            / i128::try_from(length).unwrap_or(1);
        // `toDecimalPlaces(1, ROUND_DOWN)`.
        unrounded / 10_000_000 * 10_000_000
    } else {
        0
    };
    let detail = ScoreDetail {
        correct_positions: Some(right_positions),
        total: Some(length),
        ..ScoreDetail::default()
    };
    finish(points, raw, false, hint, detail)
}

fn score_checklist(
    points: i64,
    items: &[ChecklistItem],
    critical_wrong: &[String],
    answer: Option<&TaskAnswer>,
    hint: bool,
) -> TaskScore {
    let ticked: BTreeSet<String> = answer
        .map(|answer| answer.ticked.iter().cloned().collect())
        .unwrap_or_default();
    let mut right = 0_usize;
    for item in items {
        if ticked.contains(&item.id) == item.should_tick {
            right += 1;
        }
    }
    let critical_ids: Vec<String> = critical_wrong
        .iter()
        .filter(|id| {
            ticked.contains(*id)
                && items
                    .iter()
                    .any(|item| item.id.as_str() == id.as_str() && !item.should_tick)
        })
        .cloned()
        .collect();
    let raw = ratio8(
        points,
        i64::try_from(right).unwrap_or(0),
        i64::try_from(items.len()).unwrap_or(0),
    );
    let detail = ScoreDetail {
        right_items: Some(right),
        total_items: Some(items.len()),
        critical_ids: critical_ids.clone(),
        ..ScoreDetail::default()
    };
    finish(points, raw, !critical_ids.is_empty(), hint, detail)
}

fn score_numeric(
    points: i64,
    key: &str,
    tolerance: &str,
    answer: Option<&TaskAnswer>,
    hint: bool,
) -> TaskScore {
    let correct = answer
        .and_then(|answer| answer.value.as_deref())
        .and_then(parse_decimal)
        .zip(parse_decimal(key))
        .is_some_and(|(entered, expected)| {
            let tolerance = parse_decimal(tolerance).unwrap_or(Decimal::ZERO);
            entered.abs_diff_le(&expected, tolerance)
        });
    let raw = if correct {
        i128::from(points) * SCALE8
    } else {
        0
    };
    finish(points, raw, false, hint, ScoreDetail::default())
}

fn cell_value(cell: &LedgerCell, side: Side) -> String {
    match side {
        Side::Dr => cell.dr.clone().unwrap_or_default(),
        Side::Cr => cell.cr.clone().unwrap_or_default(),
    }
    .trim()
    .to_owned()
}

fn unique(values: &[String]) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(value) {
            seen.push(value.clone());
        }
    }
    seen
}

/// `computeLabResult` from per-task scores.
#[must_use]
pub fn compute_lab_result(tasks: &[TaskScore], pass_percent: u32) -> LabScore {
    let earned_units: i128 = tasks.iter().map(|task| i128::from(task.score.0)).sum();
    let possible_units: i128 = tasks
        .iter()
        .map(|task| i128::from(task.max_score) * SCALE4)
        .sum();
    let percent = if possible_units > 0 {
        let rounded = (earned_units * 100 + possible_units / 2) / possible_units;
        u32::try_from(rounded).unwrap_or(100)
    } else {
        0
    };
    let critical_errors = tasks.iter().filter(|task| task.critical_error).count();
    LabScore {
        score: percent,
        earned: Score4(i64::try_from(earned_units).unwrap_or(i64::MAX)),
        possible: Score4(i64::try_from(possible_units).unwrap_or(i64::MAX)),
        passed: percent >= pass_percent && critical_errors == 0,
        critical_errors,
        tasks: tasks.to_vec(),
    }
}

/// `scoreLab`: answers keyed by task id, hinted task ids in the set.
#[must_use]
pub fn score_lab(
    lab: &Lab,
    answers: &BTreeMap<String, TaskAnswer>,
    hints: &BTreeSet<String>,
) -> LabScore {
    let tasks: Vec<TaskScore> = lab
        .tasks
        .iter()
        .map(|task| score_task(task, answers.get(task.id()), hints.contains(task.id())))
        .collect();
    compute_lab_result(&tasks, lab.pass_percent)
}

/// Validate the shape a lab must have before scoring it (points > 0, at least one task).
pub fn validate_lab(lab: &Lab) -> Result<(), LabError> {
    if lab.tasks.is_empty() {
        return Err(LabError::EmptyLab);
    }
    if let Some(task) = lab.tasks.iter().find(|task| task.points() <= 0) {
        return Err(LabError::NonPositivePoints(task.id().to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choice_task(points: i64) -> LabTask {
        LabTask::choice(
            "t1",
            points,
            vec![
                ChoiceOption {
                    id: "right".to_owned(),
                    label: String::new(),
                    correct: true,
                    critical: false,
                    feedback: String::new(),
                },
                ChoiceOption {
                    id: "danger".to_owned(),
                    label: String::new(),
                    correct: false,
                    critical: true,
                    feedback: String::new(),
                },
            ],
        )
    }

    fn multi_task(points: i64) -> LabTask {
        LabTask::multi(
            "t2",
            points,
            vec![
                MultiOption {
                    id: "a".to_owned(),
                    label: String::new(),
                    correct: true,
                    feedback: String::new(),
                },
                MultiOption {
                    id: "b".to_owned(),
                    label: String::new(),
                    correct: true,
                    feedback: String::new(),
                },
                MultiOption {
                    id: "c".to_owned(),
                    label: String::new(),
                    correct: false,
                    feedback: String::new(),
                },
            ],
            vec!["c".to_owned()],
        )
    }

    fn ledger_task(points: i64) -> LabTask {
        LabTask::ledger(
            "t3",
            points,
            vec![
                ExpectedLine {
                    account: "CASH".to_owned(),
                    side: Side::Dr,
                    amount: "10.00".to_owned(),
                },
                ExpectedLine {
                    account: "REVENUE".to_owned(),
                    side: Side::Cr,
                    amount: "10".to_owned(),
                },
            ],
        )
    }

    fn checklist_task(points: i64) -> LabTask {
        LabTask::checklist(
            "t5",
            points,
            vec![
                ChecklistItem {
                    id: "yes".to_owned(),
                    label: String::new(),
                    should_tick: true,
                    why: String::new(),
                },
                ChecklistItem {
                    id: "no".to_owned(),
                    label: String::new(),
                    should_tick: false,
                    why: String::new(),
                },
            ],
            vec!["no".to_owned()],
        )
    }

    #[test]
    fn decimals_compare_exactly() {
        assert!(decimal_equals("10", "10.00"));
        assert!(decimal_equals("+10.000", "10"));
        assert!(decimal_equals("010.5", "10.50"));
        assert!(!decimal_equals("10.0001", "10"));
        assert!(!decimal_equals("", "0"));
        assert!(!decimal_equals("0", ""));
        assert!(!decimal_equals("abc", "0"));
        assert_eq!(parse_decimal("-0"), Some(Decimal::ZERO));
        assert!(parse_decimal("5.").is_some());
        assert!(parse_decimal(".5").is_some());
        assert!(parse_decimal(".").is_none());
        assert!(parse_decimal("1e5").is_none());
        assert!(parse_decimal("1,000").is_none());
        assert_eq!(parse_decimal("1".repeat(41).as_str()), None);
    }

    #[test]
    fn tolerance_is_absolute_and_exact() {
        let ten = parse_decimal("10.00").expect("key");
        let within = parse_decimal("10.01").expect("value");
        let outside = parse_decimal("10.02").expect("value");
        let tolerance = parse_decimal("0.01").expect("tol");
        assert!(within.abs_diff_le(&ten, tolerance.clone()));
        assert!(!outside.abs_diff_le(&ten, tolerance));
        // The difference to -10 is 20, so only a 20 (or larger) tolerance matches.
        let negative = parse_decimal("-10").expect("neg");
        assert!(!negative.abs_diff_le(&ten, parse_decimal("0").expect("zero")));
        assert!(negative.abs_diff_le(&ten, parse_decimal("20").expect("twenty")));
        assert!(parse_decimal("9.9")
            .expect("below")
            .abs_diff_le(&ten, parse_decimal("0.1").expect("tol")));
    }

    #[test]
    fn score_strings_use_the_four_decimal_grid() {
        assert_eq!(Score4::from_points(8).to_points_string(), "8.0000");
        assert_eq!(Score4(83_333).to_points_string(), "8.3333");
        assert_eq!(Score4(0).to_points_string(), "0.0000");
    }

    #[test]
    fn choice_scores_and_critical_options() {
        let task = choice_task(10);
        let right = score_task(&task, Some(&TaskAnswer::choice("right")), false);
        assert_eq!(right.score, Score4::from_points(10));
        assert!(right.correct);
        assert!(!right.critical_error);

        let danger = score_task(&task, Some(&TaskAnswer::choice("danger")), false);
        assert_eq!(danger.score, Score4::ZERO);
        assert!(danger.critical_error);
        assert_eq!(danger.detail.critical_ids, vec!["danger".to_owned()]);

        let hint = score_task(&task, Some(&TaskAnswer::choice("right").with_hint()), false);
        assert_eq!(hint.score.units(), 90_000);
        assert_eq!(hint.hint_penalty, 1);
        assert!(hint.correct, "full marks before the hint penalty");
    }

    #[test]
    fn multi_applies_partial_credit_and_critical_wrong() {
        let task = multi_task(10);
        let full = score_task(&task, Some(&TaskAnswer::multi(["a", "b"])), false);
        assert_eq!(full.score, Score4::from_points(10));
        assert!(full.correct);

        let half = score_task(&task, Some(&TaskAnswer::multi(["a"])), false);
        assert_eq!(half.score.to_points_string(), "5.0000");
        assert!(!half.correct);

        let penalised = score_task(&task, Some(&TaskAnswer::multi(["a", "c"])), false);
        assert_eq!(penalised.score, Score4::ZERO);
        assert!(penalised.critical_error);
        assert_eq!(penalised.detail.wrong_selected, Some(1));

        // An id that is not an option never matches and is not a wrong selection; the score keeps
        // the full marks (the TS `finish` "full marks before the penalty" flag) while the set is
        // no longer exact, so it is not a correct answer set.
        let unknown = score_task(&task, Some(&TaskAnswer::multi(["a", "b", "z"])), false);
        assert_eq!(unknown.score.to_points_string(), "10.0000");
        assert_eq!(unknown.detail.correct_selected, Some(2));
        assert_eq!(unknown.detail.wrong_selected, Some(0));
    }

    #[test]
    fn ledger_matches_exact_amounts_and_counts_extra_cells() {
        let task = ledger_task(10);
        let cells = BTreeMap::from([
            (
                "CASH".to_owned(),
                LedgerCell {
                    dr: Some("10".to_owned()),
                    cr: None,
                },
            ),
            (
                "REVENUE".to_owned(),
                LedgerCell {
                    dr: None,
                    cr: Some("10.000".to_owned()),
                },
            ),
        ]);
        let full = score_task(&task, Some(&TaskAnswer::ledger(cells)), false);
        assert_eq!(full.score, Score4::from_points(10));
        assert_eq!(full.detail.matched_lines, Some(2));

        let cells = BTreeMap::from([
            (
                "CASH".to_owned(),
                LedgerCell {
                    dr: Some("10.01".to_owned()),
                    cr: None,
                },
            ),
            (
                "REVENUE".to_owned(),
                LedgerCell {
                    dr: None,
                    cr: Some("10".to_owned()),
                },
            ),
        ]);
        let half = score_task(&task, Some(&TaskAnswer::ledger(cells)), false);
        assert_eq!(half.score.to_points_string(), "5.0000");

        let cells = BTreeMap::from([
            (
                "CASH".to_owned(),
                LedgerCell {
                    dr: Some("10".to_owned()),
                    cr: None,
                },
            ),
            (
                "REVENUE".to_owned(),
                LedgerCell {
                    dr: None,
                    cr: Some("10".to_owned()),
                },
            ),
            (
                "OTHER".to_owned(),
                LedgerCell {
                    dr: Some("0.01".to_owned()),
                    cr: None,
                },
            ),
        ]);
        let extra = score_task(&task, Some(&TaskAnswer::ledger(cells)), false);
        assert_eq!(extra.score.to_points_string(), "5.0000");
        assert_eq!(extra.detail.extra_cells, Some(1));

        let cells = BTreeMap::from([
            (
                "CASH".to_owned(),
                LedgerCell {
                    dr: Some("10".to_owned()),
                    cr: None,
                },
            ),
            (
                "REVENUE".to_owned(),
                LedgerCell {
                    dr: None,
                    cr: Some("10".to_owned()),
                },
            ),
            (
                "OTHER".to_owned(),
                LedgerCell {
                    dr: Some("0.0".to_owned()),
                    cr: None,
                },
            ),
        ]);
        let zero = score_task(&task, Some(&TaskAnswer::ledger(cells)), false);
        assert_eq!(zero.score, Score4::from_points(10));
        assert_eq!(zero.detail.extra_cells, Some(0));
    }

    #[test]
    fn order_earns_positions_rounded_down_to_one_decimal() {
        let task = LabTask::order("t4", 10, ["a", "b", "c", "d"]);
        let full = score_task(&task, Some(&TaskAnswer::order(["a", "b", "c", "d"])), false);
        assert_eq!(full.score, Score4::from_points(10));

        let three = LabTask::order("t4", 10, ["a", "b", "c"]);
        let two = score_task(&three, Some(&TaskAnswer::order(["a", "b", "x"])), false);
        assert_eq!(two.score.to_points_string(), "6.6000");
        let one = score_task(&three, Some(&TaskAnswer::order(["a", "x", "y"])), false);
        assert_eq!(one.score.to_points_string(), "3.3000");
        assert_eq!(one.detail.correct_positions, Some(1));

        // Extra items subtract from the hit count.
        let extra = score_task(
            &task,
            Some(&TaskAnswer::order(["a", "b", "c", "d", "e"])),
            false,
        );
        assert!(!extra.correct);
        assert_eq!(extra.detail.correct_positions, Some(3));
    }

    #[test]
    fn checklist_and_numeric() {
        let task = checklist_task(8);
        let full = score_task(&task, Some(&TaskAnswer::checklist(["yes"])), false);
        assert_eq!(full.score, Score4::from_points(8));
        let wrong = score_task(&task, Some(&TaskAnswer::checklist(["yes", "no"])), false);
        assert_eq!(wrong.score.to_points_string(), "4.0000");
        assert!(wrong.critical_error);

        let numeric = LabTask::numeric("n1", 5, "2.5", "0.01");
        assert_eq!(
            score_task(&numeric, Some(&TaskAnswer::numeric("2.505")), false).score,
            Score4::from_points(5)
        );
        assert_eq!(
            score_task(&numeric, Some(&TaskAnswer::numeric("2.52")), false).score,
            Score4::ZERO
        );
    }

    #[test]
    fn lab_result_rounds_half_up_and_requires_no_critical_error() {
        let tasks = vec![
            TaskScore {
                task_id: "a".to_owned(),
                score: Score4(83_333),
                max_score: 10,
                critical_error: false,
                correct: false,
                hint_penalty: 0,
                detail: ScoreDetail::default(),
            },
            TaskScore {
                task_id: "b".to_owned(),
                score: Score4::from_points(10),
                max_score: 10,
                critical_error: false,
                correct: true,
                hint_penalty: 0,
                detail: ScoreDetail::default(),
            },
        ];
        let result = compute_lab_result(&tasks, 80);
        assert_eq!(result.score, 92);
        assert!(result.passed);
        assert_eq!(result.earned.to_points_string(), "18.3333");
        assert_eq!(result.possible.to_points_string(), "20.0000");

        let critical = vec![TaskScore {
            critical_error: true,
            ..tasks[1].clone()
        }];
        let result = compute_lab_result(&critical, 80);
        assert!(!result.passed);
        assert_eq!(result.critical_errors, 1);
    }

    #[test]
    fn a_whole_lab_scores_and_validates() {
        let lab = Lab {
            id: "lab-1".to_owned(),
            pass_percent: 80,
            tasks: vec![choice_task(10), multi_task(10), ledger_task(20)],
        };
        validate_lab(&lab).expect("valid");
        let answers = BTreeMap::from([
            ("t1".to_owned(), TaskAnswer::choice("right")),
            ("t2".to_owned(), TaskAnswer::multi(["a", "b"])),
            ("t3".to_owned(), TaskAnswer::ledger(BTreeMap::new())),
        ]);
        let score = score_lab(&lab, &answers, &BTreeSet::new());
        assert_eq!(score.score, 50);
        assert!(!score.passed);
        assert_eq!(score.tasks.len(), 3);

        let hinted = BTreeSet::from(["t1".to_owned()]);
        let score = score_lab(&lab, &answers, &hinted);
        assert_eq!(score.score, 48);
        assert_eq!(score.tasks[0].score.to_points_string(), "9.0000");

        let empty = Lab {
            id: "x".to_owned(),
            pass_percent: 80,
            tasks: Vec::new(),
        };
        assert_eq!(validate_lab(&empty), Err(LabError::EmptyLab));
        let zero = Lab {
            id: "x".to_owned(),
            pass_percent: 80,
            tasks: vec![LabTask::choice("t1", 0, Vec::new())],
        };
        assert_eq!(
            validate_lab(&zero),
            Err(LabError::NonPositivePoints("t1".to_owned()))
        );
    }

    #[test]
    fn generated_content_shape_deserialises() {
        let json = serde_json::json!({
            "id": "lab-flow-tracer",
            "passPercent": 80,
            "tasks": [
                {
                    "id": "t1",
                    "kind": "choice",
                    "title": "Pick one",
                    "prompt": "Which?",
                    "points": 4,
                    "options": [
                        { "id": "a", "label": "A", "correct": true, "feedback": "yes" },
                        { "id": "b", "label": "B", "correct": false, "critical": true, "feedback": "no" }
                    ]
                },
                {
                    "id": "t2",
                    "kind": "checklist",
                    "title": "Tick",
                    "prompt": "All that apply",
                    "points": 6,
                    "items": [{ "id": "x", "label": "X", "shouldTick": true, "why": "because" }],
                    "criticalWrong": ["x"]
                }
            ]
        });
        let lab: Lab = serde_json::from_value(json).expect("content shape");
        assert_eq!(lab.pass_percent, 80);
        assert_eq!(lab.tasks.len(), 2);
        assert_eq!(lab.tasks[0].id(), "t1");
        assert_eq!(lab.tasks[0].kind_name(), "choice");
        let score = score_task(&lab.tasks[0], Some(&TaskAnswer::choice("b")), false);
        assert!(score.critical_error);
    }
}
