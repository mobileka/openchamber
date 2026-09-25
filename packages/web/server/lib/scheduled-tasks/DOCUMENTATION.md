# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OpenChamber-only automation.
Project-free: loops live in two fixed dirs, state in one global document.

## Scope

- `packages/web/server/lib/projects/project-config.js` owns the generic
  task-list storage primitives (`list/upsert/delete/state`, `reconcileLoopTasks`,
  cross-process file lock). Per-project scheduled-task usage is gone; the only
  scheduled-tasks document is the global one (see below).
- Markdown loop discovery/parsing is owned by `packages/web/server/lib/scheduled-tasks/loops.js`.
- Runtime orchestration and execution is owned by `packages/web/server/lib/scheduled-tasks/runtime.js`.
- This module is OpenChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.

## Layout

- Loop dirs (flat `*.md`, sorted, no ancestors, no fallback — a missing dir
  contributes no loops):
  - local: `~/.agents/loops/` (this machine only)
  - shared: `$OPENCODE_CONFIG_DIR/.agents/loops/` (strictly from the env var;
    unset means no shared dir), synced via git.
- Task names come from file names (`<name>.md` → `name`); a `name`
  frontmatter key is ignored. Optional `directory` frontmatter (`~` expanded
  at read) overrides the default run directory (the parent of
  `$OPENCODE_CONFIG_DIR`).
- One global state document: `$OPENCHAMBER_DATA_DIR/scheduled-tasks.json`
  (store id `scheduled-tasks` via a second `createProjectConfigRuntime`
  pointed at the data dir root). Machine-local, never shared; only the `.md`
  definitions sync. Task ids are `loop:<name>`.
- Precedence: local shadows shared on file-stem collision; within one dir the
  first sorted file wins and the loser is warn-logged (no task).

## Cross-instance occurrence claiming

Multiple OpenChamber server processes can share the same on-disk state
document (for example CLI `serve` on port 3000 and the Electron desktop server
on port 57123). Each process keeps its own timers, so without coordination a
cron slot would dispatch twice.

Before a **scheduled** run creates a session, the runtime claims the occurrence
in the shared state document under the write lock:

- Writes `state.lastScheduledFor` to the armed `nextRunAt` timestamp and advances
  `state.nextRunAt` to the following occurrence.
- A second instance that loses the claim skips session creation and reschedules
  from the winner's persisted `nextRunAt`.
- Config writes also take a cross-process `.json.lock` file so the
  read-modify-write is serialized across processes, not only within one process.
- `syncLoops` (startup and every full resync) reconciles the fixed dirs into
  the global document; a broken state file surfaces as a sync error.
- The sharing processes may run different OpenChamber versions. Normalization
  keeps only the fields a build knows, so every writer persists tasks it did
  not change verbatim from disk and swaps only `state` onto a task whose state
  it updated; a task goes out normalized only when it was deliberately
  replaced (loop adoption). An older server touching the file after a
  run therefore cannot strip fields a newer build added.
- Lock timeout / filesystem errors on claim, manual-start, or completion state
  writes always release the in-process running slot (via `finally`) and best-effort
  re-arm the **next future** occurrence; they must not leave the task permanently
  "running" or reject unhandled from the queue pump.
- Re-arm helpers only schedule a persisted `nextRunAt` when it is still in the
  future. A past slot (common for `once` after claim, which cannot advance
  `nextRunAt`) falls back to `computeNextRunAt` — which returns null for a
  consumed/past once occurrence — so a losing instance stops instead of
  spinning delay-0 timers against the lock.
- On claim lock/fs failure, best-effort persist `lastStatus: error` + `lastError`
  when nobody else claimed the occurrence, so a past `once` task is not left
  enabled-but-inert with only a warn log. Recurring schedules still re-arm the
  next slot.
- On completion-write failure after a session already ran, in-memory status is
  set to a terminal value and a single persist retry is attempted so
  `lastStatus` does not stay `running`. Manual `runNow` still returns the
  `sessionID` as a successful dispatch (`ok` follows run status, with
  `persistError` set) rather than a hard 500; the run API and Scheduled Tasks
  UI surface `persistError` as a warning toast.
- The claim predicate rejects a duplicate solely via `lastScheduledFor` within
  slack of this occurrence. It does not consult advanced on-disk `nextRunAt`
  (that field is routinely overwritten by a second instance syncing inside
  `TASK_DUE_SLACK_MS`, including on later days when `lastScheduledFor` is already
  set from a prior claim).
- Claiming always writes `nextRunAt` (including `undefined`) so a past once-slot
  is cleared when there is no following occurrence.

Manual `runNow` does not claim a schedule occurrence. It also runs paused
(`enabled: false`) tasks — that is the point of the button — while scheduled
dispatches still skip disabled tasks, and completion never re-arms a paused task.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Global concurrency control
  - Session create + prompt_async execution in the loop directory
  - Emits OpenChamber task-run events (no project)

