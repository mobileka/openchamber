# DIFF: this fork vs upstream

This file is the merge ledger for deliberate differences from upstream OpenChamber. One entry per feature.

How to use it at merge time:

1. Find the entry whose files overlap the incoming upstream change.
2. Read "Upstream behavior" and "Fork behavior". If upstream now does what the fork wants, delete the entry and drop the fork code.
3. Otherwise reapply the fork behavior on top of the new upstream code and keep the entry, updating the file list and tests if they moved.
4. Do not backfill differences that predate this ledger.

## Agent switching shortcuts and agent name capitalization

### Upstream behavior

- `cycle_agent` (Tab) walks through every primary agent. Shift+Tab is not a binding: each handler derives `shift+<cycle_agent binding>` at runtime as the backward walk.
- No shortcut opens the composer agent dropdown.
- Agent display names get a first-letter capital only, and several surfaces capitalize the raw id themselves.

### Fork behavior

- `cycle_agent` (Tab) switches between Plan and Build only.
- `cycle_all_agents` (Shift+Tab) is a real, customizable binding that cycles through all primary agents forward. The derived backward logic is gone; the dispatcher resolves Shift+Tab like any other binding.
- `open_agent_picker` (Ctrl+X A) opens the composer agent dropdown. Opening it closes the model picker, and the other way round.
- `agentLabel` capitalizes every word through `capitalizeWords` (whitespace, `-`, `_` are word boundaries; existing capitals are never lowered). The mobile agent button, the message footer, and subagent task labels use the same capitalization.

### Files

- `packages/ui/src/lib/utils.ts` (`capitalizeWords`)
- `packages/ui/src/lib/agentLabel.ts`
- `packages/ui/src/components/chat/mobileControlsUtils.ts` (`getCycledPlanBuildAgentName`, `getAgentDisplayName`)
- `packages/ui/src/lib/shortcuts/config.ts` (schema)
- `packages/ui/src/hooks/useKeyboardShortcuts.ts` (handlers)
- `packages/ui/src/components/chat/ChatInput.tsx` (composer key handling)
- `packages/ui/src/components/chat/ModelControls.tsx` (picker Tab paths, global agent picker state)
- `packages/ui/src/stores/useUIStore.ts` (`isAgentSelectorOpen`)
- `packages/ui/src/components/chat/message/MessageBody.tsx` (footer agent name)
- `packages/ui/src/components/chat/message/parts/ToolPart.tsx` (subagent labels)
- `packages/ui/src/components/ui/HelpDialog.tsx` (help rows)
- `packages/ui/src/lib/shortcuts/DOCUMENTATION.md`
- every locale under `packages/ui/src/lib/i18n/messages/`

### Invariants to preserve

- Agent machine keys stay raw. The `@mention` autocomplete token and the Settings Agents list and rename ids are not capitalized.
- Mobile tap-to-cycle keeps cycling all primary agents forward. `MobileAgentButton` calls `handleCycleAgent` with its default mode.
- Tab and Shift+Tab are composer actions: they yield to open overlays and require focus inside `[data-chat-input="true"]`, and an open autocomplete keeps Tab and Shift+Tab.
- The model picker and the agent picker never open at the same time.
- The model picker's Tab paths use the same split: Tab for Plan and Build, Shift+Tab for all primary agents.
- Candidates are visible primary agents only. Plan/Build order is `plan`, then `build`.

### Tests that pin this

- `packages/ui/src/lib/utils.test.ts`: `capitalizeWords` boundaries and casing.
- `packages/ui/src/lib/agentLabel.test.ts`: display name, blank fallback, multi-word and hyphenated ids.
- `packages/ui/src/components/chat/mobileControlsUtils.test.ts`: Plan/Build cycle, single-candidate rule, display capitalization.
- `packages/ui/src/lib/shortcuts/schema.test.ts`: Tab, Shift+Tab, and Ctrl+X A defaults and combo lookup.

## Find in chat

### Upstream behavior

- No in-chat search exists. `mod+f` belongs to `find_in_file` alone (CodeMirror editor search, and the Markdown preview find bar).
- The command palette has no chat search item. The timeline dialog filters user prompts only; it does not search assistant text and does not highlight matches in the transcript.
- No per-session search state exists, so there is nothing to clean up on archive, deletion, or project/worktree removal.

### Fork behavior

