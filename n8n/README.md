# n8n Workflows

This directory contains exported n8n workflow templates for Social Buster.

## Overview

n8n is the automation engine that powers:
1. **Comment Monitoring Workflows** - Watch for trigger phrases in post comments
2. **Automated DM Workflows** - Send DMs when a trigger phrase is detected
3. **Lead Capture Flows** - Deliver the user's Google Form link via DM

## How It Works

1. The commentAgent detects a comment matching a user-defined trigger phrase
2. The agent calls n8n via its API with the comment details and user config
3. n8n executes the workflow for that user:
   - Looks up which platform the comment is on
   - Uses the user's connected OAuth token to send a DM
   - DM contains the user's configured message + their Google Form link
4. n8n logs the action (without storing form responses — those go directly to the user)

## Workflow Templates

Workflows are stored here as JSON exports and can be imported into n8n.

- `comment-trigger-instagram.json` - Instagram comment trigger + DM
- `comment-trigger-facebook.json`  - Facebook comment trigger + DM
- `comment-trigger-tiktok.json`    - TikTok comment trigger + DM
- `comment-trigger-youtube.json`   - YouTube comment trigger + DM

## n8n Setup

n8n runs as a Docker container (see docker-compose.yml).
Access the n8n UI at http://localhost:5678 to manage workflows.
Each user's workflow is configured with their own OAuth credentials.
