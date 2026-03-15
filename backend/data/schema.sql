-- ============================================================
-- Social Buster - PostgreSQL Schema
-- Run this in your Supabase SQL editor to set up the database.
-- ============================================================
-- IMPORTANT: Run this entire file in order, top to bottom.
-- Safe to re-run — all DROP IF EXISTS guards are in place.
-- ============================================================


-- ============================================================
-- EXTENSION: Enable UUID generation
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================
-- TABLE: user_profiles
-- One row per user. Linked to Supabase Auth via user_id.
-- Stores brand settings and onboarding state.
-- ============================================================
CREATE TABLE IF NOT EXISTS user_profiles (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  brand_name      TEXT,
  industry        TEXT,
  target_audience TEXT,
  brand_voice     TEXT,            -- e.g. 'Professional', 'Friendly', 'Bold'
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast user lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);

-- RLS: Enable Row Level Security
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Drop existing policies before recreating (makes this file safely re-runnable)
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;
DROP POLICY IF EXISTS "Service role full access to profiles" ON user_profiles;

-- Policy: Users can only read and update their own profile
CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = user_id);

-- Service role can do everything (for server-side agent work)
CREATE POLICY "Service role full access to profiles"
  ON user_profiles FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: subscriptions
-- One row per user. Tracks Stripe subscription status.
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id                 UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id      TEXT UNIQUE,
  stripe_subscription_id  TEXT UNIQUE,
  plan                    TEXT NOT NULL DEFAULT 'free',  -- free | starter | professional | enterprise
  status                  TEXT NOT NULL DEFAULT 'active', -- active | trialing | past_due | cancelled
  current_period_end      TIMESTAMPTZ,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer ON subscriptions(stripe_customer_id);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own subscription" ON subscriptions;
DROP POLICY IF EXISTS "Service role full access to subscriptions" ON subscriptions;

CREATE POLICY "Users can view own subscription"
  ON subscriptions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to subscriptions"
  ON subscriptions FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: briefs
