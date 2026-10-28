-- The four built-in portal guides.
--
-- `users.academy_progress_json` stores the Employee Academy progress (completed
-- module ids, quiz scores, sandbox labs and role badges).
ALTER TABLE `users` ADD COLUMN `academy_progress_json` JSON NULL;

-- `rails.help_guide_json` stores the structured bilingual checkout help of a
-- rail (steps, prerequisites, troubleshooting, FAQs) rendered by the checkout
-- help center.
ALTER TABLE `rails` ADD COLUMN `help_guide_json` JSON NULL;

-- Keep the schema version in sync with `REQUIRED_SCHEMA_VERSION`.
INSERT INTO `schema_versions` (`id`, `version`) VALUES (1, 6)
ON DUPLICATE KEY UPDATE `version` = VALUES(`version`);
