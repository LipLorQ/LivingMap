-- Custom SQL migration: the single global revision row (ARCHITECTURE §14).
INSERT INTO `meta` (`id`, `state_revision`) VALUES (1, 0);
