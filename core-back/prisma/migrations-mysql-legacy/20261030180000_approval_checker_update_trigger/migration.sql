-- The master test plan requires the Maker != Checker invariant on both INSERT
-- and UPDATE. MariaDB forbids a CHECK constraint on columns that participate
-- in a foreign key, so the UPDATE half is enforced by a second trigger.
DROP TRIGGER IF EXISTS `approval_requests_checker_not_maker_update`;
CREATE TRIGGER `approval_requests_checker_not_maker_update` BEFORE UPDATE ON `approval_requests`
FOR EACH ROW
BEGIN
    IF NEW.`checker_user_id` IS NOT NULL AND NEW.`checker_user_id` = NEW.`maker_user_id` THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checker_user_id must differ from maker_user_id';
    END IF;
END;
