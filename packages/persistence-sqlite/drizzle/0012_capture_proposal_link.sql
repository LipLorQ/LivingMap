ALTER TABLE `captures` ADD `proposal_id` text;--> statement-breakpoint
-- Custom backfill for Captures processed before the link existed (Stage 6, Gate B). A recorded result names
-- its Proposal; a failed attempt is linked to the mcp-ai Proposal created between that attempt's claim and
-- its finish (processing is single-flight, one desktop per database).
-- ponytail: an mcp-ai Proposal from another MCP host inside that window would be misattributed; only
-- pre-link history is affected, every newer run is linked explicitly through its context.
UPDATE `captures` SET `proposal_id` = json_extract(`result`, '$.proposalId')
WHERE `proposal_id` IS NULL AND json_extract(`result`, '$.proposalId') IS NOT NULL;
--> statement-breakpoint
UPDATE `captures` SET `proposal_id` = (
  SELECT p.`entity_id` FROM `change_log` p
  JOIN `change_log` c ON c.`entity_id` = `captures`.`id` AND c.`command_type` = 'capture.claim'
  WHERE p.`command_type` = 'proposal.create' AND p.`actor` = 'mcp-ai' AND p.`timestamp` >= c.`timestamp`
    AND p.`timestamp` < (
      SELECT min(f.`timestamp`) FROM `change_log` f
      WHERE f.`entity_id` = `captures`.`id` AND f.`command_type` IN ('capture.failed', 'capture.processed')
        AND f.`timestamp` > c.`timestamp`
    )
  ORDER BY p.`timestamp` LIMIT 1
)
WHERE `proposal_id` IS NULL AND `state` = 'failed';
