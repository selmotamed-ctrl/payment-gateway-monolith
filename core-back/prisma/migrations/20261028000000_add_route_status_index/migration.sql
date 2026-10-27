-- The daily volume aggregate of the rail resolution groups the succeeded
-- attempts by route (`SUM(total_charged_amount)` per `route_id` over a
-- business day). The aggregate runs on every checkout, so the pair it
-- filters and groups on is indexed.
CREATE INDEX `payment_attempts_route_id_status_idx` ON `payment_attempts`(`route_id`, `status`);

-- Schema version support (single-row table managed outside the Prisma datamodel).
CREATE TABLE IF NOT EXISTS `schema_versions` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `version` INTEGER NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    CONSTRAINT `schema_versions_pkey` PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `schema_versions` (`id`, `version`) VALUES (1, 3)
ON DUPLICATE KEY UPDATE `version` = VALUES(`version`);
