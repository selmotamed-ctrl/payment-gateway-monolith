//! Academy domain: exam grading, lab scoring and certificate verification.
//!
//! Ports `core-back/engine/academy/{grading,certificate}.ts`, the pass/critical rule and review
//! constants of `engine/academy/service.ts`, and the pure lab engine of
//! `admin-front/src/components/academy/labScoring.ts`.
//!
//! No I/O, no randomness: the caller owns the session store, the random bytes of a certificate
//! identity and the database. The crate has only `serde`, `serde_json` and `thiserror`, so
//! [`time`] carries the few UTC calendar operations the Academy needs (`addMonthsUtc` and the
//! `expiresAt > now` comparison) with no `chrono` dependency and no floating point.
//!
//! The deterministic exam-set builder (`seedFor`, `mulberry32`, `seededShuffle`, `pickQuestions`,
//! `buildQuestionState`) is not here yet: it needs the golden vectors of the port plan
//! (`02_contracts_reference.md` §27) and a `sha2`/`rand` dependency this crate does not carry;
//! it belongs to a follow-up that adds them to this crate's manifest.

#![forbid(unsafe_code)]

pub mod certificate;
pub mod exam;
pub mod lab;
pub mod time;

pub use certificate::{
    certificate_display_id_from_bytes, certificate_public_id_from_bytes, expires_at,
    is_badge_valid, is_valid_display_id, is_valid_public_id, verification_state,
    verification_state_for_holder, verification_state_with_expiry, CertificateIdentity,
    CertificateIdentityError, CertificateStatus, VerificationState, CERTIFICATE_VALIDITY_MONTHS,
    DISPLAY_ID_BYTES, DISPLAY_ID_PREFIX, PUBLIC_ID_BYTES, PUBLIC_ID_LENGTH,
};
pub use exam::{
    grade_exam, grade_exam_with, percent, requires_review, review_modules, trailing_failures,
    trim_attempts, ExamAnswer, ExamAnswers, ExamAttempt, ExamOption, ExamQuestion, ExamResult,
    GradeOptions, QuestionKind, QuestionOutcome, ScoringMode, CONSECUTIVE_FAILS_FOR_REVIEW,
    MAX_STORED_ATTEMPTS, REVIEW_BELOW_PERCENT, SUBMIT_GRACE_MS,
};
pub use lab::{
    compute_lab_result, decimal_equals, parse_decimal, score_lab, score_task, validate_lab,
    ChecklistItem, ChoiceOption, ExpectedLine, Lab, LabError, LabScore, LabTask, LedgerCell,
    MultiOption, OrderItem, Score4, ScoreDetail, Side, TaskAnswer, TaskScore,
};
pub use time::{days_in_month, Civil, UtcMillis, MILLIS_PER_DAY, MILLIS_PER_SECOND};

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn an_exam_attempt_earns_a_certificate_that_expires_in_a_year() {
        let bank = vec![
            ExamQuestion::new(
                "q1",
                "m1",
                QuestionKind::Single,
                vec![ExamOption::new("yes", true), ExamOption::new("no", false)],
            ),
            ExamQuestion::new(
                "q2",
                "m1",
                QuestionKind::Single,
                vec![ExamOption::new("yes", true), ExamOption::new("no", false)],
            )
            .critical(),
        ];
        let answers = ExamAnswers::from([
            ("q1".to_owned(), ExamAnswer::Choice("yes".to_owned())),
            ("q2".to_owned(), ExamAnswer::Choice("yes".to_owned())),
        ]);
        let result = grade_exam(&answers, &bank, 70);
        assert!(result.passed);
        assert_eq!(result.score_percent, 100);

        let earned_at = UtcMillis::parse_iso("2026-11-28T09:00:00Z").expect("timestamp");
        let identity = CertificateIdentity::from_bytes(&[7_u8; 24], &[0x12, 0x34, 0x56, 0x78]);
        assert!(identity.validate().is_ok());
        assert_eq!(identity.display_id, "PG-AC-12345678");
        assert_eq!(
            verification_state(earned_at, earned_at, CertificateStatus::Active),
            VerificationState::Valid
        );
        let after_a_year = UtcMillis::parse_iso("2027-11-28T09:00:00Z").expect("timestamp");
        assert_eq!(
            verification_state(after_a_year, earned_at, CertificateStatus::Active),
            VerificationState::Expired
        );
        assert_eq!(
            verification_state(after_a_year, earned_at, CertificateStatus::Revoked),
            VerificationState::Revoked
        );
    }

    #[test]
    fn a_lab_scores_with_the_lab_engine() {
        let lab = Lab {
            id: "lab".to_owned(),
            pass_percent: 80,
            tasks: vec![LabTask::choice(
                "t1",
                10,
                vec![ChoiceOption {
                    id: "a".to_owned(),
                    label: String::new(),
                    correct: true,
                    critical: false,
                    feedback: String::new(),
                }],
            )],
        };
        let answers = BTreeMap::from([("t1".to_owned(), TaskAnswer::choice("a"))]);
        let score = score_lab(&lab, &answers, &std::collections::BTreeSet::new());
        assert_eq!(score.score, 100);
        assert!(score.passed);
    }
}
