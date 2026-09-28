-- Custom SQL migration: the single settings row; the daily work target starts at 6 hours (DEVELOPMENT_PLAN §4.4) and is user-changeable.
INSERT INTO `settings` (`id`, `daily_work_target_minutes`) VALUES (1, 360);