- `find_in_chat` shares `mod+f` with `find_in_file`, and additionally opens from a composer-footer magnifier and a "Search in chat" command palette item. A floating bar renders over the transcript with query, `n/total` count, previous/next, close, case, whole-word, reasoning, tool-call, and whole-history toggles.
- Counts and stepping come from the session's message data: user and assistant text by default, plus reasoning and tool calls (row description, arguments, output, error) when enabled. Virtualized rows make DOM-only find impossible, so the data index owns the count.
- `ChatFindHighlightLayer` paints every mounted match softly and the current one strongly through the CSS Custom Highlight API, re-scanning on list mutations; navigation expands collapsed tool/reasoning/turn-activity blocks before painting and falls back to scroll-only where ranges cannot be resolved (markdown transforms, ANSI, no `CSS.highlights`).
- Per-session state: toggles stay with the session across bar close/reopen and never leak between sessions; query/current match belong to the open bar and are parked/restored when switching sessions with the bar open, without forcing a scroll. Nothing is persisted.
- Search state is cleared when a session is archived, deleted, or disappears with its project/worktree, through `cleanupPersistedSessionState`, `archiveSession`, `commitArchivedSessions`, the `session.patched` archive event, `useProjectsStore.removeProject`, and `removeProjectWorktree`.
- History stays honest: without the whole-history toggle the bar says it searched loaded messages; with it checked, complete history loads with progress and "no matches" is withheld until coverage is complete. The checkbox is always visible and disabled with a "History is complete" hint once coverage is complete.

### Files

- `packages/ui/src/components/chat/components/ChatFindBar.tsx`
- `packages/ui/src/components/chat/hooks/useChatFind.ts`
- `packages/ui/src/components/chat/chatFindContext.ts`
- `packages/ui/src/components/chat/lib/chatFindReveal.ts`
- `packages/ui/src/components/chat/lib/search/` (`types.ts`, `chatSearchText.ts`, `chatSearchMatches.ts`, `DOCUMENTATION.md`)
- `packages/ui/src/components/chat/message/ChatFindHighlightLayer.tsx`
- `packages/ui/src/stores/useChatFindStore.ts`
- `packages/ui/src/lib/search/textMatches.ts`
- `packages/ui/src/lib/chatFindOwnership.ts`
- `packages/ui/src/components/chat/ChatContainer.tsx`
- `packages/ui/src/components/chat/ChatMessage.tsx`
- `packages/ui/src/components/chat/MessageList.tsx`
- `packages/ui/src/components/chat/composer/ui/ComposerFooter.tsx`
- `packages/ui/src/components/chat/message/MessageBody.tsx`
- `packages/ui/src/components/chat/message/parts/` (`ToolPart.tsx`, `ProgressiveGroup.tsx`, `ReasoningPart.tsx`, `AssistantTextPart.tsx`, `UserTextPart.tsx`, `DOCUMENTATION.md`)
- `packages/ui/src/components/ui/CommandPalette.tsx`
- `packages/ui/src/hooks/useKeyboardShortcuts.ts`
- `packages/ui/src/hooks/useMiniChatKeyboardShortcuts.ts`
- `packages/ui/src/index.css` (`::highlight(oc-chat-find*)`)
- `packages/ui/src/lib/chatQuoteAnchor.ts` (`rangeFromStreamOffsets`)
- `packages/ui/src/lib/shortcuts/config.ts`, `schema.test.ts`, `DOCUMENTATION.md`
- `packages/ui/src/sync/session-actions.ts`, `session-deletion-cleanup.ts`, `sync-context.tsx`
- `packages/ui/src/stores/useProjectsStore.ts`
- `packages/ui/src/lib/worktrees/worktreeManager.ts`
- every locale under `packages/ui/src/lib/i18n/messages/`

### Invariants to preserve

- A counted match always navigates; a highlight is never painted for a range the query did not match. Counts come from data, paints from the mounted DOM.
- `mod+f` stays shared: `find_in_file` and `find_in_chat` are whitelisted as a contextual pair, and the chat handler yields whenever focus is inside another surface.
- Session settings and the search run stay separate; restoring a session must not scroll, reselect, or re-evaluate under another session's toggles.
- Paged history must never present an incomplete search as "no matches".
- Reasoning search stays disabled while Reasoning Traces is off; tool search includes the visible row description, arguments, output, and error.
- The highlight layer must stay mutation-free (CSS Custom Highlight API) so it needs no self-mutation filtering, and the bar must not reflow the timeline.

### Tests that pin this

- `packages/ui/src/lib/search/textMatches.test.ts`: case, whole word, overlap, Unicode boundaries.
- `packages/ui/src/components/chat/lib/search/chatSearchText.test.ts`: role filtering, reasoning/tool gating, context payloads, dedup, synthetic context folding.
- `packages/ui/src/components/chat/lib/search/chatSearchMatches.test.ts`: match ordering, occurrence keys, nearest-from-viewport selection.
- `packages/ui/src/stores/useChatFindStore.test.ts`: per-session settings/run split, cross-session isolation, composite deletion, directory cleanup.
- `packages/ui/src/sync/session-deletion-cleanup.test.ts`: chat find state cleared only for the deleted session.
- `packages/ui/src/lib/shortcuts/schema.test.ts`: the shared `mod+f` pair.

