# Platform Writing Rules
#
# These rules are injected into every post generation prompt.
# Each section tells the AI exactly how to write for that platform.
# Edit these to tune the AI's output per platform.
#
# Lines starting with # are comments and are stripped before sending to the AI.
# ============================================================

INSTAGRAM rules:
- Hook: First line must stop the scroll. Max 15 words. Punchy or curiosity-driven.
- Caption: Max 2,200 characters. Use line breaks and emojis for readability.
- Hashtags: 10-20 highly relevant hashtags. Mix popular and niche.
- CTA: Drive saves, comments, or link-in-bio clicks.
- Media: Vertical video (Reels) or high-quality square/portrait image.

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
- Media: Vertical 9:16 video only. Energy, pacing, and music matter most.

LINKEDIN rules:
- Hook: First line is visible without clicking "see more". Bold insight or contrarian statement.
- Caption: 1,300 characters is the sweet spot. Short paragraphs of 1-3 lines each.
- Hashtags: 3-5 professional hashtags. No spam tags.
- CTA: Drive comments with a professional question. "What is your experience with this?"
- Media: Professional image, infographic, or native video.

X (TWITTER) rules:
- Hook: This IS the full post. Max 280 characters including spaces and hashtags.
- Caption: Same as hook. The entire caption must fit in 280 chars total.
- Hashtags: 1-2 hashtags maximum. Embed naturally in the text if possible.
- CTA: Reply, retweet, or quote tweet. Make it discussion-worthy.
- Media: Optional. 16:9 image or short clip. Does not count toward character limit.

THREADS rules:
- Hook: Conversational and authentic. Sound like a real person, not a brand.
- Caption: Max 500 characters. Authentic tone wins over polished marketing.
- Hashtags: Leave the hashtags array empty [] — Threads does not use hashtags.
- CTA: Start a conversation. End with a genuine question.
- Media: Optional image or short video. Authentic beats polished.

YOUTUBE rules:
- Hook: This is the VIDEO TITLE. SEO-rich. Include the main keyword. Max 100 chars.
- Caption: This is the video description. 200-500 words with keywords naturally embedded. Include chapter timestamps if relevant.
- Hashtags: 5-8 keyword-focused tags used as YouTube tags.
- CTA: "Subscribe", "Like and comment below", "Watch until the end".
- Media: Horizontal 16:9 video. Include thumbnail concept in media_recommendation.
