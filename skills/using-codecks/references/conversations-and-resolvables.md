# Comments, Reviews, Blockers, and Resolvables

Read this reference before opening, replying to, editing, closing, or reopening a Codecks conversation thread.

## Authorization and thread choice

- Do not add comments unless the user explicitly requests a comment or reply.
- Do not open new Comment threads for follow-up work, progress updates, or completion reports.
- Put a follow-up update in an existing open Review thread when appropriate; otherwise report in chat unless the user explicitly requests a tracker write.
- Review and Blocker are resolvable contexts, not lifecycle status values. Use `codecks_card_add_review` and `codecks_card_add_blocker`; `codecks_card_add_block` is a deprecated compatibility alias.
- Review and Blocker are mutually exclusive while open, and a card may have only one open Review.

## Reply workflow

- Reply to an existing thread with `codecks_card_reply_resolvable`.
- Do not use `codecks_card_add_comment` to reply to an existing thread; it opens a new general Comment thread.
- When `resolvableId` is known, pass it with `content`.
- If only the card is known, call `codecks_card_list_resolvables` first unless there is certainly exactly one open matching context. Then use `cardId` plus `context`, or the returned `resolvableId`.
- For a single known open Review, prefer `cardId` plus `context: "review"` rather than opening another Review.
- For closed threads, list with `includeClosed: true`, reopen with `codecks_card_reopen_resolvable`, then reply.
- Use `codecks_card_list_resolvables` to find or verify the target thread before replying.

## Corrective updates

When correcting an earlier Review update:

- State the earlier evidence or assumption briefly.
- State the new contradictory or limiting evidence.
- State the remaining validation gap.
- Scope the conclusion to the evidence. Do not call an issue “fixed” or name a “root cause” until the evidence supports it.

## Lifecycle interaction

- A card with an open Review cannot change lifecycle status. Reply to or resolve the Review first.
- Closing local work or committing code is not permission to resolve a thread or mark the card Done.
