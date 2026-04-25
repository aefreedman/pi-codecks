# Resolvable Inbox Heuristics

This document explains the current Codecks resolvable inbox approximation implemented in this package.

## Normal vs debug tools

### Registered by default
- `codecks_list_open_resolvable_cards`
- `codecks_list_logged_in_user_actionable_resolvables`

### Registered only when explicitly enabled
- `codecks_debug_logged_in_user_resolvable_participation`
- `codecks_debug_logged_in_user_resolvables`

Enable the debug tools before launching Pi:

- `CODECKS_ENABLE_DEBUG_TOOLS=1`
- or `PI_CODECKS_ENABLE_DEBUG_TOOLS=1`

The debug tools are opt-in so low-frequency diagnostics do not clutter Pi's normal tool list or consume routine context budget.

## Why heuristics are needed

The live API surface available to this package reliably exposes:
- open/closed resolvables
- thread entries and latest sampled activity
- card creator / assignee
- resolvable creator

However, the obvious user-state and participation surfaces that would make the web UI easy to reproduce exactly currently return server errors in this environment, including probes for:
- unread / read state
- snooze state
- participant / subscriber / watcher relations
- leave-thread / opt-out fields

Because of that, the package uses a practical approximation for the logged-in user's attention-worthy resolvable list.

## Attention-worthy resolvable heuristic

`codecks_list_logged_in_user_actionable_resolvables` starts from open resolvables and places each one into one of two buckets.

### `new_activity`
A resolvable is treated as having new activity when:
- the latest sampled entry was written by someone else, and
- at least one of these signals links the thread to the logged-in user:
  - the latest entry mentions the logged-in user
  - the card assignee is the logged-in user
  - the card creator is the logged-in user
  - the resolvable creator is the logged-in user
  - the logged-in user appears in sampled thread participants (derived from sampled entry authors plus card/resolvable ownership fields)

This does **not** imply obligation or that the thread is definitely waiting on the user.

### `resurfaced`
A resolvable is treated as resurfaced when:
- the latest sampled entry was written by the logged-in user, and
- the resolvable is still open, and
- the latest sampled activity is older than `staleAfterHours` (default: 24)

This is meant to approximate the web UI behavior where an unresolved thread can come back after a delay even without a new reply.

## Bubble heuristic

The package uses simple bubble heuristic names:
- `unread`
- `read`
- `stale_review`

Current mapping:
- `new_activity` -> `unread`
- `resurfaced` on `review` -> `stale_review`
- `resurfaced` on non-review contexts -> `read`

This matches observed UI behavior reasonably well:
- green bubble -> `unread`
- white bubble -> `read`
- purple review bubble -> `stale_review`

## Important limitations

This is still a heuristic approximation, not an exact inbox mirror.

The package currently does **not** reliably know:
- exact unread vs read state from Codecks
- exact snoozed vs unsnoozed state
- whether a participant explicitly left / muted / unsubscribed from a thread
- the exact server-side rule used by the web UI for resurfacing

## Recommended usage

### Regular use
Use:
- `codecks_list_logged_in_user_actionable_resolvables`

This is the best low-cost approximation for normal use when you want threads that likely deserve the logged-in user's attention.

### Investigation / reverse engineering
Enable debug tools and use:
- `codecks_debug_logged_in_user_resolvable_participation`
- `codecks_debug_logged_in_user_resolvables`

These tools are intended for low-frequency diagnostics only.
