-- CreateTable
CREATE TABLE `SchemaVersion` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `version` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


INSERT INTO SchemaVersion (id, version)
VALUES (1, 1)
ON DUPLICATE KEY UPDATE version = VALUES(version);
