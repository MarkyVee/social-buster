-- migration_fix_platform_page_id_backfill.sql
-- Fixes ISSUE-023: bad backfill stamped wrong platform_page_id on existing posts.
--
-- Facebook platform_post_id format: {page_id}_{post_id}
-- We can derive the correct platform_page_id by splitting on '_' and taking the first part.
--
-- This only updates rows where:
--   1. platform is 'facebook' (Instagram uses a different ID format)
--   2. platform_post_id contains '_' (the Facebook compound format)
--   3. platform_page_id is either NULL or doesn't match the derived page_id
--      (catches both missing and incorrectly backfilled values)

-- Preview what will be updated (run this SELECT first to verify):
-- SELECT id, platform, platform_post_id, platform_page_id,
--        split_part(platform_post_id, '_', 1) AS derived_page_id
-- FROM posts
-- WHERE platform = 'facebook'
--   AND platform_post_id LIKE '%_%'
--   AND (platform_page_id IS NULL
--        OR platform_page_id != split_part(platform_post_id, '_', 1));

-- Fix Facebook posts
UPDATE posts
SET platform_page_id = split_part(platform_post_id, '_', 1)
WHERE platform = 'facebook'
  AND platform_post_id LIKE '%_%'
  AND (platform_page_id IS NULL
       OR platform_page_id != split_part(platform_post_id, '_', 1));

-- Also fix dm_conversations.page_id where it's NULL but we can derive it
-- from the linked post's platform_post_id
UPDATE dm_conversations
SET page_id = split_part(p.platform_post_id, '_', 1)
FROM dm_automations da
JOIN posts p ON p.id = da.post_id
WHERE dm_conversations.automation_id = da.id
  AND p.platform = 'facebook'
  AND p.platform_post_id LIKE '%_%'
  AND dm_conversations.page_id IS NULL;

-- Clean up stale failed DM conversations so the dedup guard doesn't block retries.
-- These are conversations where the DM was never delivered due to ISSUE-023
-- (wrong token/page mismatch). Deleting them allows the system to retry
-- when a new comment comes in from the same person.
DELETE FROM dm_conversations
WHERE status = 'failed';

-- Also delete conversations stuck in 'active' for >24 hours with no reply.
-- These are likely from the broken period — the 24hr messaging window has expired.
DELETE FROM dm_conversations
WHERE status = 'active'
  AND last_message_at < NOW() - INTERVAL '24 hours';
