---
name: claude-code
description: >-
  Launch, monitor, steer, and collect results from native Claude Code (or Codex)
  sessions seamlessly on this machine via the unified `cmw-session` CLI.
  Activate this skill whenever the user asks to trigger, submit, delegate, run,
  check, or continue a task in Claude Code (or Codex) from Antigravity.
---

# Delegating Tasks from Antigravity to Claude Code (`cmw-session`)

Use `cmw-session` with `--to claude` (or `--to codex`) to launch and collaborate with native **Claude Code** sessions on this computer.

Sessions started via `cmw-session --to claude`:
- Run natively in the target project folder (inheriting its `CLAUDE.md`, `.mcp.json`, `.claude/settings.json`, and memory);
- Default to **`turbo`** autonomy (`bypassPermissions`) so file edits and commands run without routine permission blocks;
- Persist standard transcripts under `~/.claude/projects/` (`CLAUDE_CODE_ENTRYPOINT=codex-mobile-web`), so they are immediately resumable via `claude --resume <session_id>` in any terminal and visible live on **Codex Mobile Web** (attributed to `Antigravity`).

## Default Seamless Workflow (Foreground Launch + Reactive Background Wait)

Unless the user explicitly asks for *"fire and forget / 不用等结果"* or synchronous blocking, always use this **two-step pattern**:

### Step 1: Launch in Foreground (`WaitMsBeforeAsync: 10000`)

Pipe a self-contained task brief via standard input so quotes, `$variables`, backticks, and Chinese text are never mangled by the shell.

On **Windows PowerShell** (Antigravity's default shell on Windows), use a single-quoted here-string `@' ... '@`:

```powershell
@'
<Self-contained task brief: objective, relevant file paths, context discovered so far, and verification steps>
'@ | cmw-session start --to claude --cwd . --stdin
```

*(On macOS / Linux `bash`/`zsh`, use `cat <<'EOF' | cmw-session start --to claude --cwd "$PWD" --stdin`.)*

- `start` returns in ~1–2 seconds with `session_id` and `next_wait_cmd`.
- If the terminal sandbox blocks loopback HTTP (`127.0.0.1`) or spawning the local CLI, rerun that `cmw-session` call outside the sandbox.

### Step 2: Wait in Background (`WaitMsBeforeAsync: 500`, `NotificationTimeoutSeconds: 600`)

Immediately run the `next_wait_cmd` printed by `start` with **`WaitMsBeforeAsync: 500`** so Antigravity moves it to a background task:

```powershell
cmw-session wait <session_id> --to claude --after-send --timeout 1800
```

- **Do NOT poll** `get` or `manage_task` in a loop. Tell the user the Claude Code session `<session_id>` is running and end your turn (or proceed with independent work); Antigravity will automatically wake you up with a notification when `cmw-session wait` exits.
- When woken up:
  - **`[SESSION WAIT: COMPLETED]`**: Review and summarize `ASSISTANT REPLY` (and inspect changed files if relevant) for the user.
  - **`[SESSION WAIT: APPROVAL_NEEDED]`**: Present the question/plan prompt to the user; once they decide, call `cmw-session respond` and re-attach `cmw-session wait` in the background.

## Fire-and-Forget Mode

When the user says *"发给 Claude Code 跑就行，不用等它"*, execute **Step 1 (`cmw-session start --to claude`)** only and report the `session_id`.

## Command Reference (PowerShell)

```powershell
# Start a new Claude Code task in the current workspace (default autonomy: turbo)
@'
Implement feature X and run unit tests
'@ | cmw-session start --to claude --cwd . --stdin

# Wait in background (run_command with WaitMsBeforeAsync: 500)
cmw-session wait <session_id> --to claude --after-send --timeout 1800

# Inspect status & latest reply without blocking
cmw-session get <session_id> --to claude

# Send a follow-up message (modes: queue [default] | steer | now)
@'
Also handle the empty-input edge case
'@ | cmw-session send <session_id> --to claude --mode queue --stdin

# Respond to a question or plan confirmation
cmw-session respond <session_id> <request_id> allow --to claude --answer "Question=Selected option"

# Stop the running turn
cmw-session stop <session_id> --to claude

# List recent Claude Code sessions (or --to all across Antigravity / Claude / Codex)
cmw-session list --to claude --cwd .
```
