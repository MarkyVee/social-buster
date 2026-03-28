# Platform Writing Rules
#
# These rules are injected into every post generation prompt.
# Each section tells the AI exactly how to write for that platform.
# Edit these to tune the AI's output per platform.
#
# Lines starting with # are comments and are stripped before sending to the AI.
#
# IMPORTANT: Character limits below are HARD LIMITS enforced by each platform's API.
# If content exceeds these limits, it will be truncated or rejected.
# Always generate content WITHIN the stated limits.
# ============================================================

INSTAGRAM rules:
- Hook: First line must stop the scroll. Max 15 words. Punchy or curiosity-driven.
- Caption: Keep under 2,000 characters to stay safely within the 2,200 char HARD LIMIT.
- Hashtags: 10-20 highly relevant hashtags. Mix popular and niche.
- CTA: Drive saves, comments, or link-in-bio clicks.
- HARD LIMIT: Hook + Caption + Hashtags + CTA combined must be under 2,200 characters total.
- Media: Vertical video (Reels) or high-quality square/portrait image. Image aspect ratio must be between 4:5 and 1.91:1.

FACEBOOK rules:
- Hook: Conversational opening. Ask a question or make a bold statement.
- Caption: 100-500 characters performs best. Longer works for storytelling.
- Hashtags: 2-4 hashtags only. More looks spammy on Facebook.
- CTA: Drive comments and shares. Ask people to tag a friend or answer a question.
- Media: Native video outperforms link posts. Landscape (16:9) or square.

TIKTOK rules:
- Hook: First 3 words must hook immediately. Use "POV:", "Wait for it", "Nobody talks about".
- Caption: Max 150 characters. Short and punchy. Hashtags count toward this limit.
- Hashtags: 3-5 hashtags. Mix 1 mega-trend + 2 niche relevant tags.
- CTA: Drive comments with a question. "Comment [word] for the link."
- HARD LIMIT: Hook + Hashtags combined must be under 2,200 characters total.
- Media: Vertical 9:16 video only. Energy, pacing, and music matter most.

LINKEDIN rules:
- Hook: First line is visible without clicking "see more". Bold insight or contrarian statement.
- Caption: 1,300 characters is the sweet spot. Short paragraphs of 1-3 lines each.
- Hashtags: 3-5 professional hashtags. No spam tags.
- CTA: Drive comments with a professional question. "What is your experience with this?"
- HARD LIMIT: Hook + Caption + Hashtags + CTA combined must be under 3,000 characters total.
- Media: Professional image, infographic, or native video.

X (TWITTER) rules:
- Hook: This IS the full post. HARD LIMIT: 280 characters total including spaces and hashtags.
- Caption: Leave empty — X only uses the hook field. Do NOT generate a separate caption.
- Hashtags: 1-2 hashtags maximum. Embed naturally in the hook text. These count toward the 280 char limit.
- CTA: Embed in the hook if space allows. Reply, retweet, or quote tweet.
- HARD LIMIT: Hook + Hashtags + CTA combined must be under 280 characters total. This is strict — the API will reject anything over 280.
- Media: Optional. 16:9 image or short clip. Does not count toward character limit.

THREADS rules:
- Hook: Conversational and authentic. Sound like a real person, not a brand.
- Caption: Keep under 400 characters to stay safely within the 500 char HARD LIMIT.
- Hashtags: Leave the hashtags array empty [] — Threads does not use hashtags.
- CTA: Start a conversation. End with a genuine question.
- HARD LIMIT: Hook + Caption + CTA combined must be under 500 characters total.
- Media: Optional image or short video. Authentic beats polished.

YOUTUBE rules:
- Hook: This is the VIDEO TITLE. SEO-rich. Include the main keyword. HARD LIMIT: 100 characters.
- Caption: This is the video description. 200-500 words with keywords naturally embedded. Include chapter timestamps if relevant. HARD LIMIT: 5,000 characters.
- Hashtags: 5-8 keyword-focused tags used as YouTube tags.
- CTA: "Subscribe", "Like and comment below", "Watch until the end".
- Media: Horizontal 16:9 video. Include thumbnail concept in media_recommendation.
