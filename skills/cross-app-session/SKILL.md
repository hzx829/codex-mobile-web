---
name: antigravity
description: Launch, monitor, steer, and collect results from native Antigravity (or Codex) tasks seamlessly on this computer via the unified `cmw-session` CLI. Use whenever the user asks to run, delegate, hand off, check, or continue a task in Antigravity (Anti-Gravity / AGY) or another local agent app from Claude Code.
---

# Native Cross-App Session Delegation (`cmw-session`)

Use `cmw-session` to trigger and collaborate with **Antigravity** (default `--to antigravity`) or **Codex** (`--to codex`) on the same computer.

Tasks started with `cmw-session` automatically:
- Align and register the current working folder as a native Antigravity Desktop project (never stranded in uncategorized conversations);
- Run with **`turbo`** autonomy by default so commands and edits proceed without routine permission interruptions;
- Appear live in both the **Antigravity Desktop App** and the **Codex Mobile Web** phone interface (attributed to `Claude Code`).

## Default Seamless Workflow (Foreground Launch + Background Auto-Wakeup)

Unless the user explicitly says *"fire and forget / don't wait"* or *"block synchronously right now"*, always use this **two-step pattern**:

### Step 1: Start the session in the foreground (< 1 second)
Pipe a clear, self-contained task brief via stdin so shell quoting never mangles code blocks, paths, or Chinese text:

```bash
cat <<'EOF' | cmw-session start --to antigravity --cwd "$PWD" --stdin
<Self-contained task brief: goal, relevant files in this repo, constraints, and how to verify>
EOF
```

- Because `start` returns immediately once Antigravity Hub accepts the prompt, you immediately get `session_id` and `next_wait_cmd` (or an instant actionable error if Antigravity Desktop is closed).
- Tell the user right away that the Antigravity session has started (include the `session_id` so they can also watch it in Antigravity Desktop or on their phone).

### Step 2: Wait in the background (`run_in_background: true`)
Immediately invoke the `next_wait_cmd` printed by `start` using Claude Code's background Bash execution (`run_in_background: true`):

```bash
cmw-session wait <session_id> --to antigravity --after-send --timeout 1800
```

- Do **not** poll in a loop. Leave the background `wait` running; Claude Code remains free for other work and will automatically wake you via `<task-notification>` as soon as Antigravity finishes the turn or pauses for a user question.
- When woken up:
  - **`[SESSION WAIT: COMPLETED]`** or **`[SESSION WAIT: BACKGROUND_RUNNING]`**: Summarize `ASSISTANT REPLY` (and inspect any touched files if helpful) for the user. If you also need background dev-servers/tasks to finish, pass `--until fully_idle`.
  - **`[SESSION WAIT: APPROVAL_NEEDED]`**: Even in `turbo` mode, Antigravity may occasionally ask a clarifying multiple-choice question (`ask_question`) or request access outside the workspace. Present the question/options to the user (mentioning they can answer here in Claude Code, on Antigravity Desktop, or on their phone). If they answer here, forward it with `cmw-session respond` and re-attach `cmw-session wait` in the background.

## Fire-and-Forget Mode

When the user says *"丢给 Antigravity 就行，不用等结果"*, run **Step 1 (`cmw-session start`) only** and skip `wait`.

## Command Reference

```bash
# Start a new task (defaults: --to antigravity --cwd . --autonomy turbo)
cat <<'EOF' | cmw-session start --to antigravity --cwd "$PWD" --stdin
Task instructions here
EOF

# Wait until the current turn finishes (or hits a question/error)
cmw-session wait <session_id> --to antigravity --after-send --timeout 1800

# Check status and latest reply without blocking
cmw-session get <session_id> --to antigravity

# Send a follow-up message (modes: queue [default] | steer [inject into running turn] | now [interrupt & send])
cat <<'EOF' | cmw-session send <session_id> --to antigravity --mode queue --stdin
Follow-up instructions here
EOF

# Answer a pending question or approval
cmw-session respond <session_id> <request_id> allow --to antigravity --answer "Question text=Chosen option"

# Stop the active turn (add --kill-background to also terminate background commands)
cmw-session stop <session_id> --to antigravity

# List recent sessions in the current project (or across all apps with --to all)
cmw-session list --to antigravity --cwd "$PWD"
```

## Writing Good Cross-App Briefs

Antigravity starts a fresh conversation and does **not** see your prior Claude Code chat transcript. Always include in the prompt:
1. **Objective**: Concrete outcome expected.
2. **Context & Files**: Exact relative file paths and key findings you already discovered in Claude Code so Antigravity doesn't repeat exploration from scratch.
3. **Boundaries**: Which files/modules Antigravity owns (especially if you are concurrently editing other files in Claude Code) and whether it should run tests/build before finishing.
