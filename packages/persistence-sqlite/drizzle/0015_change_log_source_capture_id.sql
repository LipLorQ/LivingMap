-- Custom SQL migration: lets a change_log entry written under a Capture's AI job (ctx.captureId) link
-- back to that Capture, the same provenance H2 already gives Memory.sourceCaptureId — closes the
-- Capture -> plan.reorder gap (mcp-ai's other SAFE WRITE besides memory.save/proposal.create). NULL for
-- existing rows and any entry not produced from a Capture; never a fabricated guess.
ALTER TABLE `change_log` ADD `source_capture_id` text;