- `packages/web/server/lib/scheduled-tasks/loops.js`
  - Discovery of the two fixed `.agents/loops` dirs (local + shared)
  - File-stem naming, frontmatter parsing, create-file writer
  - `syncLoops` reconciles discovered loops with the persisted task list on
    every sync (startup, task list load, task save/delete)

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Global scheduled-task endpoints (list, create-file, enabled toggle,
    file delete, manual run, status)
  - Listing tasks reconciles loop files first, so opening the Scheduled Tasks UI discovers file additions, edits, and removals without a server restart
  - Manual run endpoint
  - OpenChamber events SSE stream endpoint

## Loop file format

Portable, git-commit-able scheduled-task definitions:

```markdown
---
schedule: "0 9 * * *"
enabled: true
model: anthropic/claude-sonnet-4-5
agent: plan
timezone: Europe/Kyiv
directory: ~/dev/opencode
---
Summarize repository changes since yesterday.
```

Field mapping (model: `packages/ui/src/lib/scheduledTasksApi.ts`):

| Frontmatter | Task field |
|---|---|
| filename stem | `name` (required, max 80 characters — longer names are rejected as malformed) |
| `schedule` | `schedule.kind: "cron"` + `schedule.cron` (required, cron-only in the portable format) |
| `enabled` | `enabled` (default `false` — a loop only runs when the file explicitly enables it; add `enabled: true` to activate) |
| `model` | split on the first `/` into `execution.providerID` / `execution.modelID` (required) |
| `agent` | `execution.agent` (optional) |
| `timezone` | `schedule.timezone` (optional, IANA; defaults to the server zone) |
| `directory` | `execution.directory` (optional, `~` expanded at read; defaults to the parent of `$OPENCODE_CONFIG_DIR`) |
| body | `execution.prompt` (required) |

`thinking_level` and `goalEnabled`/`goalTokenBudget` are not part of the portable
format (UI/JSON-only today); `daily`/`weekly`/`once` schedules remain
runtime-supported but are not writable to loop files. Runtime state
(`lastRunAt`, `nextRunAt`, `lastStatus`, `lastError`, `lastSessionId`,
`lastDurationMs`) is never written to the markdown file — it lives in the
single global state document.

## Loop reconciliation rules

`reconcileLoopTasks('scheduled-tasks', loops)` runs inside the write lock on
every `syncLoops`:

- **Identity.** For loop-owned tasks (carrying the `loopFile` marker) identity
  is the loop file path: content edits adopt in place. Renaming the file is a
  delete + create (fresh state). A loop whose name matches a JSON task (no
  `loopFile`) takes that task over instead: its schedule/execution/enabled are
  overwritten from the file while the task's `id` and runtime `state` are
  preserved (markdown wins on conflict).
- **UI-only fields survive adoption.** Execution fields the file format does
  not define (`goalEnabled`, `goalTokenBudget`, `permissionAutoAccept`,
  `variant`) are preserved from the task when a loop adopts it; only fields the
  file defines are re-applied.
- **Deletion.** A task carrying the `loopFile` marker whose loop file is no
  longer discovered (removed or renamed) is unscheduled (removed from the
  document). The marker is persisted, so removal is detected across restarts.
  A task whose loop file still exists but is currently unparseable is KEPT with
  its last good definition — a transiently malformed file (mid-edit, bad merge)
  never deletes a task or its runtime state.
- **Creation.** Loops without a matching task are created under a deterministic
  `loop:<name>` id so runtime state survives restarts. At most one task
  is driven per loop file; orphan duplicates of the same file are unscheduled.
- **Location precedence.** Local loops shadow shared loops with the same file
  stem; within one dir the first sorted file wins (the loser is warn-logged).
- **Malformed files** (missing `schedule`/`model`/body, overlong file stem,
  blank `directory`, unreadable) are reported to the scheduler as
  `definition: null` entries and warned about; they never block valid loops.
- **Loop-file mutations.** The loop file remains authoritative. The scheduled-
  tasks UI opens it in the built-in file editor, updates its `enabled`
  frontmatter through the enabled endpoint, creates new files through the
  create endpoint (with a fixed `local`/`shared` location), and deletes the
  file through the delete endpoint after confirmation. Each mutation syncs.

## Public exports (runtime.js)

- `createScheduledTasksRuntime(dependencies)`
- Returned API:
  - `start()`
  - `stop()`
  - `syncLoops()`
  - `runNow(taskId)`
- `GLOBAL_SCHEDULED_TASKS_ID` (`'scheduled-tasks'`)

## Public exports (routes.js)

- `registerScheduledTaskRoutes(app, dependencies)`
- Registers:
  - `GET /api/openchamber/scheduled-tasks`
  - `POST /api/openchamber/scheduled-tasks`
  - `DELETE /api/openchamber/scheduled-tasks/:taskId`
  - `PATCH /api/openchamber/scheduled-tasks/:taskId/enabled`
  - `POST /api/openchamber/scheduled-tasks/:taskId/run`
  - `GET /api/openchamber/scheduled-tasks/status` (also reports the
    server-resolved `defaultRunDirectory`, shown verbatim in the UI)
  - `GET /api/openchamber/events`

The shared `/api/openchamber/events` stream also carries web notifications.
Its connection ownership and browser capability flag stay unchanged. Delivery
and duplicate handling are documented in `../notifications/DOCUMENTATION.md`.
