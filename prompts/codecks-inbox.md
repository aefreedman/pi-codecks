---
description: Show my Codecks inbox as sectioned cards with owners and latest-message participants.
---

This is a personal-identity workflow. If the user explicitly asks for their own inbox, use `codecks_tool_search` to discover `codecks_profile_select`, select PERSONAL for task scope, then list their attention-worthy Codecks resolvables using `codecks_list_logged_in_user_actionable_resolvables`. The selection restores after this task settles. If PERSONAL is not configured, stop with that requirement; do not switch profiles after an authentication failure or use ORG as a substitute.

Format the response in this order:
1. New activity
2. Resurfaced reviews
3. Resurfaced comments

For each item, use this layout:
- SHORTCODE — OWNER — TITLE
  Participants: participant1, participant2, participant3

Use the card's normal Codecks short code with its leading dollar sign in the final output.

Mark the participant who wrote the latest sampled message with a leading `→`.

Use the tool's heuristic terminology carefully:
- Treat `new_activity` as "new activity since my participation"
- Treat `resurfaced` as "resurfaced open thread"
- Do not describe `new_activity` as definitely "waiting on me"
- Keep card short codes plain in the final output.
