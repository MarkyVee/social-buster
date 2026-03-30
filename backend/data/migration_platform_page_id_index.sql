-- migration_platform_page_id_index.sql
-- Adds index on posts.platform_page_id for faster lookups in commentAgent and dmWorker.
-- These agents look up posts by platform_page_id to find the correct token for DM sending.
--
-- Run this in Supabase SQL Editor.

CREATE INDEX IF NOT EXISTS idx_posts_platform_page_id
  ON posts (platform_page_id)
  WHERE platform_page_id IS NOT NULL;
