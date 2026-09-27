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
