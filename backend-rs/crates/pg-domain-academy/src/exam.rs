//! The pure exam grader.
//!
//! Port of `core-back/engine/academy/grading.ts` (`percent`, `gradeQuestion`, `gradeExam`,
//! `REVIEW_BELOW_PERCENT`) and the pass rule of `service.ts:352`
//! (`scorePercent >= passPercent && criticalMissed === 0`), plus the 3-failure review rule of
//! `service.ts:45-46` and `:192-206` (`CONSECUTIVE_FAILS_FOR_REVIEW`,
//! `REVIEW_BELOW_PERCENT`).
//!
//! Scoring rules copied from the TS:
//!
//! - every question is worth its `points` (1 in the shipped bank), and a correct answer earns the
//!   full amount;
//! - `single`/`truefalse`: exactly one selection that equals the key;
//! - `multi`: the exact set of correct options (all-or-nothing; a missed or extra option loses the
//!   whole question);
//! - `order`: the exact permutation in the key order;
//! - `number`: `|answer - key| <= |tolerance|`;
//! - a critical question that is answered incorrectly sets the critical gate, so the exam cannot
//!   pass even above the threshold;
//! - unanswered questions score zero; option ids that are not part of the question never match.
//!
//! Parity switch: [`ScoringMode::Exact`] is the TS behaviour and the default.
//! [`ScoringMode::PartialCredit`] is an opt-in extension of the port brief (`multi` earns
//! `correct_selected / correct_total`, `order` earns `correct_positions / length`). It is never
//! used for a parity run.
//!
//! The session `oid` indirection (`OpenQuestionState.opts`) is a service-layer mapping; answers
//! here carry the option ids directly.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::lab::parse_decimal;
use crate::time::UtcMillis;

/// `REVIEW_BELOW_PERCENT`.
pub const REVIEW_BELOW_PERCENT: u32 = 70;
/// `CONSECUTIVE_FAILS_FOR_REVIEW`.
pub const CONSECUTIVE_FAILS_FOR_REVIEW: usize = 3;
/// `MAX_STORED_ATTEMPTS` (the stored attempt list is capped at the last 20).
pub const MAX_STORED_ATTEMPTS: usize = 20;
/// `SUBMIT_GRACE_MS`: a submission is accepted for two minutes after the session expiry.
pub const SUBMIT_GRACE_MS: i64 = 120_000;

/// `QType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionKind {
    Single,
    Multi,
    Order,
    Number,
    TrueFalse,
}

/// A bank option (`BankOption`; `text`, `note` and difficulty are content fields the grader ignores).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExamOption {
    pub id: String,
    #[serde(default)]
    pub correct: bool,
}

impl ExamOption {
    #[must_use]
    pub fn new(id: impl Into<String>, correct: bool) -> Self {
        Self {
            id: id.into(),
            correct,
        }
    }
}

/// One bank question, reduced to what grading needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExamQuestion {
    pub id: String,
    pub module: String,
    /// The question type (`type` in the generated bank).
    #[serde(rename = "kind", alias = "type")]
    pub kind: QuestionKind,
    /// Weight of the question; 1 matches the shipped bank.
    #[serde(default = "one_point")]
    pub points: u32,
    #[serde(default)]
    pub critical: bool,
    #[serde(default)]
    pub options: Vec<ExamOption>,
    /// The key of a `number` question.
    #[serde(default)]
    pub answer: Option<String>,
    /// The absolute tolerance of a `number` question.
    #[serde(default)]
    pub tolerance: Option<String>,
}

const fn one_point() -> u32 {
    1
}

impl ExamQuestion {
    #[must_use]
    pub fn new(
        id: impl Into<String>,
        module: impl Into<String>,
        kind: QuestionKind,
        options: Vec<ExamOption>,
    ) -> Self {
        Self {
            id: id.into(),
            module: module.into(),
            kind,
            points: 1,
            critical: false,
            options,
            answer: None,
            tolerance: None,
        }
    }

