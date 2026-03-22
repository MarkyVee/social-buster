-- ================================================================
-- Migration: Enriched Video Segment Tags
-- Date: 2026-03-21
--
-- Adds new columns to video_segments for the enriched vision tagging
-- pipeline. These columns are populated by the AI vision tagger when
-- it analyzes video thumbnails. All are optional — existing segments
-- continue to work without them.
--
-- Run this in Supabase SQL Editor, then redeploy the backend.
-- ================================================================

-- hook_potential: Does this frame grab attention in the first 2 seconds?
-- Values: 'high', 'medium', 'low'
ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS hook_potential TEXT;

-- audience_fit: Who would this content resonate with?
-- Array of audience types like ['entrepreneurs', 'parents', 'fitness enthusiasts']
ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS audience_fit TEXT[] DEFAULT '{}';

-- use_cases: What types of social media posts could this clip support?
-- Array like ['product demo', 'behind-the-scenes', 'tutorial']
ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS use_cases TEXT[] DEFAULT '{}';

-- text_overlay_opportunity: Is there clean visual space for text overlay?
-- true = clear area suitable for text, false = frame too busy
ALTER TABLE video_segments ADD COLUMN IF NOT EXISTS text_overlay_opportunity BOOLEAN;

-- Index on hook_potential for quick "show me high-hook clips" queries
CREATE INDEX IF NOT EXISTS idx_video_segments_hook_potential ON video_segments(hook_potential);

-- GIN index on audience_fit for array containment queries (@>)
CREATE INDEX IF NOT EXISTS idx_video_segments_audience_fit ON video_segments USING GIN(audience_fit);

-- GIN index on use_cases for array containment queries (@>)
CREATE INDEX IF NOT EXISTS idx_video_segments_use_cases ON video_segments USING GIN(use_cases);