-- Each row is a content brief submitted by a user.
-- The AI generates posts based on brief data.
-- ============================================================
CREATE TABLE IF NOT EXISTS briefs (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_type       TEXT NOT NULL, -- Educational | Product Launch | Behind the Scenes | etc.
  objective       TEXT NOT NULL, -- Engagement | Comments | Clicks | Conversions | etc.
  tone            TEXT NOT NULL, -- Professional | Friendly | Bold | Emotional | etc.
  target_audience TEXT NOT NULL,
  platforms       TEXT[] NOT NULL, -- Array of platforms: ['instagram', 'tiktok', ...]
  notes           TEXT,           -- Optional freeform context
  status          TEXT DEFAULT 'pending', -- pending | generating | complete | error
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_briefs_user_id ON briefs(user_id);

ALTER TABLE briefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own briefs" ON briefs;
DROP POLICY IF EXISTS "Service role full access to briefs" ON briefs;

CREATE POLICY "Users can manage own briefs"
  ON briefs FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to briefs"
  ON briefs FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: posts
-- Each row is one generated post option (3 per platform per brief).
-- ============================================================
CREATE TABLE IF NOT EXISTS posts (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brief_id        UUID REFERENCES briefs(id) ON DELETE SET NULL,
  platform        TEXT NOT NULL,  -- instagram | facebook | tiktok | linkedin | x | threads | youtube
  option_number   INT DEFAULT 1,  -- 1, 2, or 3 (three options generated per platform)
  hook            TEXT,
  caption         TEXT,
  hashtags        TEXT[],
  cta             TEXT,           -- Call to action
  media_id        UUID,           -- Reference to the recommended media item
  status          TEXT DEFAULT 'draft', -- draft | approved | scheduled | publishing | published | failed
  scheduled_at    TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  platform_post_id TEXT,          -- The post ID returned by the platform API after publishing
  error_message   TEXT,           -- Populated if publishing failed
  trim_start_seconds INT DEFAULT 0, -- Where to start the trim (0 = from beginning). Set by user via UI.
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled_at ON posts(scheduled_at);

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own posts" ON posts;
DROP POLICY IF EXISTS "Service role full access to posts" ON posts;

CREATE POLICY "Users can manage own posts"
  ON posts FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to posts"
  ON posts FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: media_items
-- Metadata catalog of media from users' cloud storage.
-- The actual files are NEVER stored here — only metadata.
-- ============================================================
CREATE TABLE IF NOT EXISTS media_items (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cloud_provider    TEXT NOT NULL, -- google_drive | dropbox | box
  cloud_file_id     TEXT NOT NULL, -- The file's ID in the cloud provider
  cloud_url         TEXT,          -- Shareable URL to the file
  filename          TEXT NOT NULL,
  file_type         TEXT,          -- video | image
  duration_seconds  INT,           -- For videos only
  resolution        TEXT,          -- e.g. '1920x1080'
  themes            TEXT[],        -- AI-assigned theme tags
  emotional_tone    TEXT,          -- e.g. 'inspiring', 'educational', 'humorous'
  pacing            TEXT,          -- e.g. 'fast', 'slow', 'moderate'
  platform_fit      TEXT[],        -- Platforms this media is best suited for
  catalogued_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, cloud_provider, cloud_file_id)
);

CREATE INDEX IF NOT EXISTS idx_media_items_user_id ON media_items(user_id);

ALTER TABLE media_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own media" ON media_items;
DROP POLICY IF EXISTS "Service role full access to media" ON media_items;

CREATE POLICY "Users can manage own media"
  ON media_items FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to media"
  ON media_items FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: platform_connections
-- OAuth tokens for each social media platform per user.
-- Tokens are encrypted before storage (TOKEN_ENCRYPTION_KEY in .env).
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_connections (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,   -- instagram | facebook | tiktok | linkedin | x | threads | youtube
  access_token    TEXT,            -- Encrypted OAuth access token
  refresh_token   TEXT,            -- Encrypted OAuth refresh token
  token_expires_at TIMESTAMPTZ,
  platform_user_id TEXT,           -- The user's ID on that platform
  platform_username TEXT,          -- The user's handle on that platform
  connected_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_platform_connections_user_id ON platform_connections(user_id);

ALTER TABLE platform_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own platform connections" ON platform_connections;
DROP POLICY IF EXISTS "Service role full access to platform connections" ON platform_connections;

CREATE POLICY "Users can manage own platform connections"
  ON platform_connections FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to platform connections"
  ON platform_connections FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: post_metrics
-- Performance data for published posts.
-- Populated by the performanceAgent.
-- ============================================================
CREATE TABLE IF NOT EXISTS post_metrics (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id         UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  likes           INT DEFAULT 0,
  comments        INT DEFAULT 0,
  shares          INT DEFAULT 0,
  saves           INT DEFAULT 0,
  reach           INT DEFAULT 0,
  impressions     INT DEFAULT 0,
  clicks          INT DEFAULT 0,
  video_views     INT DEFAULT 0,
  recorded_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_post_metrics_user_id ON post_metrics(user_id);
CREATE INDEX IF NOT EXISTS idx_post_metrics_post_id ON post_metrics(post_id);

ALTER TABLE post_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own metrics" ON post_metrics;
DROP POLICY IF EXISTS "Service role full access to metrics" ON post_metrics;

CREATE POLICY "Users can view own metrics"
  ON post_metrics FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to metrics"
  ON post_metrics FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: comments
-- Ingested comments on published posts.
-- Populated by the commentAgent.
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id         UUID REFERENCES posts(id) ON DELETE SET NULL,
  platform        TEXT NOT NULL,
  platform_comment_id TEXT UNIQUE, -- Prevent duplicate ingestion
  comment_text    TEXT,
  author_handle   TEXT,
  sentiment       TEXT,            -- positive | neutral | negative
  trigger_matched BOOLEAN DEFAULT FALSE, -- Did this match a DM trigger phrase?
  dm_sent         BOOLEAN DEFAULT FALSE,
  ingested_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own comments" ON comments;
DROP POLICY IF EXISTS "Service role full access to comments" ON comments;

CREATE POLICY "Users can view own comments"
  ON comments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to comments"
  ON comments FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: trigger_phrases
-- User-defined phrases that trigger automated DM workflows.
-- ============================================================
CREATE TABLE IF NOT EXISTS trigger_phrases (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  phrase          TEXT NOT NULL,
  platform        TEXT,            -- NULL means all platforms
  dm_message      TEXT,            -- The DM to send when triggered
  form_url        TEXT,            -- The user's external form link to include in DM
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trigger_phrases_user_id ON trigger_phrases(user_id);

ALTER TABLE trigger_phrases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own trigger phrases" ON trigger_phrases;
DROP POLICY IF EXISTS "Service role full access to trigger phrases" ON trigger_phrases;

CREATE POLICY "Users can manage own trigger phrases"
  ON trigger_phrases FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to trigger phrases"
  ON trigger_phrases FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- TABLE: cloud_connections
-- OAuth tokens for user's cloud storage (Google Drive, Dropbox, Box).
-- Tokens are encrypted using AES-256-GCM (tokenEncryption.js service).
-- One row per user per provider.
-- ============================================================
CREATE TABLE IF NOT EXISTS cloud_connections (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,    -- google_drive | dropbox | box
  access_token      TEXT,             -- AES-256-GCM encrypted OAuth access token
  refresh_token     TEXT,             -- AES-256-GCM encrypted OAuth refresh token
  token_expires_at  TIMESTAMPTZ,      -- When the access token expires
  provider_user_id  TEXT,             -- User ID on the cloud provider
  provider_email    TEXT,             -- Which account is connected (for display)
  last_scanned_at   TIMESTAMPTZ,      -- When the media agent last scanned this connection
  connected_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_cloud_connections_user_id ON cloud_connections(user_id);

ALTER TABLE cloud_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own cloud connections" ON cloud_connections;
DROP POLICY IF EXISTS "Service role full access to cloud connections" ON cloud_connections;

-- Users can only see and manage their own cloud connections
CREATE POLICY "Users can manage own cloud connections"
  ON cloud_connections FOR ALL
  USING (auth.uid() = user_id);

-- Service role (used by mediaAgent) can access all connections
CREATE POLICY "Service role full access to cloud connections"
  ON cloud_connections FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- MIGRATIONS — run these if you already have the tables created
-- and just need to add new columns added after the initial setup.
-- Safe to run multiple times (ALTER TABLE ... IF NOT EXISTS).
-- ============================================================

-- Phase 4: Added trim_start_seconds to posts (allows users to set
--          a custom clip start point for videos before publishing)
ALTER TABLE posts ADD COLUMN IF NOT EXISTS trim_start_seconds INT DEFAULT 0;


-- ============================================================
-- Phase 5: Expanded user_profiles for intelligence engine
--
-- These fields feed three systems:
--   1. Cohort matching (industry + business_type + geo_region + target_age_range + platform)
--   2. Research agent (geo-scoped trend queries, audience context)
--   3. Cold-start seeding (reference_accounts bootstrap intelligence before own data exists)
--
-- All columns are nullable — existing users are unaffected.
-- Fill in over time via the expanded Settings form.
-- ============================================================

-- Geographic
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS city          TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS state         TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS geo_region    TEXT;
  -- Derived from state: northeast_us | southeast_us | midwest_us | southwest_us | west_us
  -- Set automatically by the backend when state is saved. Never sent by the client directly.

-- Business context
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS business_type      TEXT;
  -- brick_and_mortar | online_only | hybrid | service_based | creator
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS business_size      TEXT;
  -- solo | small_2_10 | medium_11_50 | large_50_plus
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS years_in_business  INT;
  -- Helps weight own-history signal. New businesses lean more on cohort data.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS primary_goal       TEXT;
  -- grow_audience | generate_leads | drive_sales | build_brand | retain_customers
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS content_frequency  TEXT;
  -- daily | few_per_week | weekly | few_per_month

-- Audience context
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS target_age_range   TEXT;
  -- 18-24 | 25-34 | 35-44 | 45-54 | 55+ | all
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS target_gender      TEXT;
  -- male | female | all
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS audience_location  TEXT;
  -- local | national | international
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS audience_interests TEXT[];
  -- Free tags e.g. ['fitness', 'nutrition', 'weight loss']

-- Intelligence cold start
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS reference_accounts TEXT[];
  -- 2-3 competitor or aspirational social handles. Used to seed intelligence
  -- profile at onboarding before the user has their own post history.
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS primary_competitors TEXT[];
  -- Optional. Used for cohort benchmarking in the intelligence engine.

-- Platform preferences
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS preferred_platforms      TEXT[];
  -- Which platforms the user primarily posts on
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS posting_time_preference  TEXT;
  -- morning | afternoon | evening | night | auto

-- Indexes for cohort matching queries
CREATE INDEX IF NOT EXISTS idx_user_profiles_geo_region    ON user_profiles(geo_region);
CREATE INDEX IF NOT EXISTS idx_user_profiles_business_type ON user_profiles(business_type);
CREATE INDEX IF NOT EXISTS idx_user_profiles_industry      ON user_profiles(industry);

-- Phase 4: Supabase Storage bucket for AI-generated images.
-- Run this in the Supabase SQL editor (separate from the main schema run).
-- Creates the storage bucket and sets it to public so image URLs work without auth.
INSERT INTO storage.buckets (id, name, public)
VALUES ('ai-generated-images', 'ai-generated-images', true)
ON CONFLICT (id) DO NOTHING;

-- Allow anyone to read images from this bucket (needed for public thumbnails)
DROP POLICY IF EXISTS "Public read ai-generated-images" ON storage.objects;
CREATE POLICY "Public read ai-generated-images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'ai-generated-images');

-- Allow the service role (server) to upload images to this bucket
DROP POLICY IF EXISTS "Service role upload ai-generated-images" ON storage.objects;
CREATE POLICY "Service role upload ai-generated-images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'ai-generated-images' AND auth.role() = 'service_role');

-- Allow the service role to delete images (for future cleanup)
DROP POLICY IF EXISTS "Service role delete ai-generated-images" ON storage.objects;
CREATE POLICY "Service role delete ai-generated-images"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'ai-generated-images' AND auth.role() = 'service_role');


-- ============================================================
-- Phase 6: Video segment pre-analysis
--
-- Strategy: analyse videos ONCE in the background when added to
-- the library. Store every detected segment in video_segments.
-- At post time, a fast DB query returns matching clips instantly —
-- no FFmpeg or LLM at edit time.
--
-- analysis_status state machine on media_items:
--   pending → analyzing → ready | too_large | failed
-- ============================================================

-- Add analysis_status to media_items (defaults to 'pending')
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS analysis_status TEXT DEFAULT 'pending';

-- Fast lookup for the background worker (finds all pending videos)
CREATE INDEX IF NOT EXISTS idx_media_items_analysis_status ON media_items(analysis_status);


-- TABLE: video_segments
-- One row per detected scene/segment within a video media item.
-- Populated by videoAnalysisService.js (FFmpeg scene detection + audio energy).
-- Used at post time to surface best-matching clip options instantly.
CREATE TABLE IF NOT EXISTS video_segments (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  media_item_id   UUID NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_seconds   INT NOT NULL,       -- Segment start time in the source video
  end_seconds     INT NOT NULL,       -- Segment end time
  thumbnail_url   TEXT,               -- Supabase Storage URL for the frame thumbnail
  description     TEXT,               -- Brief human-readable description (Phase 2: vision LLM)
  tags            TEXT[],             -- Semantic tags: e.g. ['talking-head', 'product-reveal']
  mood            TEXT,               -- e.g. 'energetic', 'calm', 'emotional'
  energy_level    INT,                -- 1-10 scale derived from FFmpeg audio volumedetect
  pacing          TEXT,               -- 'fast' | 'moderate' | 'slow' (from cut frequency)
  platform_fit    TEXT[],             -- Platforms this segment is well-suited for
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- GIN indexes for array containment queries
-- e.g. WHERE platform_fit @> ARRAY['instagram'] AND tags @> ARRAY['product-reveal']
CREATE INDEX IF NOT EXISTS idx_video_segments_media_item_id ON video_segments(media_item_id);
CREATE INDEX IF NOT EXISTS idx_video_segments_user_id       ON video_segments(user_id);
CREATE INDEX IF NOT EXISTS idx_video_segments_platform_fit  ON video_segments USING GIN(platform_fit);
CREATE INDEX IF NOT EXISTS idx_video_segments_tags          ON video_segments USING GIN(tags);

ALTER TABLE video_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own video segments" ON video_segments;
DROP POLICY IF EXISTS "Service role full access to video segments" ON video_segments;

CREATE POLICY "Users can view own video segments"
  ON video_segments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to video segments"
  ON video_segments FOR ALL
  USING (auth.role() = 'service_role');


-- Supabase Storage bucket for segment thumbnails.
-- Service role uploads frames extracted by FFmpeg; public read so thumbnail URLs work.
INSERT INTO storage.buckets (id, name, public)
VALUES ('video-segments', 'video-segments', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public read video-segments" ON storage.objects;
CREATE POLICY "Public read video-segments"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'video-segments');

DROP POLICY IF EXISTS "Service role upload video-segments" ON storage.objects;
CREATE POLICY "Service role upload video-segments"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'video-segments' AND auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role delete video-segments" ON storage.objects;
CREATE POLICY "Service role delete video-segments"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'video-segments' AND auth.role() = 'service_role');


-- ============================================================
-- PHASE 7: COLLECTIVE INTELLIGENCE SCHEMA
--
-- cohort_performance stores AGGREGATED metrics for groups of
-- users who share the same industry + geo_region + platform +
-- post_type. No user_id column — this is population-level data,
-- not personal data. The performanceAgent writes it; the
-- /intelligence/preflight API reads it to benchmark a user's
-- performance against peers.
--
-- Minimum sample size of 5 is enforced in the API, not the DB,
-- so we can still aggregate early and gate the signal at query time.
--
-- Cohort key format (pipe-separated, case-normalised):
--   industry|business_type|geo_region|platform|post_type
-- e.g. fitness|service_based|southeast_us|instagram|promotional
-- ============================================================

CREATE TABLE IF NOT EXISTS cohort_performance (
  id            UUID DEFAULT uuid_generate_v4() PRIMARY KEY,

  -- The unique group identifier. Upsert target.
  cohort_key    TEXT NOT NULL UNIQUE,

  -- Cohort dimensions (denormalised for easy querying)
  industry      TEXT NOT NULL,
  business_type TEXT,           -- null = any business type in this industry
  geo_region    TEXT,           -- null = national (geo signal not available for these users)
  platform      TEXT NOT NULL,
  post_type     TEXT,           -- null = all post types combined

  -- Rolling 30-day aggregate metrics (recomputed each performance cycle)
  sample_size       INT     DEFAULT 0,   -- number of posts in this window
  avg_likes         NUMERIC DEFAULT 0,
  avg_comments      NUMERIC DEFAULT 0,
  avg_shares        NUMERIC DEFAULT 0,
  avg_saves         NUMERIC DEFAULT 0,
  avg_reach         NUMERIC DEFAULT 0,
  avg_impressions   NUMERIC DEFAULT 0,
  avg_video_views   NUMERIC DEFAULT 0,

  -- Behavioural patterns — populated once sample_size >= 10
  top_hooks     TEXT[],  -- up to 5 hook excerpts that outperformed avg likes by 20%+
  top_tones     TEXT[],  -- tones (from briefs) correlated with best engagement in this cohort
  best_post_hours INT[], -- hours of day (0-23) with highest average reach

  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Index so the agent can quickly look up a cohort by its key
CREATE INDEX IF NOT EXISTS idx_cohort_performance_key      ON cohort_performance(cohort_key);
-- Partial indexes to support slicing by individual dimensions
CREATE INDEX IF NOT EXISTS idx_cohort_performance_industry ON cohort_performance(industry);
CREATE INDEX IF NOT EXISTS idx_cohort_performance_platform ON cohort_performance(platform);

-- RLS: no direct user access — all reads go through the backend API
-- (service role writes aggregate data; users can't write their own cohort rows)
ALTER TABLE cohort_performance ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to cohort_performance" ON cohort_performance;
CREATE POLICY "Service role full access to cohort_performance"
  ON cohort_performance FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- FUNCTION: auto-update updated_at timestamps
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop triggers before recreating (CREATE TRIGGER has no IF NOT EXISTS in older PG)
DROP TRIGGER IF EXISTS set_user_profiles_updated_at ON user_profiles;
DROP TRIGGER IF EXISTS set_posts_updated_at ON posts;

-- Attach the trigger to tables with updated_at columns
CREATE TRIGGER set_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_posts_updated_at
  BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS set_cohort_performance_updated_at ON cohort_performance;
CREATE TRIGGER set_cohort_performance_updated_at
  BEFORE UPDATE ON cohort_performance
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ============================================================
-- TABLE: tier_limits
-- DB-driven per-tier usage caps. Admin can edit values and
-- toggle limits on/off from the admin dashboard without a redeploy.
--
-- limit_value: -1 = unlimited, 0 = blocked, N = max N per period
-- enabled: false = limit not enforced (useful for promos / debugging)
-- ============================================================
CREATE TABLE IF NOT EXISTS tier_limits (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tier         TEXT NOT NULL,                       -- free_trial | starter | professional | enterprise
  feature      TEXT NOT NULL,                       -- briefs_per_month | ai_images_per_month | etc.
  limit_value  INTEGER NOT NULL DEFAULT -1,         -- -1 = unlimited
  enabled      BOOLEAN NOT NULL DEFAULT true,
  label        TEXT,                                -- Human-readable label for the admin UI
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tier, feature)
);

-- Only the service role can read/write tier_limits
-- (users never query this table directly)
ALTER TABLE tier_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to tier_limits" ON tier_limits;
CREATE POLICY "Service role full access to tier_limits"
  ON tier_limits FOR ALL
  USING (auth.role() = 'service_role');

DROP TRIGGER IF EXISTS set_tier_limits_updated_at ON tier_limits;
CREATE TRIGGER set_tier_limits_updated_at
  BEFORE UPDATE ON tier_limits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ----------------------------------------------------------------
-- Seed: default limits per tier.
-- Use INSERT ... ON CONFLICT DO NOTHING so this is safe to re-run
-- without overwriting any admin edits.
-- ----------------------------------------------------------------
INSERT INTO tier_limits (tier, feature, limit_value, enabled, label) VALUES

  -- Free Trial
  ('free_trial', 'briefs_per_month',      3,  true, 'AI post generations per month'),
  ('free_trial', 'ai_images_per_month',   5,  true, 'AI image generations per month'),
  ('free_trial', 'platforms_connected',   2,  true, 'Social platforms connected'),
  ('free_trial', 'scheduled_queue_size',  5,  true, 'Posts in scheduled queue'),

  -- Starter
  ('starter', 'briefs_per_month',        20,  true, 'AI post generations per month'),
  ('starter', 'ai_images_per_month',     30,  true, 'AI image generations per month'),
  ('starter', 'platforms_connected',      4,  true, 'Social platforms connected'),
  ('starter', 'scheduled_queue_size',    25,  true, 'Posts in scheduled queue'),

  -- Professional
  ('professional', 'briefs_per_month',   -1,  true, 'AI post generations per month'),
  ('professional', 'ai_images_per_month',-1,  true, 'AI image generations per month'),
  ('professional', 'platforms_connected', 7,  true, 'Social platforms connected'),
  ('professional', 'scheduled_queue_size',-1, true, 'Posts in scheduled queue'),

  -- Enterprise
  ('enterprise', 'briefs_per_month',     -1,  true, 'AI post generations per month'),
  ('enterprise', 'ai_images_per_month',  -1,  true, 'AI image generations per month'),
  ('enterprise', 'platforms_connected',  -1,  true, 'Social platforms connected'),
  ('enterprise', 'scheduled_queue_size', -1,  true, 'Posts in scheduled queue')

ON CONFLICT (tier, feature) DO NOTHING;


-- ============================================================
-- TABLE: admin_messages
-- In-app messaging between users and admin.
-- Admin can send direct messages or broadcasts to all users.
-- Users can send support messages and reply to admin messages.
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_messages (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sender_type  TEXT NOT NULL CHECK (sender_type IN ('admin', 'user')),
  sender_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  sender_email TEXT,                              -- denormalised for easy display
  recipient_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL = admin inbox (for user→admin messages)
  is_broadcast BOOLEAN NOT NULL DEFAULT false,    -- true = visible to all users
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  parent_id    UUID REFERENCES admin_messages(id) ON DELETE CASCADE,  -- for threaded replies
  read_at      TIMESTAMPTZ,                       -- NULL = unread
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast inbox queries
CREATE INDEX IF NOT EXISTS idx_admin_messages_recipient ON admin_messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_admin_messages_sender    ON admin_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_admin_messages_parent    ON admin_messages(parent_id);

-- RLS: users can only see their own messages or broadcasts
ALTER TABLE admin_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own messages and broadcasts" ON admin_messages;
CREATE POLICY "Users can view their own messages and broadcasts"
  ON admin_messages FOR SELECT
  USING (
    auth.uid() = recipient_id
    OR auth.uid() = sender_id
    OR is_broadcast = true
    OR auth.role() = 'service_role'
  );

DROP POLICY IF EXISTS "Users can insert their own messages" ON admin_messages;
CREATE POLICY "Users can insert their own messages"
  ON admin_messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id
    OR auth.role() = 'service_role'
  );

DROP POLICY IF EXISTS "Service role full access to admin_messages" ON admin_messages;
CREATE POLICY "Service role full access to admin_messages"
  ON admin_messages FOR ALL
  USING (auth.role() = 'service_role');