    #[must_use]
    pub fn critical(mut self) -> Self {
        self.critical = true;
        self
    }

    #[must_use]
    pub fn with_points(mut self, points: u32) -> Self {
        self.points = points;
        self
    }

    #[must_use]
    pub fn number(
        id: impl Into<String>,
        module: impl Into<String>,
        answer: impl Into<String>,
        tolerance: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            module: module.into(),
            kind: QuestionKind::Number,
            points: 1,
            critical: false,
            options: Vec::new(),
            answer: Some(answer.into()),
            tolerance: Some(tolerance.into()),
        }
    }
}

/// An answer as submitted (`ExamAnswer`: a single oid/string, a list of oids, or a number string).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ExamAnswer {
    Choice(String),
    Multi(Vec<String>),
}

impl ExamAnswer {
    fn string_list(&self) -> Vec<String> {
        match self {
            Self::Choice(value) => vec![value.clone()],
            Self::Multi(values) => values.clone(),
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Self::Choice(value) => Some(value),
            // The TS treats an array answer to a number question as unanswered.
            Self::Multi(_) => None,
        }
    }
}

/// Submitted answers keyed by question id.
pub type ExamAnswers = BTreeMap<String, ExamAnswer>;

/// The TS scoring rules, or the opt-in partial-credit extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScoringMode {
    Exact,
    PartialCredit,
}

/// Grading options.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GradeOptions {
    pub pass_threshold: u32,
    /// `zeroOut`: an expired session ignores every answer.
    pub zero_out: bool,
    pub mode: ScoringMode,
}

impl GradeOptions {
    #[must_use]
    pub const fn new(pass_threshold: u32) -> Self {
        Self {
            pass_threshold,
            zero_out: false,
            mode: ScoringMode::Exact,
        }
    }
}

/// One graded question (`ExamResultItem` reduced to the score fields).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOutcome {
    pub id: String,
    pub module: String,
    pub kind: QuestionKind,
    pub critical: bool,
    pub answered: bool,
    pub correct: bool,
    pub critical_missed: bool,
    pub points_earned: u32,
    pub points_possible: u32,
}

/// The graded exam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExamResult {
    pub items: Vec<QuestionOutcome>,
    pub points: u32,
    pub points_possible: u32,
    pub score_percent: u32,
    pub pass_threshold: u32,
    pub critical_missed: usize,
    pub module_scores: BTreeMap<String, u32>,
    /// Modules below [`REVIEW_BELOW_PERCENT`], sorted by module id.
    pub review_required: Vec<String>,
    pub passed: bool,
    /// The session expired and the answers were zeroed out.
    pub expired: bool,
}

impl ExamResult {
    #[must_use]
    pub fn outcome_of(&self, question_id: &str) -> Option<&QuestionOutcome> {
        self.items.iter().find(|item| item.id == question_id)
    }
}

/// `percent`: round half up to an integer percentage, with integer arithmetic.
#[must_use]
pub fn percent(points: u32, total: u32) -> u32 {
    if total == 0 {
        return 0;
    }
    let numerator = u64::from(points) * 200 + u64::from(total);
    let denominator = u64::from(total) * 2;
    u32::try_from(numerator / denominator).unwrap_or(100)
}

/// `gradeExam` with the TS pass threshold.
#[must_use]
pub fn grade_exam(answers: &ExamAnswers, bank: &[ExamQuestion], pass_threshold: u32) -> ExamResult {
    grade_exam_with(answers, bank, GradeOptions::new(pass_threshold))
}

