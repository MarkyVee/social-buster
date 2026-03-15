/**
 * services/promptLoader.js
 *
 * Loads AI prompt files from the /backend/prompts/ folder.
 *
 * WHY THIS EXISTS:
 * All AI prompts are stored as plain .md files in /backend/prompts/.
 * This means you can edit the prompts — changing tone, adding rules,
 * adjusting what the AI looks for — without touching any code.
 * After editing a prompt file, just restart the backend container:
 *   docker compose restart backend
 *
 * PROMPT FILE FORMAT:
 * Prompts that need two sections (system + user) use a "---" separator:
 *
 *   You are an AI assistant...    ← this is the SYSTEM section
 *   ---
 *   Please do the following...   ← this is the USER section
 *
 * Prompts with {{variable}} placeholders have their values filled in
 * when you call loadPrompt(name, { variable: 'value' }).
 *
 * CACHING:
 * Files are read from disk once and cached in memory for the lifetime
 * of the process. A restart is all that's needed to pick up changes.
 */

const fs   = require('fs');
const path = require('path');

// All prompt files live here
const PROMPTS_DIR = path.join(__dirname, '../prompts');

// In-memory cache — keys are prompt names, values are raw file strings
const cache = {};

// ----------------------------------------------------------------
// loadPrompt
//
// Reads a prompt file by name, fills in any {{variable}} placeholders,
// and returns the full prompt string.
//
// name:      The filename without the .md extension. E.g. 'vision-tagging'
// variables: Optional object mapping placeholder names to values.
//            E.g. { brand: 'Acme Corp', industry: 'fitness' }
//
// Returns the prompt text as a string.
// Throws if the file doesn't exist.
// ----------------------------------------------------------------
function loadPrompt(name, variables = {}) {
  // Load from cache if already read
  if (!cache[name]) {
    const filePath = path.join(PROMPTS_DIR, `${name}.md`);

    if (!fs.existsSync(filePath)) {
      throw new Error(
        `[PromptLoader] Prompt file not found: prompts/${name}.md\n` +
        `Make sure the file exists in the /backend/prompts/ folder.`
      );
    }

    cache[name] = fs.readFileSync(filePath, 'utf8').trim();
  }

  let content = cache[name];

  // Replace {{variable}} placeholders with actual values
  for (const [key, value] of Object.entries(variables)) {
    content = content.split(`{{${key}}}`).join(value ?? '');
  }

  return content;
}

// ----------------------------------------------------------------
// loadPromptSections
//
// Same as loadPrompt but splits on the "---" separator and returns
// { system, user } for prompts that have two distinct sections.
//
// Used by services that need to pass system and user messages
// separately to the AI (e.g. visionTaggingService).
//
// Returns: { system: string, user: string }
// ----------------------------------------------------------------
function loadPromptSections(name, variables = {}) {
  const content = loadPrompt(name, variables);

  // Split on a line that is exactly "---" (nothing else on the line)
  const parts = content.split(/\n---\n/);

  return {
    system: parts[0]?.trim() || '',
    user:   parts[1]?.trim() || ''
  };
}

// ----------------------------------------------------------------
// clearCache
//
// Clears the in-memory cache so files are re-read from disk.
// Useful in tests or if you want hot-reload behavior.
// Not used in normal operation.
// ----------------------------------------------------------------
function clearCache() {
  Object.keys(cache).forEach(key => delete cache[key]);
}

module.exports = { loadPrompt, loadPromptSections, clearCache };
