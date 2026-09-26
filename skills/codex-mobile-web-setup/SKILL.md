---
name: codex-mobile-web-setup
description: Install and connect the Windows Codex Mobile Web connector to an existing relay. Use when setting up another computer, starting an existing installation, or checking its connection.
---

# Codex Mobile Web setup

Connect this Windows computer's existing Codex to the user's relay. Use the portable Windows release from `hzx829/codex-mobile-web`; it includes Node and needs no npm build. Keep the user's model credentials and Codex configuration local.

## Install and connect

1. Confirm Windows x64 and a working Windows-native Codex installation under the current user. A WSL-only installation is not supported. Use any installation directory and relay address already supplied by the user. Otherwise use `%LOCALAPPDATA%\CodexMobileWeb` and ask for the relay's base URL (including the port when needed). The URL must have no path, query, fragment, or credentials. Use HTTPS for public access; if the user supplies an existing HTTP relay, describe its unencrypted transport and preserve their choice.
2. Resolve `scripts/install.ps1` relative to this skill. Prepare the installation while waiting for any missing relay address:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\install.ps1" -PrepareOnly
   ```

   The helper verifies the release ZIP's SHA256, extracts a fresh installation, and reuses a complete existing installation without updating it. `-InstallDir` chooses a different location; `-Version v0.1.3` pins a release. It never imports another computer's `.local` directory. Do not overwrite a nonempty, unrecognized directory.
3. Configure and start. If the user supplies a local text file containing only the relay Token, pass its path with `-TokenFile`; do not read its contents into tool output. A Token from an explicitly authorized private source may be written directly to such a local file without echoing it. Otherwise launch the helper in a hidden PowerShell process so its masked Token dialog is visible while Codex remains responsive:

   ```powershell
   $setupLog = Join-Path $env:TEMP ('cmw-setup-' + [guid]::NewGuid().ToString('N'))
   $setupProcess = Start-Process powershell.exe -WindowStyle Hidden -PassThru `
     -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "<skill-dir>\scripts\install.ps1" -RelayUrl "<relay-url>"' `
     -RedirectStandardOutput ($setupLog + '.log') -RedirectStandardError ($setupLog + '.error.log')
   ```

   Tell the user to enter the Token in the local dialog. Poll the process and sanitized logs with short tool calls. User input is still required until they submit it; elapsed time is not input. Never put a Token in shell arguments, chat, screenshots, Git, or logs. The helper passes it to the existing setup program through stdin.
4. The helper starts the connector in the background and makes an authenticated, read-only `info` request through the relay. Report the installation path, relay URL, computer name, model/provider, project count, and desktop connection state from the result. It does not create or send a task. If the desktop is offline, new connector-managed tasks can still work; controlling existing desktop tasks requires Codex desktop to be running under the same Windows user. Leave a real mobile task and UI verification to the user.

For a nonstandard installation, add `-CodexBin` pointing to the real `codex.exe` and/or `-CodexHome` pointing to this computer's existing Codex directory. Leave them unspecified when auto detection works. The setup dialog only requests the Token; the relay address comes from the invocation. `-TokenFile` avoids the dialog. An existing configured installation starts without either input.

## Existing installations and failures

- Repeating the helper preserves the Token, `machineId`, Codex settings, and running processes. It refuses conflicting configuration parameters. Finish connector-managed tasks before using that installation's `configure.cmd` to change settings; `stop.cmd` interrupts its managed Codex runtime.
- Each computer needs a fresh `machineId`. Reuse only the relay URL and Token across computers. Copying `.local` is for upgrading the same computer, not adding another one. A shared Token can access all computers attached to that relay.
- For a read-only check at any time:

  ```powershell
  & "<install-dir>\runtime\node.exe" "<skill-dir>\scripts\status.mjs" "<install-dir>"
  ```

- A failed check must be reported as incomplete. Inspect `.local/connector.error.log` locally without printing secrets. Token rejection requires correcting the supplied Token; an unreachable relay requires checking its address/network; missing Codex requires fixing detection or the Windows installation. Do not rotate the server Token, restart an active installation, change model providers, or repeatedly reinstall to address these failures.
- The release being installed can be older than repository `main`. Report the downloaded version. Update the relay and connector together when newer protocol features are needed. This skill installs a connector; it does not deploy or upgrade the server.
- Login startup is optional and should only be enabled when requested, using the installed `scripts/windows/autostart.ps1`.

This skill contains no personal relay address or Token. Signing into the same GitHub account does not transfer those settings.