/// `gradeExam` with explicit options (expired session, scoring mode).
#[must_use]
pub fn grade_exam_with(
    answers: &ExamAnswers,
    bank: &[ExamQuestion],
    options: GradeOptions,
) -> ExamResult {
    let mut items = Vec::with_capacity(bank.len());
    let mut points = 0_u32;
    let mut points_possible = 0_u32;
    let mut critical_missed = 0_usize;
    let mut module_totals: BTreeMap<String, (u32, u32)> = BTreeMap::new();

    for question in bank {
        let answer = if options.zero_out {
            None
        } else {
            answers.get(&question.id)
        };
        let correct = answer.is_some_and(|answer| is_correct(question, answer));
        let answered = answer.is_some_and(|answer| is_answered(question, answer));
        let earned = if correct {
            question.points
        } else if options.mode == ScoringMode::PartialCredit {
            partial_points(question, answer)
        } else {
            0
        };
        if !correct && question.critical {
            critical_missed += 1;
        }
        points = points.saturating_add(earned);
        points_possible = points_possible.saturating_add(question.points);
        let totals = module_totals
            .entry(question.module.clone())
            .or_insert((0, 0));
        totals.0 = totals.0.saturating_add(earned);
        totals.1 = totals.1.saturating_add(question.points);
        items.push(QuestionOutcome {
            id: question.id.clone(),
            module: question.module.clone(),
            kind: question.kind,
            critical: question.critical,
            answered,
            correct,
            critical_missed: !correct && question.critical,
            points_earned: earned,
            points_possible: question.points,
        });
    }

    let module_scores: BTreeMap<String, u32> = module_totals
        .iter()
        .map(|(module, (earned, possible))| (module.clone(), percent(*earned, *possible)))
        .collect();
    let review_required: Vec<String> = module_scores
        .iter()
        .filter(|(_, score)| **score < REVIEW_BELOW_PERCENT)
        .map(|(module, _)| module.clone())
        .collect();
    let score_percent = percent(points, points_possible);
    ExamResult {
        items,
        points,
        points_possible,
        score_percent,
        pass_threshold: options.pass_threshold,
        critical_missed,
        module_scores,
        review_required,
        passed: !options.zero_out
            && score_percent >= options.pass_threshold
            && critical_missed == 0,
        expired: options.zero_out,
    }
}

fn is_answered(question: &ExamQuestion, answer: &ExamAnswer) -> bool {
    match question.kind {
        QuestionKind::Number => answer
            .as_str()
            .is_some_and(|value| !value.trim().is_empty()),
        QuestionKind::Multi | QuestionKind::Order => !answer.string_list().is_empty(),
        QuestionKind::Single | QuestionKind::TrueFalse => {
            answer.as_str().is_some_and(|value| !value.is_empty())
        }
    }
}

fn is_correct(question: &ExamQuestion, answer: &ExamAnswer) -> bool {
    match question.kind {
        QuestionKind::Single | QuestionKind::TrueFalse => {
            let Some(chosen) = answer.as_str() else {
                return false;
            };
            let keys: Vec<&ExamOption> = question
                .options
                .iter()
                .filter(|option| option.correct)
                .collect();
            keys.len() == 1 && keys[0].id == chosen
        }
        QuestionKind::Multi => {
            let chosen = unique(answer.string_list());
            let keys: Vec<String> = question
                .options
                .iter()
                .filter(|option| option.correct)
                .map(|option| option.id.clone())
                .collect();
            // `picked.size === correctIds.length && correctIds.every(picked)`: the exact set.
            !keys.is_empty()
                && chosen.len() == keys.len()
                && keys.iter().all(|key| chosen.contains(key))
        }
        QuestionKind::Order => {
            let order = answer.string_list();
            let keys: Vec<&str> = question
                .options
                .iter()
                .map(|option| option.id.as_str())
                .collect();
            order.len() == keys.len() && order.iter().zip(&keys).all(|(given, key)| given == key)
        }
        QuestionKind::Number => {
            let Some(given) = answer.as_str() else {
                return false;
            };
            let Some(expected) = question.answer.as_deref() else {
                return false;
            };
            parse_decimal(given)
                .zip(parse_decimal(expected))
                .is_some_and(|(given, expected)| {
                    let tolerance = question
                        .tolerance
                        .as_deref()
                        .and_then(parse_decimal)
                        .unwrap_or(crate::lab::Decimal::ZERO);
                    given.abs_diff_le(&expected, tolerance)
                })
        }
    }
}

