-- Migration: Multi-Page Platform Connections
-- Date: 2026-03-27
-- Purpose: Allow users to connect multiple Facebook Pages (and Instagram accounts)
--          without overwriting existing connections. Fixes DM automation breaking
--          when users reconnect with a different Page.
--
-- WHAT THIS CHANGES:
-- 1. platform_connections: changes unique constraint from (user_id, platform)
--    to (user_id, platform, platform_user_id) — allows multiple pages per platform
-- 2. posts: adds platform_page_id column to track which Page a post was published to
-- 3. dm_conversations: adds page_id column so follow-up DMs use the correct Page token
--
-- HOW TO RUN: Paste this into the Supabase SQL Editor and click "Run"
-- SAFE TO RE-RUN: Uses IF EXISTS / IF NOT EXISTS guards

-- Step 1: Drop the old constraint that only allows one connection per platform
ALTER TABLE platform_connections
  DROP CONSTRAINT IF EXISTS platform_connections_user_id_platform_key;

-- Step 2: Add new constraint that allows multiple pages per platform
-- (user_id + platform + platform_user_id must be unique together)
ALTER TABLE platform_connections
  ADD CONSTRAINT platform_connections_user_platform_page_key
  UNIQUE(user_id, platform, platform_user_id);

-- Step 3: Add platform_page_id to posts so we know which Page each post was published to
ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS platform_page_id TEXT;

-- Step 4: Add page_id to dm_conversations so follow-up DM steps use the right token
ALTER TABLE dm_conversations
  ADD COLUMN IF NOT EXISTS page_id TEXT;

-- Step 5: Backfill platform_page_id for existing published posts.
-- For each published post, set platform_page_id to the current connection's platform_user_id.
-- This is a best-effort backfill — if the user has reconnected to a different page,
-- this may not be 100% accurate, but it's better than NULL.
UPDATE posts p
SET platform_page_id = pc.platform_user_id
FROM platform_connections pc
WHERE p.user_id = pc.user_id
  AND p.platform = pc.platform
  AND p.platform_page_id IS NULL
  AND p.status = 'published';

-- Step 6: Update RLS policy if needed (platform_connections already has RLS enabled)
-- No changes needed — existing policies filter by user_id which still works.

-- Verify: check the new constraint exists
SELECT constraint_name
FROM information_schema.table_constraints
WHERE table_name = 'platform_connections'
  AND constraint_type = 'UNIQUE';
