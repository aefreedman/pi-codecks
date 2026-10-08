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

## Writing thread content

These rules apply to every Comment, Review, and Blocker entry, including replies and edits. The reader is a human teammate in the Codecks UI, not an agent.

- Lead with the point in the first sentence. Use plain language and keep the entry short and scannable.
- Use Markdown: paragraphs of at most three sentences, `-` bullet lists with one idea per bullet, and **bold** labels for sections.
- Use backticks only for file paths, commands, and code symbols. Never wrap `$123` card references in backticks or emphasis.
- Do not paste raw tool output, JSON, full logs, stack traces, internal IDs, agent tool names, or reasoning transcripts. Summarize them, and quote only the few relevant lines in a fenced code block.
- A Blocker's first sentence states what is blocked and what would unblock it.

## Review entry structure

Every Review entry, whether it opens a Review or replies in one, must use this structure. Put each bold label on its own line. Omit **Open questions** when there are none.

```markdown
**Summary:** Player respawn now restores the last checkpoint; ready for review.

**Changes**
- Respawn reads the checkpoint saved on level entry.
- Removed the duplicate save on pause.

**Evidence**
- Verified: EditMode respawn tests pass locally.
- Not verified: Console builds and multiplayer sessions.

**Open questions**
- Should checkpoints persist across a game restart?

**Requested action:** Play through level 2 and confirm respawn placement.
```

- **Summary:** is one sentence stating the outcome, verdict, or question.
- **Evidence** separates what was actually verified from what was not. State uncertainty explicitly instead of implying verification.
- **Requested action:** names the exact next step for the reviewer.
- Keep an entry to roughly 15 bullets or fewer. Move long detail into the card body or a linked artifact instead of writing extended prose.
- When editing a Review entry, keep or restore this structure.

## Corrective updates

When correcting an earlier Review update:

- State the earlier evidence or assumption briefly.
- State the new contradictory or limiting evidence.
- State the remaining validation gap.
- Scope the conclusion to the evidence. Do not call an issue “fixed” or name a “root cause” until the evidence supports it.

Use these labels instead of the standard Review sections:

```markdown
**Correction:** The respawn fix does not cover multiplayer sessions.

**Earlier evidence**
- Single-player EditMode tests passed.

**New evidence**
- A host migration restores the wrong checkpoint.

**Remaining gap**
- No multiplayer test coverage yet.

**Requested action:** Hold approval until multiplayer respawn is retested.
```

## Lifecycle interaction

- A card with an open Review cannot change lifecycle status. Reply to or resolve the Review first.
- Closing local work or committing code is not permission to resolve a thread or mark the card Done.