fn partial_points(question: &ExamQuestion, answer: Option<&ExamAnswer>) -> u32 {
    let Some(answer) = answer else {
        return 0;
    };
    match question.kind {
        QuestionKind::Multi => {
            let keys: Vec<&str> = question
                .options
                .iter()
                .filter(|option| option.correct)
                .map(|option| option.id.as_str())
                .collect();
            if keys.is_empty() {
                return 0;
            }
            let chosen = unique(answer.string_list());
            let hit = keys
                .iter()
                .filter(|key| chosen.iter().any(|value| value.as_str() == **key))
                .count();
            // `ratioScore(points, correctSelected - wrongSelected, totalCorrect)`.
            let wrong = chosen
                .iter()
                .filter(|value| !keys.contains(&value.as_str()))
                .count();
            let numerator = i64::try_from(hit).unwrap_or(0) - i64::try_from(wrong).unwrap_or(0);
            if numerator <= 0 {
                return 0;
            }
            u32::try_from(u64::from(question.points) * numerator as u64 / keys.len() as u64)
                .unwrap_or(0)
        }
        QuestionKind::Order => {
            let keys: Vec<&str> = question
                .options
                .iter()
                .map(|option| option.id.as_str())
                .collect();
            if keys.is_empty() {
                return 0;
            }
            let order = answer.string_list();
            let mut right = order
                .iter()
                .zip(&keys)
                .filter(|(given, key)| given == key)
                .count();
            if order.len() > keys.len() {
                right = right.saturating_sub(order.len() - keys.len());
            }
            u32::try_from(u64::from(question.points) * right as u64 / keys.len() as u64)
                .unwrap_or(0)
        }
        _ => 0,
    }
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

/// One stored attempt (`ExamAttemptSummary`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExamAttempt {
    pub at: UtcMillis,
    pub score_percent: u32,
    pub passed: bool,
    pub critical_missed: u32,
    pub module_scores: BTreeMap<String, u32>,
    pub duration_seconds: u32,
}

/// The number of consecutive trailing failures.
#[must_use]
pub fn trailing_failures(attempts: &[ExamAttempt]) -> usize {
    attempts
        .iter()
        .rev()
        .take_while(|attempt| !attempt.passed)
        .count()
}

/// The 3-failure review gate of the eligibility check.
#[must_use]
pub fn requires_review(attempts: &[ExamAttempt]) -> bool {
    !attempts.is_empty() && trailing_failures(attempts) >= CONSECUTIVE_FAILS_FOR_REVIEW
}

/// The modules the learner must re-open a lesson of before the next attempt.
///
/// `reopened` maps a module id to the latest instant a lesson of that module was re-opened; only a
/// re-open strictly after the last attempt counts (the TS compares `>`).
#[must_use]
pub fn review_modules(
    attempts: &[ExamAttempt],
    reopened: &BTreeMap<String, UtcMillis>,
) -> Vec<String> {
    let Some(last) = attempts.last() else {
        return Vec::new();
    };
    if !requires_review(attempts) {
        return Vec::new();
    }
    last.module_scores
        .iter()
        .filter(|(_, score)| **score < REVIEW_BELOW_PERCENT)
        .filter(|(module, _)| {
            reopened
                .get(*module)
                .is_none_or(|instant| *instant <= last.at)
        })
        .map(|(module, _)| module.clone())
        .collect()
}

