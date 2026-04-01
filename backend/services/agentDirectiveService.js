/**
 * services/agentDirectiveService.js
 *
 * Admin-injectable directives for AI agents.
 *
 * WHAT THIS DOES:
 * Lets admins write soft guidance that gets injected into agent runs —
 * either global (applies to all agents for all users) or targeted to a
 * specific agent and/or a specific user.
 *
 * Example directives an admin might write:
 *   "Have you considered that this user's audience is primarily B2B? Weight
 *    weekday morning posts more heavily than weekend posts."
 *
 *   "What would it look like if we treated video content as 1.5x more
 *    valuable than static image posts for engagement scoring?"
 *
 *   "This platform is running a summer campaign. Promotional content should
 *    be weighted higher than usual across all users this week."
 *
 * HOW IT WORKS:
 *
 *   Layer 1 agents (pure math — hookPerformanceAgent, toneObjectiveFitAgent,
 *   postTypeCalendarAgent): The directive is stored alongside the signal_weights
 *   data and surfaced by contextBuilder at generation time as an "Admin Note"
 *   block. It does not change the math — it gives the LLM extra framing when
 *   it reads the signal_weights output.
 *
 *   Layer 2+ agents (LLM-calling — researchAgent, etc.): The directive is
 *   injected directly into the agent's system prompt before it runs, so the
 *   LLM reasons with it as part of its core context.
 *
 * DIRECTIVE RESOLUTION ORDER (most specific wins, all matches combined):
 *   1. user_id + agent_name match   ← most targeted
 *   2. user_id + agent_name = '*'   ← applies to all agents for one user
 *   3. user_id = null + agent_name  ← applies to all users for one agent
 *   4. user_id = null + agent_name = '*' ← global, applies to everything
 *
 * Multiple matches are combined (joined with newlines) so global + targeted
 * directives both apply at once.
 *
 * REQUIRES: admin_agent_directives table (migration_agent_directives.sql)
 */

const { supabaseAdmin } = require('./supabaseService');

// ----------------------------------------------------------------
// getAgentDirective — called at the top of every agent run.
//
// Returns a string directive if one exists, or null if there is none.
// Agents that receive null run exactly as they always have.
// ----------------------------------------------------------------
async function getAgentDirective(agentName, userId) {
  try {
    // Fetch all active directives that match this agent + user combination.
    // We can't do a single .or() that covers all four resolution cases cleanly
    // in PostgREST, so we fetch broadly and filter in JS — the result set is
    // tiny (admins rarely have more than a handful of directives).
    const { data: rows } = await supabaseAdmin
      .from('admin_agent_directives')
      .select('directive, agent_name, user_id')
      .eq('is_active', true);

    if (!rows || rows.length === 0) return null;

    // Keep rows that match this agent (or wildcard) AND this user (or global)
    const matching = rows.filter(r => {
      const agentMatch = r.agent_name === agentName || r.agent_name === '*';
      const userMatch  = r.user_id === userId || r.user_id === null;
      return agentMatch && userMatch;
    });

    if (matching.length === 0) return null;

    // Combine all matching directives
    const combined = matching
      .map(r => r.directive?.trim())
      .filter(Boolean)
      .join('\n\n');

    return combined || null;

  } catch (_) {
    // Never let a missing directive break an agent run
    return null;
  }
}

module.exports = { getAgentDirective };
