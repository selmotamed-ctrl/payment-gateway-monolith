-- The manual inquiry schedule owns its own polling window.
ALTER TABLE `gateway_inquiry_schedules`
    ADD COLUMN `window_started_at` DATETIME(3) NULL;