/// Keep the last `MAX_STORED_ATTEMPTS` attempts (the TS `slice(-20)`).
pub fn trim_attempts(attempts: &mut Vec<ExamAttempt>) {
    if attempts.len() > MAX_STORED_ATTEMPTS {
        let drain = attempts.len() - MAX_STORED_ATTEMPTS;
        attempts.drain(..drain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answers(pairs: &[(&str, ExamAnswer)]) -> ExamAnswers {
        pairs
            .iter()
            .map(|(id, answer)| ((*id).to_owned(), answer.clone()))
            .collect()
    }

    fn single(id: &str, correct: &str) -> ExamQuestion {
        ExamQuestion::new(
            id,
            "m1",
            QuestionKind::Single,
            vec![
                ExamOption::new(correct, true),
                ExamOption::new("wrong", false),
            ],
        )
    }

    #[test]
    fn percent_rounds_half_up() {
        assert_eq!(percent(0, 0), 0);
        assert_eq!(percent(1, 3), 33);
        assert_eq!(percent(2, 3), 67);
        assert_eq!(percent(1, 2), 50);
        assert_eq!(percent(3, 3), 100);
        assert_eq!(percent(1, 8), 13); // 12.5 -> 13
    }

    #[test]
    fn single_and_true_false_need_exactly_the_key() {
        let bank = vec![single("q1", "yes")];
        let result = grade_exam(
            &answers(&[("q1", ExamAnswer::Choice("yes".into()))]),
            &bank,
            70,
        );
        assert!(result.passed);
        assert_eq!(result.score_percent, 100);
        assert!(result.items[0].correct);

        let wrong = grade_exam(
            &answers(&[("q1", ExamAnswer::Choice("wrong".into()))]),
            &bank,
            70,
        );
        assert!(!wrong.passed);
        assert_eq!(wrong.score_percent, 0);
        assert!(wrong.items[0].answered);
        assert!(!wrong.items[0].correct);

        let unanswered = grade_exam(&answers(&[]), &bank, 70);
        assert!(!unanswered.items[0].answered);
        assert_eq!(unanswered.score_percent, 0);
    }

    #[test]
    fn multi_is_all_or_nothing_in_exact_mode() {
        let bank = vec![ExamQuestion::new(
            "q1",
            "m1",
            QuestionKind::Multi,
            vec![
                ExamOption::new("a", true),
                ExamOption::new("b", true),
                ExamOption::new("c", false),
            ],
        )];
        let exact = grade_exam(
            &answers(&[("q1", ExamAnswer::Multi(vec!["a".into(), "b".into()]))]),
            &bank,
            70,
        );
        assert!(exact.passed);

        // A missed option and an extra option both lose the question.
        for chosen in [
            vec!["a".to_owned()],
            vec!["a".into(), "b".into(), "c".into()],
        ] {
            let result = grade_exam(&answers(&[("q1", ExamAnswer::Multi(chosen))]), &bank, 70);
            assert_eq!(result.score_percent, 0);
        }
        // Duplicate selections collapse.
        let duplicates = grade_exam(
            &answers(&[(
                "q1",
                ExamAnswer::Multi(vec!["a".into(), "a".into(), "b".into()]),
            )]),
            &bank,
            70,
        );
        assert!(duplicates.items[0].correct);

        // The opt-in partial-credit mode awards half for one of two.
        let partial = grade_exam_with(
            &answers(&[("q1", ExamAnswer::Multi(vec!["a".into()]))]),
            &bank,
            GradeOptions {
                pass_threshold: 70,
                zero_out: false,
                mode: ScoringMode::PartialCredit,
            },
        );
        assert_eq!(partial.points, 0);
        let partial_two_points = grade_exam_with(
            &answers(&[("q1", ExamAnswer::Multi(vec!["a".into()]))]),
            &[ExamQuestion::new(
                "q1",
                "m1",
                QuestionKind::Multi,
                vec![ExamOption::new("a", true), ExamOption::new("b", true)],
            )
            .with_points(2)],
            GradeOptions {
                pass_threshold: 70,
                zero_out: false,
                mode: ScoringMode::PartialCredit,
            },
        );
        assert_eq!(partial_two_points.points, 1);
    }

    #[test]
    fn order_must_be_the_exact_permutation() {
        let bank = vec![ExamQuestion::new(
            "q1",
            "m1",
            QuestionKind::Order,
            vec![
                ExamOption::new("a", false),
                ExamOption::new("b", false),
                ExamOption::new("c", false),
            ],
        )];
        let ok = grade_exam(
            &answers(&[(
                "q1",
                ExamAnswer::Multi(vec!["a".into(), "b".into(), "c".into()]),
            )]),
            &bank,
            70,
        );
        assert!(ok.passed);
        for order in [
            vec!["a".to_owned(), "c".into(), "b".into()],
            vec!["a".to_owned(), "b".into()],
            vec!["a".to_owned(), "b".into(), "c".into(), "d".into()],
        ] {
            let result = grade_exam(&answers(&[("q1", ExamAnswer::Multi(order))]), &bank, 70);
            assert_eq!(result.score_percent, 0);
        }
    }

    #[test]
    fn number_tolerance_and_garbage() {
        let bank = vec![ExamQuestion::number("q1", "m1", "10.00", "0.01")];
        let ok = grade_exam(
            &answers(&[("q1", ExamAnswer::Choice("10.005".into()))]),
            &bank,
            70,
        );
        assert!(ok.passed);
        let outside = grade_exam(
            &answers(&[("q1", ExamAnswer::Choice("10.02".into()))]),
            &bank,
            70,
        );
        assert!(!outside.passed);
        for garbage in ["", "abc", "1e5", "NaN"] {
            let result = grade_exam(
                &answers(&[("q1", ExamAnswer::Choice(garbage.into()))]),
                &bank,
                70,
            );
            assert!(!result.passed, "{garbage}");
            assert!(!result.items[0].answered || !result.items[0].correct);
        }
        // An array answer to a number question is unanswered (TS `typeof answer === "string"`).
        let array = grade_exam(
            &answers(&[("q1", ExamAnswer::Multi(vec!["10".into()]))]),
            &bank,
            70,
        );
        assert!(!array.items[0].answered);
    }

    #[test]
    fn critical_gate_blocks_the_pass() {
        let bank = vec![single("q1", "yes"), single("q2", "yes").critical()];
        let result = grade_exam(
            &answers(&[("q1", ExamAnswer::Choice("yes".into()))]),
            &bank,
            50,
        );
        assert_eq!(result.score_percent, 50);
        assert_eq!(result.critical_missed, 1);
        assert!(!result.passed);
        assert!(result.items[1].critical_missed);
    }

    #[test]
    fn expired_sessions_zero_every_answer() {
        let bank = vec![single("q1", "yes")];
        let result = grade_exam_with(
            &answers(&[("q1", ExamAnswer::Choice("yes".into()))]),
            &bank,
            GradeOptions {
                pass_threshold: 50,
                zero_out: true,
                mode: ScoringMode::Exact,
            },
        );
        assert!(result.expired);
        assert_eq!(result.score_percent, 0);
        assert!(!result.passed);
    }

    #[test]
    fn module_scores_and_review_are_sorted() {
        let bank = vec![
            ExamQuestion::new(
                "q1",
                "m2",
                QuestionKind::Single,
                vec![ExamOption::new("yes", true)],
            ),
            ExamQuestion::new(
                "q2",
                "m1",
                QuestionKind::Single,
                vec![ExamOption::new("yes", true)],
            ),
            ExamQuestion::new(
                "q3",
                "m1",
                QuestionKind::Single,
                vec![ExamOption::new("yes", true)],
            ),
        ];
        let result = grade_exam(
            &answers(&[
                ("q1", ExamAnswer::Choice("no".into())),
                ("q2", ExamAnswer::Choice("yes".into())),
            ]),
            &bank,
            70,
        );
        assert_eq!(result.module_scores["m1"], 50);
        assert_eq!(result.module_scores["m2"], 0);
        assert_eq!(
            result.review_required,
            vec!["m1".to_owned(), "m2".to_owned()]
        );
        assert_eq!(result.score_percent, 33);
    }

    #[test]
    fn unknown_questions_and_option_ids_never_match() {
        let bank = vec![single("q1", "yes")];
        let result = grade_exam(
            &answers(&[
                ("q1", ExamAnswer::Choice("unknown-oid".into())),
                ("q404", ExamAnswer::Choice("yes".into())),
            ]),
            &bank,
            70,
        );
        assert_eq!(result.items.len(), 1);
        assert!(!result.items[0].correct);
    }

    #[test]
    fn three_trailing_failures_trigger_the_review_gate() {
        let at = |day: i64| UtcMillis::from_millis(day * 86_400_000);
        let failed = |day: i64, module: &str, score: u32| ExamAttempt {
            at: at(day),
            score_percent: score,
            passed: false,
            critical_missed: 0,
            module_scores: BTreeMap::from([(module.to_owned(), score)]),
            duration_seconds: 60,
        };
        assert!(!requires_review(&[
            failed(1, "m1", 10),
            failed(2, "m1", 20)
        ]));
        let attempts = vec![
            failed(1, "m1", 10),
            failed(2, "m1", 20),
            failed(3, "m2", 80),
        ];
        assert_eq!(trailing_failures(&attempts), 3);
        assert!(requires_review(&attempts));
        // Only modules below 70 need review.
        assert!(review_modules(&attempts, &BTreeMap::new()).is_empty());

        let attempts = vec![
            failed(1, "m1", 10),
            failed(2, "m1", 20),
            failed(3, "m1", 40),
        ];
        assert_eq!(
            review_modules(&attempts, &BTreeMap::new()),
            vec!["m1".to_owned()]
        );
        // A lesson re-opened after the last attempt satisfies the review.
        let reopened = BTreeMap::from([("m1".to_owned(), at(4))]);
        assert!(review_modules(&attempts, &reopened).is_empty());
        // A re-open before the last attempt does not.
        let reopened = BTreeMap::from([("m1".to_owned(), at(3))]);
        assert_eq!(review_modules(&attempts, &reopened), vec!["m1".to_owned()]);
        // A pass resets the streak.
        let mut passed = failed(4, "m1", 40);
        passed.passed = true;
        assert!(!requires_review(&[
            failed(1, "m1", 10),
            failed(2, "m1", 10),
            passed
        ]));
    }

    #[test]
    fn attempts_are_trimmed_to_twenty() {
        let mut attempts: Vec<ExamAttempt> = (0..25)
            .map(|day| ExamAttempt {
                at: UtcMillis::from_millis(day * 1_000),
                score_percent: 50,
                passed: false,
                critical_missed: 0,
                module_scores: BTreeMap::new(),
                duration_seconds: 1,
            })
            .collect();
        trim_attempts(&mut attempts);
        assert_eq!(attempts.len(), MAX_STORED_ATTEMPTS);
        assert_eq!(attempts[0].at.as_millis(), 5_000);
    }

    #[test]
    fn the_generated_bank_shape_deserialises() {
        let json = serde_json::json!({
            "id": "q-m1-001",
            "module": "m1",
            "type": "single",
            "difficulty": 2,
            "critical": true,
            "tracks": ["ALL"],
            "refs": ["a"],
            "stem": "Which?",
            "options": [
                { "id": "a", "text": "A", "correct": true },
                { "id": "b", "text": "B" }
            ],
            "why": "because"
        });
        let question: ExamQuestion = serde_json::from_value(json).expect("bank shape");
        assert_eq!(question.kind, QuestionKind::Single);
        assert_eq!(question.points, 1);
        assert!(question.critical);
        assert_eq!(question.options.len(), 2);
        assert!(!question.options[1].correct);
    }
}
