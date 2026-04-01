# Social Buster System Overview

Hub page for current project state, priorities, and reference material.

## Core Reference Docs
- [[handoff]] — Full developer handoff and architecture notes
- [[feature-roadmap-handoff]] — Premium features and long-term roadmap
- [[platform_publishing_guide]] — Platform-specific publishing details and DM debugging history

## Live Documentation
- [[DECISIONS]] — Architecture and design decisions
- [[ISSUES]] — Bugs, problems, and blockers
- [[FEATURES]] — Feature ideas and backlog
- [[CHANGELOG]] — Work completed per session

---

## Tech Stack

| Layer          | Choice                                      |
|----------------|---------------------------------------------|
| Runtime        | Node.js + Express                           |
| Frontend       | Plain HTML/CSS/JS (no React, no build step) |
| Database       | PostgreSQL via Supabase (RLS multi-tenancy) |
| Auth           | Supabase Auth (email/password + JWT)        |
| Job Queue      | BullMQ on Redis (AOF persistence required)  |
| LLM            | OpenAI-compatible (default: Groq)           |
| AI Images      | Cloudflare Workers AI (Flux Schnell)        |
| Video          | FFmpeg (background only)                    |
| Storage        | Supabase Storage (3 public buckets)         |
| Billing        | Stripe (checkout, webhooks, tier gating)    |
| Deployment     | Docker Compose → Coolify                    |

---

## Directory Structure (Summary)

- `backend/` — Express server, routes, agents, workers, services, queues
- `frontend/public/` — Single-page HTML + vanilla JS/CSS (hash routing)
- `docker/` — docker-compose.yml and Dockerfile
- `.claude/docs/` — All project documentation and logs
- `CLAUDE.md` — Core behavioral rules (auto-loaded)

---

## How to Run

**Local Development**
```bash
cp backend/.env.example backend/.env
cd docker && docker compose up --build

---

## Current Focus

Core platform complete. Legacy Membership + Affiliate Program built, pending Stripe setup and end-to-end test.

## Next Actions

1. Run `migration_activity_log.sql` in Supabase (activity_log table not yet created)
2. Run `ALTER TABLE plans ADD COLUMN IF NOT EXISTS logo_url TEXT;` in Supabase
3. Add `CLOUDFLARE_CACHE_TOKEN` env var in Coolify (Zone → Cache Purge token)
4. Create Legacy product in Stripe → seed `legacy_cohorts` with real price ID
5. Complete Stripe Connect platform account verification (email from Stripe)
6. Meta App Review — after Instagram DM test passes
7. Horizontal block scaling — deferred, implement at ~8-9K users. Full design in [[feature-roadmap-handoff]] Section 10.