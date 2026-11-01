-- Merchant 360 subresource indexes.

ALTER TABLE `payment_attempts`
  ADD INDEX `payment_attempts_merchant_id_status_created_at_idx` (`merchant_id`, `status`, `created_at`);

ALTER TABLE `notifications`
  ADD INDEX `notifications_recipient_merchant_id_created_at_idx` (`recipient_merchant_id`, `created_at`);

ALTER TABLE `audit_log`
  ADD INDEX `audit_log_entity_type_entity_id_created_at_idx` (`entity_type`, `entity_id`, `created_at`);

ALTER TABLE `disputes`
  ADD INDEX `disputes_status_evidence_due_at_idx` (`status`, `evidence_due_at`);
