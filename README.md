# Social Buster

Enterprise-grade AI-powered social media marketing platform.

## What It Does

Social Buster does three core things:

1. **AI Post Generation** - Users fill out a structured brief. The AI generates 3 platform-specific post options per selected platform, complete with hook, caption, hashtags, CTA, and a recommended media clip.

2. **Comment-to-Lead Automation** - n8n monitors comments on published posts. When a comment matches a user-defined trigger phrase, an automated DM is sent with a link to the user's lead capture form.

3. **Auto-Publishing** - Posts are published directly to Instagram, Facebook, TikTok, LinkedIn, X, Threads, and YouTube via their official APIs. Posts can be published immediately or scheduled.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Frontend | Plain HTML, CSS, JavaScript |
| Database | PostgreSQL via Supabase |
| Auth | Supabase Auth |
| Billing | Stripe |
| AI/LLM | vLLM (Mistral 7B / Llama 3.1 8B) |
| Video | FFmpeg |
| Automation | n8n (self-hosted) |
| Cache | Redis (self-hosted) |
| Containers | Docker + Docker Compose |
| Admin | AdminJS |

## Getting Started

1. Clone the repo
2. Copy `backend/.env.example` to `backend/.env` and fill in your values
3. Run `docker compose up` from the `/docker` directory
4. Open `http://localhost:3000` in your browser

## Build Phases

- **Phase 1** - Foundation (folder structure, Docker, Supabase auth, Stripe)
- **Phase 2** - Brief form and AI generation
- **Phase 3** - WYSIWYG platform previews
- **Phase 4** - Media library and FFmpeg
- **Phase 5** - Auto-publishing and n8n workflows
- **Phase 6** - Testing and deployment

## Architecture

- **Multi-tenant**: Every database query is scoped to the authenticated user's `user_id`. Users never see each other's data.
- **Background agents**: Research, performance tracking, comment monitoring, and media cataloging all run in the background — never blocking user actions.
- **Redis caching**: Intelligence summaries, research results, and media metadata are cached per user.
- **Docker-first**: Every service runs in a container. Moving to a bigger VPS is just copying the containers.
