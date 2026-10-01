-- Custom SQL migration: distinguishes a Memory's Stage-6 Capture association (`source_capture_id`,
-- settable by an AI-supplied argument from any session) from verified Capture provenance trusted by
-- Stage 7 Pattern independence (`review-evidence.ts`) — only true when the link came from the trusted
-- Capture-processing job context (`ctx.captureId`), never an untethered/interactive session's say-so
-- (M-A, ADR-0008). Existing rows predate this column, and inside the shipped desktop app the only
-- code path that ever set `source_capture_id` was the trusted Capture-processing job (the AI-supplied
-- argument was always overridden by ctx.captureId when both were present, application.ts) — a
-- developer's own interactive MCP session against the same real database file (the repo's `.mcp.json`,
-- or a manually configured Claude Desktop chat per ADR-0004) could in principle have set an unverified
-- one, but is not part of the shipped product's own behavior. Backfilled to verified rather than
-- defaulted to unverified, which would silently drop real H2/H-A provenance the moment this migration
-- runs against the owner's own database.
ALTER TABLE `memories` ADD `source_capture_verified` integer DEFAULT false NOT NULL;
UPDATE `memories` SET `source_capture_verified` = 1 WHERE `source_capture_id` IS NOT NULL;
