# Academy content questions

No open Academy content questions after the 2026-11-25 accuracy pass. The answer-key and
behaviour corrections are listed in `academy_content_fixes.md`.

The remaining gaps are product decisions, not content questions:

- Cash-out second Finance approval.
- Commission-profile, platform-setting, credential-set and velocity-rule maker-checker.
- Automatic payout stop on ledger drift.
- Daily or confirmation-time AML monitoring, and rail-level screening policy.
- Canary list traffic splitting (the percentage is implemented), OIDC, step-up authentication,
  generic approval withdraw, merchant re-application linkage and KYB extension by two people.
- Core webhook replay and signature-spike alerting.

The Academy describes the current code for each: one `cashout:review` actor handles a cash-out;
credential updates are direct, velocity-rule creation or tightening is direct (deactivation is an
approval), the invariant worker opens a P1 case but does not stop payouts, and the
start-of-payment guard evaluates the AML rules with a bounded 24-hour database window.
