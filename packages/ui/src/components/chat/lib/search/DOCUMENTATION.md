# Chat find

In-chat search: a floating bar that finds text in the open conversation,
steps through matches, and paints them in the transcript.

Use this doc when changing match counting, highlighting, reveal/expansion, or
the per-session search state.

## Data counts, DOM paints

The timeline is virtualized, so only message *data* can answer "how many
matches". `chatSearchText.ts` extracts searchable chunks from the same display
list the timeline renders (dedup, malformed parts dropped, synthetic context
folded onto its user message, user/assistant roles only, rendered text parts
only) and caches them per message identity. `chatSearchMatches.ts` turns a
query into an ordered match list. The bar's count and stepping come from that
list and never change because a row unmounted. Reasoning blocks and tool cards
are not indexed.

`ChatFindHighlightLayer` paints what is mounted. It re-walks mounted message
roots on every mutation, so a row mounting, streaming, or expanding brings its
highlights in; requests without a mounted range still scroll. Stored text is
raw (markdown, ANSI); a counted match that markdown transforms out of the
rendered text may resolve to no range — count and scroll stay honest, and the
highlight is skipped rather than painted elsewhere.
Highlight names are per column (`oc-chat-find-<id>`), and runtimes without
`CSS.highlights` degrade to scroll-only.

## Reveal before paint

A match inside a collapsed turn cannot be painted until the disclosure mounts.
Navigation calls `requestChatFindTurnReveal`, and `MessageList` expands the
turn's activity disclosure. Requests survive until a consumer takes them, so a
request raised before the virtualized row mounts still applies when it does.

Navigation asks the timeline for `align: 'keep'`: it only mounts a row that is
outside the rendered window and releases auto-follow, never moving a mounted
row. The message list owns the display index for every rendered message — v2
assistant replies included, which the turn window model deliberately leaves
unmapped — so the scroll is never gated on a message having a turn; the turn
id only pins the rail indicator. `ChatFindHighlightLayer` owns the final
position: on every new match it centers the match's own range in a bounded
frame loop, retries while a collapsed turn expands or a row mounts (asking the
timeline to mount the row again if it stays out of the window), and keeps the
range between the find bar and the composer through the reflows that follow
(streaming, virtualizer measurement). If a counted match never resolves to a
rendered range, the layer falls back to bringing its message into view. The
reader's own scroll ends that following until the next match. A session switch
holds the centering off for the restored match, so the timeline's viewport
restore stays in charge.

## Per-session state

`useChatFindStore` owns two layers per session keyed by runtime + directory +
session:

- **settings** — case and whole word; stay with the session across bar close
  and reopen, never shared between sessions;
- **run** — query, current match, whole-history error; `null` when the bar is
  closed, parked and restored when the reader switches sessions with the bar
  open. An empty message list is a load state, not a no-match result: the
  parked current match survives it and is re-resolved once messages return.

Returning to a session must not move the viewport: both the controller and the
highlight layer skip the reveal/scroll for the first selection after a session
change, leaving the timeline's own viewport restore in charge.

Entries are removed when a session is deleted, archived, or disappears with
its project or worktree (`cleanupPersistedSessionState`, the archive paths,
`useProjectsStore.removeProject`, `removeProjectWorktree`).

## Whole history

Find always covers the whole conversation: opening the bar loads complete
history through `SessionMessageLoader.loadComplete`, and "no matches" is
withheld until coverage is complete; failure shows an inline retry.

## Shortcut

`find_in_chat` shares `mod+f` with `find_in_file`; the focused surface decides
(`lib/chatFindOwnership.ts`), and each handler yields outside its scope.
