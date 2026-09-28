-- Custom SQL migration: the single calendar snapshot row (ARCHITECTURE §32), disconnected until the user authorizes Google Calendar.
INSERT INTO `calendar_snapshot` (`id`, `connected`, `synced_at`, `source`, `time_zone`, `events`, `last_error`) VALUES (1, 0, NULL, NULL, NULL, '[]', NULL);
