-- migration_support_tickets.sql
--
-- Creates the support_tickets table for user issue reporting.
-- Users submit issues from the Messages page; admins view/manage them
-- in the Admin Dashboard "Issues" tab.
--
-- Run this ONCE in Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS support_tickets (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email    text NOT NULL,

  -- Structured issue fields
  feature       text NOT NULL,           -- which part of the app (e.g. "publishing", "briefs")
  what_happened text NOT NULL,           -- user's description of the problem
  expected      text NOT NULL,           -- what they expected to happen
  steps         text,                    -- steps to reproduce (optional)
  browser_info  text,                    -- auto-detected from navigator.userAgent
  screenshot_url text,                   -- Supabase Storage public URL (optional)
  priority      text NOT NULL DEFAULT 'medium'
                CHECK (priority IN ('low', 'medium', 'high', 'critical')),

  -- Admin workflow
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  admin_notes   text,                    -- internal notes visible only to admin
  resolved_at   timestamptz,

  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- Indexes for fast lookups
CREATE INDEX idx_support_tickets_user_id   ON support_tickets(user_id);
CREATE INDEX idx_support_tickets_status     ON support_tickets(status);
CREATE INDEX idx_support_tickets_created_at ON support_tickets(created_at DESC);

-- Row Level Security
ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;

-- Users can view their own tickets
CREATE POLICY "Users can view own tickets"
  ON support_tickets FOR SELECT
  USING (auth.uid() = user_id);

-- Users can create their own tickets
CREATE POLICY "Users can create tickets"
  ON support_tickets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create storage bucket for screenshot uploads (public so images render in admin)
INSERT INTO storage.buckets (id, name, public)
VALUES ('support-screenshots', 'support-screenshots', true)
ON CONFLICT (id) DO NOTHING;
