-- KYB review queue, duplicate justification, expiry lifecycle and active-merchant revalidation.

ALTER TABLE `kyb_documents`
  ADD COLUMN `duplicate_justification` TEXT NULL,
  ADD COLUMN `status_changed_at` DATETIME(3) NULL,
  ADD COLUMN `expiry_notice_30_sent_at` DATETIME(3) NULL,
  ADD COLUMN `expiry_notice_7_sent_at` DATETIME(3) NULL,
  ADD COLUMN `expired_at` DATETIME(3) NULL,
  ADD INDEX `kyb_documents_join_request_id_idx` (`join_request_id`),
  ADD INDEX `kyb_documents_status_av_status_created_at_idx` (`status`, `av_status`, `created_at`),
  ADD INDEX `kyb_documents_reviewed_by_idx` (`reviewed_by`);

ALTER TABLE `merchants`
  ADD COLUMN `next_kyb_review_at` DATETIME(3) NULL,
  ADD INDEX `merchants_next_kyb_review_at_idx` (`next_kyb_review_at`);

CREATE TABLE `kyb_revalidation_requests` (
  `id` VARCHAR(191) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  `merchant_id` VARCHAR(191) NOT NULL,
  `join_request_id` VARCHAR(191) NULL,
  `document_id` VARCHAR(191) NULL,
  `doc_type` ENUM('COMMERCIAL_REGISTRY', 'TAX_CERTIFICATE', 'ARTICLES_OF_ASSOCIATION', 'OWNER_ID', 'SIGNATORY_ID', 'PROOF_OF_ADDRESS', 'BANK_LETTER', 'SECTOR_LICENSE', 'OTHER') NOT NULL,
  `reason_code` TEXT NOT NULL,
  `message` TEXT NOT NULL,
  `status` ENUM('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'OPEN',
  `requested_by` VARCHAR(191) NOT NULL,
  `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `due_at` DATETIME(3) NULL,
  `fulfilled_at` DATETIME(3) NULL,
  `fulfilled_document_id` VARCHAR(191) NULL,
  `resolution_notes` TEXT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `kyb_revalidation_requests_fulfilled_document_id_key` (`fulfilled_document_id`),
  INDEX `kyb_revalidation_requests_merchant_id_status_idx` (`merchant_id`, `status`),
  INDEX `kyb_revalidation_requests_status_due_at_idx` (`status`, `due_at`),
  INDEX `kyb_revalidation_requests_document_id_idx` (`document_id`),
  INDEX `kyb_revalidation_requests_join_request_id_idx` (`join_request_id`),
  INDEX `kyb_revalidation_requests_requested_by_idx` (`requested_by`),
  CONSTRAINT `kyb_revalidation_requests_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `kyb_revalidation_requests_join_request_id_fkey` FOREIGN KEY (`join_request_id`) REFERENCES `join_requests`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `kyb_revalidation_requests_document_id_fkey` FOREIGN KEY (`document_id`) REFERENCES `kyb_documents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `kyb_revalidation_requests_fulfilled_document_id_fkey` FOREIGN KEY (`fulfilled_document_id`) REFERENCES `kyb_documents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `kyb_revalidation_requests_requested_by_fkey` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
