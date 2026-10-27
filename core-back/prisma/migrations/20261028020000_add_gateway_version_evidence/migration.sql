-- The go-live evidence of a gateway version.
--
-- Design v5 §14: "No `gateway_versions` row can transition to `LIVE` without
-- passing all 12 Go-Live Gates." The sandbox suite runner collects the
-- evidence (the fifteen sandbox scenarios, the amount / reference / signature
-- contract tests, the canary traffic plan, the route alerts and the runbooks)
-- and the activation reads it back, so the gate decision is made on recorded
-- facts instead of hard-coded constants.
CREATE TABLE IF NOT EXISTS `gateway_version_evidence` (
    `id` VARCHAR(191) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `gateway_version_id` VARCHAR(191) NOT NULL,
    `evidence_json` JSON NOT NULL,
    `ran_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `gateway_version_evidence_gateway_version_id_key`(`gateway_version_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

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
INSERT INTO `schema_versions` (`id`, `version`) VALUES (1, 5)
ON DUPLICATE KEY UPDATE `version` = GREATEST(`version`, VALUES(`version`));
