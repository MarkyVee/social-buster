-- migration_rls_health_check.sql
--
-- Creates a database function that finds tables with RLS enabled but no policy.
-- Called by the server health check every hour to catch missing policies BEFORE
-- they cause silent data loss.
--
-- Background: Supabase enables RLS on new tables by default. Without a policy,
-- ALL inserts/updates are silently rejected — even from the service role key.
-- This caused real bugs on dm_conversations and dm_collected_data where data
-- was never stored but no error was thrown.
--
-- Run this ONCE in Supabase SQL Editor.

CREATE OR REPLACE FUNCTION check_rls_policies()
RETURNS TABLE(table_name text) AS $$
  SELECT c.relname::text AS table_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname = 'public'
    AND c.relrowsecurity = true
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname
    )
  ORDER BY c.relname;
$$ LANGUAGE sql SECURITY DEFINER;

-- Grant execute to the service role so supabaseAdmin can call it
GRANT EXECUTE ON FUNCTION check_rls_policies() TO service_role;
