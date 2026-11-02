-- Persisted gateway status-inquiry schedules requested by operators.
CREATE TABLE `gateway_inquiry_schedules` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `attempt_id` VARCHAR(191) NOT NULL,
    `operator_case_id` VARCHAR(191) NULL,
    `source` ENUM('OPERATOR_CASE', 'AUTOMATIC') NOT NULL DEFAULT 'OPERATOR_CASE',
    `status` ENUM('SCHEDULED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'SCHEDULED',
    `scheduled_by_user_id` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `checklist` JSON NULL,
    `previous_next_check_at` DATETIME(3) NULL,
    `next_run_at` DATETIME(3) NOT NULL,
    `last_run_at` DATETIME(3) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `last_result` TEXT NULL,
    `last_error` TEXT NULL,
    `completed_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by_user_id` VARCHAR(191) NULL,
    `cancel_reason` TEXT NULL,

    INDEX `gateway_inquiry_schedules_status_next_run_at_idx`(`status`, `next_run_at`),
    INDEX `gateway_inquiry_schedules_attempt_id_status_idx`(`attempt_id`, `status`),
    INDEX `gateway_inquiry_schedules_operator_case_id_idx`(`operator_case_id`),
    INDEX `gateway_inquiry_schedules_source_status_idx`(`source`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `gateway_inquiry_schedules`
    ADD CONSTRAINT `gateway_inquiry_schedules_attempt_id_fkey`
    FOREIGN KEY (`attempt_id`) REFERENCES `payment_attempts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `gateway_inquiry_schedules`
    ADD CONSTRAINT `gateway_inquiry_schedules_operator_case_id_fkey`
    FOREIGN KEY (`operator_case_id`) REFERENCES `operator_cases`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `gateway_inquiry_schedules`
    ADD CONSTRAINT `gateway_inquiry_schedules_scheduled_by_user_id_fkey`
    FOREIGN KEY (`scheduled_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `gateway_inquiry_schedules`
    ADD CONSTRAINT `gateway_inquiry_schedules_cancelled_by_user_id_fkey`
    FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
