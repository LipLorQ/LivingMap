-- Custom SQL migration: existing rows predate canonical fact identity (Stage 7 H2 fix) and get an
-- empty set — conservative (they simply stop contributing to independence checks until reprocessed),
-- never a fabricated provenance guess.
ALTER TABLE `review_findings` ADD `evidence_fact_ids` text DEFAULT '[]' NOT NULL;