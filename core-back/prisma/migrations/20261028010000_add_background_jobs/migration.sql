-- The durable job queue of `core-back`.
--
-- The heavy request-path operations (the statement reconciliation and the
-- dispute / adjustment execution) are drained by the stateless
-- `BackgroundJobWorker`, which claims the due jobs with
-- `SELECT ... FOR UPDATE SKIP LOCKED`. `available_at` is the durable timer
-- of the retry backoff, `locked_at` is the lease of the node that owns the
-- job and `state` is the lifecycle of the job.
CREATE TABLE IF NOT EXISTS `background_jobs` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `job_type` ENUM('RECONCILIATION_RUN', 'ADJUSTMENT_EXECUTION') NOT NULL,
    `reference_type` VARCHAR(191) NOT NULL,
    `reference_id` VARCHAR(191) NOT NULL,
    `payload_json` JSON NOT NULL,
    `state` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `attempts` INT NOT NULL DEFAULT 0,
    `max_attempts` INT NOT NULL DEFAULT 5,
    `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locked_at` DATETIME(3) NULL,
    `last_error` TEXT NULL,
    `completed_at` DATETIME(3) NULL,

    INDEX `background_jobs_state_available_at_idx`(`state`, `available_at`),
    INDEX `background_jobs_state_locked_at_idx`(`state`, `locked_at`),
    INDEX `background_jobs_reference_type_reference_id_idx`(`reference_type`, `reference_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The statement reconciliation is a background job, so the uploaded file has
-- to survive the request that stored it: the bytes are kept next to the run
-- record and the ingestion marks the run with `ingested_at`, which is the
-- idempotency marker of a retried job.
ALTER TABLE `reconciliation_runs` ADD COLUMN `file_name` TEXT NULL;
ALTER TABLE `reconciliation_runs` ADD COLUMN `file_content` LONGBLOB NULL;
ALTER TABLE `reconciliation_runs` ADD COLUMN `ingested_at` DATETIME(3) NULL;

CREATE INDEX `reconciliation_runs_ingestedAt_idx` ON `reconciliation_runs`(`ingested_at`);

-- Schema version support (single-row table managed outside the Prisma datamodel).
CREATE TABLE IF NOT EXISTS `schema_versions` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `version` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `schema_versions_pkey` PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The version is never lowered: the migrations are applied in order, and the
-- newest one owns the version of the schema.
INSERT INTO `schema_versions` (`id`, `version`) VALUES (1, 4)
ON DUPLICATE KEY UPDATE `version` = GREATEST(`version`, VALUES(`version`));
