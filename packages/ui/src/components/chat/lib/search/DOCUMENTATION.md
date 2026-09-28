# Chat find

In-chat search: a floating bar that finds text in the open conversation,
steps through matches, and paints them in the transcript.

Use this doc when changing match counting, highlighting, reveal/expansion, or
the per-session search state.

## Data counts, DOM paints

The timeline is virtualized, so only message *data* can answer "how many
matches". `chatSearchText.ts` extracts searchable chunks from the same display
list the timeline renders (dedup, malformed parts dropped, synthetic context
folded onto its user message, user/assistant roles only) and caches them per
message identity. `chatSearchMatches.ts` turns a query into an ordered match
list. The bar's count and stepping come from that list and never change
because a row unmounted.

`ChatFindHighlightLayer` paints what is mounted. It re-walks mounted message
roots on every mutation, so a row mounting, streaming, or expanding brings its
highlights in; requests without a mounted range still scroll. Stored text is
raw (markdown, `> ` reasoning prefixes, ANSI); a counted match that markdown
transforms out of the rendered text may resolve to no range — count and scroll
stay honest, and the highlight is skipped rather than painted elsewhere.
Highlight names are per column (`oc-chat-find-<id>`), and runtimes without
`CSS.highlights` degrade to scroll-only.

## Reveal before paint

A match inside collapsed content cannot be painted until the block mounts.
Navigation calls `requestChatFindTurnReveal` / `requestChatFindPartReveal`:
`MessageList` expands the turn's activity disclosure, `ChatMessage` expands the
tool card or reasoning block. Requests survive until a consumer takes them, and
part reveals notify only their message.

## Per-session state

`useChatFindStore` owns two layers per session keyed by runtime + directory +
session:

- **settings** — the five toggles; stay with the session across bar close and
  reopen, never shared between sessions;
- **run** — query, current match, whole-history error; `null` when the bar is
  closed, parked and restored when the reader switches sessions with the bar
  open.

Returning to a session must not move the viewport: both the controller and the
highlight layer skip the reveal/scroll for the first selection after a session
change, leaving the timeline's own viewport restore in charge.

Entries are removed when a session is deleted, archived, or disappears with
its project or worktree (`cleanupPersistedSessionState`, the archive paths,
`useProjectsStore.removeProject`, `removeProjectWorktree`).

## Paged history

Without the whole-history toggle the bar says it searched loaded messages. With
it checked, complete history loads through `SessionMessageLoader.loadComplete`
and "no matches" is withheld until coverage is complete; failure shows an
inline retry. The checkbox stays visible and is disabled with a hint once
coverage is complete.

## Shortcut

`find_in_chat` shares `mod+f` with `find_in_file`; the focused surface decides
(`lib/chatFindOwnership.ts`), and each handler yields outside its scope.
