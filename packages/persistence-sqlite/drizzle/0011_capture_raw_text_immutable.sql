-- Custom SQL migration: the raw `+` original is immutable as a database fact (ARCHITECTURE §34, ADR-0007).
CREATE TRIGGER `captures_raw_text_immutable` BEFORE UPDATE OF `raw_text` ON `captures`
WHEN NEW.`raw_text` IS NOT OLD.`raw_text`
BEGIN
  SELECT RAISE(ABORT, 'captures.raw_text is immutable');
END;
