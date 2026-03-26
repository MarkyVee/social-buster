-- ============================================================
-- Performance indexes for scalability to 5,000+ users
-- Run in Supabase SQL Editor
-- Date: 2026-03-25
-- Related: ISSUE-008 (publishing cycle full table scan)
-- ============================================================

-- 1. Composite index on posts(status, scheduled_at)
--    The publish worker runs every 60 seconds and queries:
--      SELECT * FROM posts WHERE status = 'scheduled' AND scheduled_at <= NOW()
--    Without this index, it scans the entire posts table (~50K rows at 5K users).
--    Partial index only covers statuses the publisher cares about.
CREATE INDEX IF NOT EXISTS idx_posts_scheduled_publishing
  ON posts(status, scheduled_at)
  WHERE status IN ('scheduled', 'publishing', 'approved');

-- 2. Index on posts(user_id, status) for the queue page
--    Every user loads their publishing queue filtered by status.
CREATE INDEX IF NOT EXISTS idx_posts_user_status
  ON posts(user_id, status);

-- 3. Index on dm_conversations(user_id, status) for DM dashboard
--    Needed for the upcoming DM dashboard feature (FEAT-013)
CREATE INDEX IF NOT EXISTS idx_dm_conversations_user_status
  ON dm_conversations(user_id, status);

-- 4. Index on comments(post_id, ingested_at) for comment lookups
--    commentAgent queries comments per post frequently
CREATE INDEX IF NOT EXISTS idx_comments_post_ingested
  ON comments(post_id, ingested_at DESC);
