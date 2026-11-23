// System tray app for the Windows portable package.
// Compiled by scripts/package-windows.ts with the .NET Framework C# 5 compiler that ships with Windows,
// so it must stay within C# 5 (no string interpolation, no ?. operator, no expression-bodied members).
// Service work is delegated to the existing PowerShell scripts and build/setup.mjs, which stay the single
// source of truth. The window (DesktopWindow.cs) is a WebView2 page; without the WebView2 runtime the tray
// falls back to the connection page in the browser and the PowerShell settings form.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Program {
  [STAThread]
  static int Main(string[] args) {
    string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    string runtime = Path.Combine(root, "runtime");
    // WebView2's managed DLL ships in runtime\ to keep the package root tidy.
    AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e) {
      string path = Path.Combine(runtime, new AssemblyName(e.Name).Name + ".dll");
      return File.Exists(path) ? Assembly.LoadFrom(path) : null;
    };
    if (args.Length == 2 && args[0] == "--write-icon") {Logo.WriteIco(args[1]); return 0;}
    bool background = Array.IndexOf(args, "--background") >= 0;
    string key = "Local\\CodexMobileWeb-" + Hash(root.ToLowerInvariant());
    bool created;
    using (Mutex mutex = new Mutex(true, key, out created)) {
      if (!created) {
        // Already running for this folder: ask that instance to show its window.
        if (!background) {try {EventWaitHandle.OpenExisting(key + "-show").Set();} catch (Exception) {}}
        return 0;
      }
      using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, key + "-show")) {
        NativeMenus.FollowSystemTheme();
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new TrayContext(root, background, show));
      }
      GC.KeepAlive(mutex);
    }
    return 0;
  }

  static string Hash(string value) {
    using (SHA1 sha = SHA1.Create()) {
      byte[] bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(value));
      return BitConverter.ToString(bytes, 0, 8).Replace("-", "");
    }
  }
}

// Lets the native tray menu follow the Windows light/dark setting (uxtheme ordinals used by Explorer and Terminal).
static class NativeMenus {
  [DllImport("uxtheme.dll", EntryPoint = "#135")] static extern int SetPreferredAppMode(int mode);
  [DllImport("uxtheme.dll", EntryPoint = "#136")] static extern void FlushMenuThemes();
  public static void FollowSystemTheme() {
    try {
      if (Environment.OSVersion.Version.Build < 17763) return;
      SetPreferredAppMode(1);
      FlushMenuThemes();
    } catch (Exception) {}
  }
}

sealed class ProcessResult {
  public int Code;
  public string Output = "";
  public string Error = "";
}

enum ServiceState {Stopped, Partial, Running}

sealed class TrayContext : ApplicationContext {
  const string Title = "Codex 随行";
  readonly string root, local, configPath;
  readonly bool webview;
  readonly NotifyIcon icon = new NotifyIcon();
  readonly ContextMenu menu = new ContextMenu();
  readonly Control invoker = new Control();
  readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
  readonly System.Windows.Forms.Timer healthTimer = new System.Windows.Forms.Timer();
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  readonly MenuItem statusItem, openItem, copyItem, toggleItem, settingsItem, signInItem, logsItem, autostartItem, exitItem;
  readonly Icon runningIcon, partialIcon, stoppedIcon, busyIcon, appIcon;
  DesktopWindow window;
  ServiceState state = ServiceState.Stopped;
  string busy;            // "starting" | "stopping" | "saving" while an operation runs
  string lastError;       // shown in the window until the next start
  string lastPosted;
  Dictionary<string, object> config;
  bool quiet, expectRunning, balloonOpensLogs, checkingHealth, quitting, signingIn;

  public TrayContext(string root, bool background, EventWaitHandle show) {
    this.root = root;
    local = Path.Combine(root, ".local");
    configPath = Path.Combine(local, "config.json");
    IntPtr handle = invoker.Handle; // Creates the window used to marshal calls back to the UI thread.
    webview = File.Exists(Path.Combine(root, "build", "desktop", "index.html")) && Web.Available(Path.Combine(root, "runtime"));

    int size = SystemInformation.SmallIconSize.Width;
    runningIcon = Logo.Create(size, Color.FromArgb(34, 197, 94));
    partialIcon = Logo.Create(size, Color.FromArgb(239, 68, 68));
    stoppedIcon = Logo.Create(size, Color.FromArgb(156, 163, 175));
    busyIcon = Logo.Create(size, Color.FromArgb(245, 158, 11));
    appIcon = Logo.Create(SystemInformation.IconSize.Width, Color.Empty);

    statusItem = new MenuItem("") {Enabled = false};
    openItem = new MenuItem("打开窗口", delegate {ShowWindow();}) {DefaultItem = true};
    copyItem = new MenuItem("复制连接链接", delegate {CopyLink();});
    toggleItem = new MenuItem("启动服务", delegate {ToggleService();});
    settingsItem = new MenuItem("连接设置…", delegate {OpenSettings();});
    signInItem = new MenuItem("登录 claude.ai…", delegate {ClaudeSignIn();});
    logsItem = new MenuItem("查看日志", delegate {OpenLogs();});
    autostartItem = new MenuItem("登录时自动启动", delegate {SetAutostart(!File.Exists(StartupLink));});
    exitItem = new MenuItem("退出", delegate {Exit();});
    menu.MenuItems.AddRange(new[] {
      statusItem, new MenuItem("-"), openItem, copyItem, new MenuItem("-"),
      toggleItem, settingsItem, signInItem, logsItem, new MenuItem("-"), autostartItem, new MenuItem("-"), exitItem
    });
    menu.Popup += delegate {autostartItem.Checked = File.Exists(StartupLink);};

    icon.ContextMenu = menu;
    icon.MouseClick += delegate(object sender, MouseEventArgs e) {if (e.Button == MouseButtons.Left) ShowWindow();};
    icon.BalloonTipClicked += delegate {if (balloonOpensLogs) OpenLogs();};
    state = ReadState();
    UpdateUi();
    icon.Visible = true;

    timer.Interval = 3000;
    timer.Tick += delegate {RefreshStatus();};
    timer.Start();
    healthTimer.Interval = 10000;
    healthTimer.Tick += delegate {CheckHealth();};
    healthTimer.Start();

    Thread listener = new Thread(delegate() {
      while (true) {show.WaitOne(); invoker.BeginInvoke((MethodInvoker)delegate {ShowWindow();});}
    });
    listener.IsBackground = true;
    listener.Start();

    invoker.BeginInvoke((MethodInvoker)delegate {Launch(background);});
  }

  bool Configured {get {return File.Exists(configPath);}}

  string StartupLink {
    get {return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Codex Mobile Web.lnk");}
  }

  async void Launch(bool background) {
    if (!Configured) {
      if (background) {Notify("尚未完成连接设置", "点击托盘图标完成设置后启动。", ToolTipIcon.Info, false); return;}
      if (webview) {ShowWindow(); return;}
      if (!await LegacyConfigure()) return;
    }
    quiet = background;
    if (!background && webview) ShowWindow();
    await Start(!background && !webview);
    quiet = false;
  }

  // ---- Window ------------------------------------------------------------------------------------------

  void ShowWindow() {
    if (!webview) {LegacyOpen(); return;}
    if (window == null || window.IsDisposed) {
      window = new DesktopWindow(root, appIcon);
      window.MessageReceived += OnPageMessage;
      window.Failed += delegate(string message) {
        Report("窗口无法打开", message + "\n\n将改用浏览器显示连接页面。");
        if (window != null) window.Close();
        LegacyOpen();
      };
      window.FormClosed += delegate {window = null; lastPosted = null;};
      lastPosted = null;
    }
    window.Reveal();
  }

  void PostToWindow(object message) {
    if (window != null && !window.IsDisposed) window.Post(message);
  }

  async void OnPageMessage(Dictionary<string, object> message) {
    string type = Text(message, "type");
    if (type == "ready") {
      lastPosted = null;
      // Reloaded on every open so changes made elsewhere show; before the first save the defaults carry the LAN relay address.
      await LoadConfig();
      PostState();
      CheckHealth();
    } else if (type == "start") {if (busy == null) await Start(false);}
    else if (type == "stop") {if (busy == null) await Stop();}
    else if (type == "exit") {
      if (busy != null) return;
      if (Equals(message.ContainsKey("stop") ? message["stop"] : null, true) && !await Stop()) return;
      Quit();
    } else if (type == "save") {
      Dictionary<string, object> settings = message.ContainsKey("settings") ? message["settings"] as Dictionary<string, object> : null;
      if (settings != null && busy == null) await Save(settings);
    } else if (type == "autostart") {
      SetAutostart(Equals(message.ContainsKey("enabled") ? message["enabled"] : null, true));
    } else if (type == "logs") OpenLogs();
    else if (type == "open") DesktopWindow.OpenExternal(Text(message, "url"));
    else if (type == "copy") {try {Clipboard.SetText(Text(message, "text"));} catch (Exception) {}}
    else if (type == "pick") Pick(Text(message, "field"));
    else if (type == "claudeSignIn") ClaudeSignIn();
    else if (type == "hide") {if (window != null) window.Close();}
  }

  static string Text(Dictionary<string, object> message, string key) {
    object value;
    return message.TryGetValue(key, out value) && value != null ? value.ToString() : "";
  }

  void PostState() {
    if (window == null || window.IsDisposed) return;
    Dictionary<string, object> body = new Dictionary<string, object>();
    body["service"] = busy ?? (state == ServiceState.Running ? "running" : state == ServiceState.Partial ? "partial" : "stopped");
    body["configured"] = Configured;
    body["error"] = lastError;
    body["autostart"] = File.Exists(StartupLink);
    body["config"] = config;
    string text = json.Serialize(body);
    if (text == lastPosted) return;
    lastPosted = text;
    Dictionary<string, object> message = new Dictionary<string, object>();
    message["type"] = "state";
    message["state"] = body;
    window.Post(message);
  }

  async void CheckHealth() {
    if (checkingHealth || window == null || window.IsDisposed || busy != null || state != ServiceState.Running) return;
    checkingHealth = true;
    try {
      ProcessResult result = await RunNode(new[] {"--status"}, null, 15000);
      if (result.Code != 0 || window == null || state != ServiceState.Running) return;
      Dictionary<string, object> message = new Dictionary<string, object>();
      message["type"] = "health";
      message["health"] = json.DeserializeObject(result.Output);
      PostToWindow(message);
    } catch (Exception) {
    } finally {checkingHealth = false;}
  }

  // Viewing the pages Claude publishes needs the connector's own browser signed in to claude.ai, once per computer.
  // The running connector opens the sign-in window on this screen; build/setup.mjs waits until the person is done.
  async void ClaudeSignIn() {
    if (signingIn) return;
    if (state != ServiceState.Running) {Notify("服务未运行", "请先启动服务，再登录 claude.ai。", ToolTipIcon.Info, false); return;}
    signingIn = true;
    UpdateUi();
    PostSignIn("started", null);
    Notify("请在弹出的窗口里登录 claude.ai", "这是连接器自己的浏览器，和平时用的 Chrome 分开。登录完成后窗口会自动关闭。用邮箱登录时，邮件里的链接在别的浏览器打开会显示验证码，填回这个窗口即可。", ToolTipIcon.Info, false);
    ProcessResult result = await RunNode(new[] {"--claude-signin"}, null, 16 * 60000);
    signingIn = false;
    UpdateUi();
    bool done = result.Code == 0 && result.Output != null && result.Output.Contains("\"signedIn\":true");
    string error = result.Code == 0 ? null : string.IsNullOrWhiteSpace(result.Error) ? "没能打开登录窗口" : result.Error.Trim();
    if (done) Notify("已登录 claude.ai", "现在可以在手机或浏览器里查看 Claude 发布的页面。", ToolTipIcon.None, false);
    else if (error != null) Notify("没能登录 claude.ai", error, ToolTipIcon.Warning, false);
    PostSignIn(done ? "done" : error != null ? "failed" : "closed", error);
    CheckHealth();
  }

  void PostSignIn(string status, string error) {
    Dictionary<string, object> message = new Dictionary<string, object>();
    message["type"] = "claudeSignIn";
    message["state"] = status;
    if (error != null) message["error"] = error;
    PostToWindow(message);
  }

  async Task LoadConfig() {
    ProcessResult result = await RunNode(new[] {"--defaults"}, null, 15000);
    if (result.Code != 0) return;
    try {config = json.DeserializeObject(result.Output) as Dictionary<string, object>;} catch (Exception) {}
  }

  void Pick(string field) {
    if (window == null) return;
    string path = null;
    if (field == "codexBin") {
      using (OpenFileDialog dialog = new OpenFileDialog()) {
        dialog.Title = "选择 Codex 程序";
        dialog.Filter = "Codex 可执行文件 (codex.exe)|codex.exe|可执行文件 (*.exe)|*.exe";
        if (dialog.ShowDialog(window) == DialogResult.OK) path = dialog.FileName;
      }
    } else if (field == "claudeBin") {
      using (OpenFileDialog dialog = new OpenFileDialog()) {
        dialog.Title = "选择 Claude Code 程序";
        dialog.Filter = "Claude Code 可执行文件 (claude.exe)|claude.exe|可执行文件 (*.exe)|*.exe";
        if (dialog.ShowDialog(window) == DialogResult.OK) path = dialog.FileName;
      }
    } else if (field == "codexHome") {
      using (FolderBrowserDialog dialog = new FolderBrowserDialog()) {
        dialog.Description = "选择 Codex 配置目录";
        if (dialog.ShowDialog(window) == DialogResult.OK) path = dialog.SelectedPath;
      }
    }
    if (path == null) return;
    Dictionary<string, object> message = new Dictionary<string, object>();
    message["type"] = "picked";
    message["field"] = field;
    message["path"] = path;
    PostToWindow(message);
  }

  void PostDialog(string name) {
    ShowWindow();
    Dictionary<string, object> message = new Dictionary<string, object>();
    message["type"] = "dialog";
    message["name"] = name;
    PostToWindow(message);
  }

  // ---- Menu actions ------------------------------------------------------------------------------------

  async void ToggleService() {
    if (busy != null) return;
    if (state == ServiceState.Running) {
      if (webview) {PostDialog("stop"); return;}
      if (Ask("停止后，电脑上由连接器管理的任务会被中断，手机也无法再连接这台电脑。\n\n确定停止服务吗？", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
      await Stop();
      return;
    }
    if (!Configured) {OpenSettings(); return;}
    await Start(false);
  }

  void OpenSettings() {
    if (busy != null) return;
    if (!webview) {LegacyChangeConfig(); return;}
    ShowWindow();
    Dictionary<string, object> message = new Dictionary<string, object>();
    message["type"] = "screen";
    message["name"] = "settings";
    PostToWindow(message);
  }

  async void CopyLink() {
    if (config == null && Configured) await LoadConfig();
    string link = ConnectionLink();
    if (link == null) {Notify("还没有连接链接", "请先完成连接设置。", ToolTipIcon.Info, false); return;}
    try {Clipboard.SetText(link); Notify("已复制连接链接", "在手机上打开它即可连接这台电脑。", ToolTipIcon.None, false);}
    catch (Exception) {}
  }

  string ConnectionLink() {
    if (config == null) return null;
    object relay, token;
    if (!config.TryGetValue("relayUrl", out relay) || !config.TryGetValue("token", out token) || relay == null || token == null) return null;
    Uri uri;
    if (!Uri.TryCreate(relay.ToString(), UriKind.Absolute, out uri)) return null;
    return new UriBuilder(uri) {Fragment = "token=" + Uri.EscapeDataString(token.ToString())}.Uri.AbsoluteUri;
  }

  async void SetAutostart(bool enable) {
    if (busy != null) return;
    ProcessResult result = await RunScript("autostart.ps1", enable ? "" : "-Disable", 30000);
    if (result.Code != 0) Report("自动启动设置失败", result.Error);
    lastPosted = null;
    PostState();
  }

  async void Exit() {
    if (busy != null) return;
    if (state == ServiceState.Stopped) {Quit(); return;}
    if (webview) {PostDialog("exit"); return;}
    DialogResult answer = Ask("退出时要同时停止服务吗？\n\n是：停止服务并退出（会中断连接器管理的任务）\n否：只退出图标，服务继续在后台运行", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
    if (answer == DialogResult.Cancel) return;
    if (answer == DialogResult.Yes && !await Stop()) return;
    Quit();
  }

  void Quit() {
    if (quitting) return;
    quitting = true;
    timer.Stop();
    healthTimer.Stop();
    if (window != null) window.Close();
    icon.Visible = false;
    ExitThread();
  }

  // ---- Service operations ------------------------------------------------------------------------------

  async Task Start(bool openPage) {
    lastError = null;
    SetBusy("starting");
    ProcessResult result = await RunScript("start.ps1", "-NoOpen", 120000);
    SetIdle();
    if (result.Code != 0) {
      lastError = string.IsNullOrEmpty(result.Error) ? "启动失败，请查看日志文件夹中的 *.error.log。" : result.Error;
      PostState();
      if (window == null || window.IsDisposed) Report("启动失败", lastError);
      return;
    }
    if (config == null) await LoadConfig();
    PostState();
    CheckHealth();
    if (openPage) LegacyOpenPage();
  }

  async Task<bool> Stop() {
    expectRunning = false;
    SetBusy("stopping");
    ProcessResult result = await RunScript("stop.ps1", "", 60000);
    SetIdle();
    if (result.Code != 0) {Report("停止失败", result.Error); return false;}
    return true;
  }

  async Task Save(Dictionary<string, object> settings) {
    bool wasRunning = state != ServiceState.Stopped;
    SetBusy("saving");
    if (wasRunning) {
      expectRunning = false;
      ProcessResult stopped = await RunScript("stop.ps1", "", 60000);
      if (stopped.Code != 0) {SetIdle(); SaveResult(false, "停止服务失败：" + stopped.Error); return;}
    }
    Dictionary<string, object> payload = new Dictionary<string, object>();
    foreach (string key in new[] {"mode", "relayUrl", "token", "codexBin", "codexHome", "claudeBin"}) payload[key] = settings.ContainsKey(key) ? settings[key] : "";
    ProcessResult saved = await RunNode(new[] {"--settings-stdin"}, json.Serialize(payload), 30000);
    SetIdle();
    if (saved.Code != 0) {
      string error = saved.Error.Trim();
      SaveResult(false, error.Length > 0 ? error : "配置未保存");
      if (wasRunning) await Start(false); // Bring the previous configuration back up.
      return;
    }
    await LoadConfig();
    SaveResult(true, null);
    await Start(false);
  }

  void SaveResult(bool ok, string error) {
    Dictionary<string, object> message = new Dictionary<string, object>();
    message["type"] = "saveResult";
    message["ok"] = ok;
    if (error != null) message["error"] = error;
    PostToWindow(message);
  }

  Task<ProcessResult> RunScript(string script, string arguments, int timeout) {
    string path = Path.Combine(root, "scripts", "windows", script);
    return Task.Run(delegate {
      string errorFile = Path.Combine(Path.GetTempPath(), "codex-mobile-web-" + Guid.NewGuid().ToString("N") + ".txt");
      string command =
        "$ErrorActionPreference='Stop'\n" +
        "try { $global:LASTEXITCODE=0; & " + Quote(path) + " " + arguments + " *> $null; exit [int]$LASTEXITCODE }\n" +
        "catch { [IO.File]::WriteAllText(" + Quote(errorFile) + ", $_.Exception.Message); exit 1 }";
      ProcessStartInfo info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "WindowsPowerShell\\v1.0\\powershell.exe"));
      info.Arguments = "-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand " + Convert.ToBase64String(Encoding.Unicode.GetBytes(command));
      info.WorkingDirectory = root;
      info.UseShellExecute = false;
      info.CreateNoWindow = true;
      ProcessResult result = new ProcessResult();
      try {
        // No redirected pipes here: start.ps1 leaves node running, and it would inherit them.
        using (Process process = Process.Start(info)) {
          if (!process.WaitForExit(timeout)) {
            try {process.Kill();} catch (Exception) {}
            result.Code = -1;
            result.Error = "操作超时，请打开日志文件夹查看原因。";
            return result;
          }
          result.Code = process.ExitCode;
        }
        if (File.Exists(errorFile)) result.Error = File.ReadAllText(errorFile, Encoding.UTF8).Trim();
      } catch (Exception error) {
        result.Code = -1;
        result.Error = error.Message;
      } finally {
        try {File.Delete(errorFile);} catch (Exception) {}
      }
      return result;
    });
  }

  // build/setup.mjs exits on its own, so its output can be read through pipes.
  Task<ProcessResult> RunNode(string[] setupArgs, string input, int timeout) {
    return Task.Run(delegate {
      ProcessResult result = new ProcessResult();
      string node = Path.Combine(root, "runtime", "node.exe");
      if (!File.Exists(node)) node = "node.exe";
      StringBuilder arguments = new StringBuilder("\"" + Path.Combine(root, "build", "setup.mjs") + "\"");
      foreach (string arg in setupArgs) arguments.Append(' ').Append(arg);
      ProcessStartInfo info = new ProcessStartInfo(node, arguments.ToString());
      info.WorkingDirectory = root;
      info.UseShellExecute = false;
      info.CreateNoWindow = true;
      info.RedirectStandardInput = true;
      info.RedirectStandardOutput = true;
      info.RedirectStandardError = true;
      info.StandardOutputEncoding = new UTF8Encoding(false);
      info.StandardErrorEncoding = new UTF8Encoding(false);
      try {
        using (Process process = Process.Start(info)) {
          Task<string> output = process.StandardOutput.ReadToEndAsync(), errors = process.StandardError.ReadToEndAsync();
          if (input != null) {
            byte[] bytes = new UTF8Encoding(false).GetBytes(input);
            process.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
          }
          process.StandardInput.Close();
          if (!process.WaitForExit(timeout)) {
            try {process.Kill();} catch (Exception) {}
            result.Code = -1;
            result.Error = "检查超时，请确认 Codex 可以正常启动。";
            return result;
          }
          result.Code = process.ExitCode;
          result.Output = output.Result;
          result.Error = errors.Result;
        }
      } catch (Exception error) {
        result.Code = -1;
        result.Error = error.Message;
      }
      return result;
    });
  }

  static string Quote(string value) {return "'" + value.Replace("'", "''") + "'";}

  void OpenLogs() {
    Directory.CreateDirectory(local);
    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + local + "\"") {UseShellExecute = true});
  }

  // ---- State -------------------------------------------------------------------------------------------

  void SetBusy(string kind) {busy = kind; UpdateUi();}
  void SetIdle() {busy = null; RefreshStatus();}

  void RefreshStatus() {
    ServiceState previous = state;
    state = ReadState();
    if (busy == null) {
      if (state == ServiceState.Running) expectRunning = true;
      else if (expectRunning) {
        expectRunning = false;
        Notify("服务已停止运行", "如果不是手动停止，点击这里查看日志。", ToolTipIcon.Warning, true);
      }
    }
    UpdateUi();
    if (previous != ServiceState.Running && state == ServiceState.Running) CheckHealth();
  }

  void UpdateUi() {
    string status;
    if (busy == "starting") {icon.Icon = busyIcon; status = "正在启动…";}
    else if (busy == "stopping") {icon.Icon = busyIcon; status = "正在停止…";}
    else if (busy == "saving") {icon.Icon = busyIcon; status = "正在保存设置…";}
    else if (state == ServiceState.Running) {icon.Icon = runningIcon; status = "运行中";}
    else if (state == ServiceState.Partial) {icon.Icon = partialIcon; status = "部分服务未运行";}
    else if (lastError != null) {icon.Icon = partialIcon; status = "启动失败";}
    else {icon.Icon = stoppedIcon; status = Configured ? "已停止" : "尚未设置";}
    string tip = Title + " · " + status;
    icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
    statusItem.Text = "● " + status;
    bool idle = busy == null;
    toggleItem.Text = state == ServiceState.Running ? "停止服务" : state == ServiceState.Partial ? "重新启动服务" : "启动服务";
    toggleItem.Enabled = idle;
    copyItem.Enabled = state == ServiceState.Running;
    settingsItem.Enabled = idle;
    signInItem.Enabled = idle && !signingIn && state == ServiceState.Running;
    autostartItem.Enabled = idle;
    exitItem.Enabled = idle;
    PostState();
  }

  ServiceState ReadState() {
    string mode = "all";
    try {
      Match match = Regex.Match(File.ReadAllText(configPath, Encoding.UTF8), "\"mode\"\\s*:\\s*\"(\\w+)\"");
      if (match.Success) mode = match.Groups[1].Value;
    } catch (Exception) {}
    string[] entries = mode == "connector" ? new[] {"connector"} : mode == "relay" ? new[] {"relay"} : new[] {"relay", "connector"};
    int alive = 0;
    foreach (string entry in entries) if (IsAlive(entry)) alive++;
    return alive == 0 ? ServiceState.Stopped : alive == entries.Length ? ServiceState.Running : ServiceState.Partial;
  }

  bool IsAlive(string entry) {
    try {
      string text = File.ReadAllText(Path.Combine(local, entry + ".pid")).Trim('﻿', ' ', '\r', '\n', '\t');
      int id;
      if (!int.TryParse(text, out id)) return false;
      using (Process process = Process.GetProcessById(id)) {
        return !process.HasExited && string.Equals(process.ProcessName, "node", StringComparison.OrdinalIgnoreCase);
      }
    } catch (Exception) {return false;}
  }

  void Report(string title, string message) {
    if (quiet || (window != null && !window.IsDisposed && window.Visible)) Notify(title, message, ToolTipIcon.Error, true);
    else Ask(title + "\n\n" + message, MessageBoxButtons.OK, MessageBoxIcon.Error);
  }

  void Notify(string title, string message, ToolTipIcon kind, bool opensLogs) {
    balloonOpensLogs = opensLogs;
    icon.ShowBalloonTip(10000, title, string.IsNullOrEmpty(message) ? " " : message, kind);
  }

  // ---- Fallback without the WebView2 runtime -----------------------------------------------------------

  async void LegacyOpen() {
    if (busy != null) return;
    if (state == ServiceState.Running) {LegacyOpenPage(); return;}
    if (!Configured && !await LegacyConfigure()) return;
    await Start(true);
  }

  void LegacyOpenPage() {
    string page = Path.Combine(local, "connect.html");
    if (!File.Exists(page)) {Report("找不到连接页面", "请先启动服务。"); return;}
    try {Process.Start(new ProcessStartInfo(page) {UseShellExecute = true});}
    catch (Exception error) {Report("无法打开连接页面", error.Message);}
  }

  async Task<bool> LegacyConfigure() {
    SetBusy("saving");
    ProcessResult result = await RunScript("configure.ps1", "", Timeout.Infinite);
    SetIdle();
    if (result.Code != 0 && !string.IsNullOrEmpty(result.Error)) Report("连接设置未完成", result.Error);
    config = null;
    return result.Code == 0;
  }

  async void LegacyChangeConfig() {
    bool wasRunning = state != ServiceState.Stopped;
    if (wasRunning) {
      if (Ask("修改连接设置需要先停止服务，会中断电脑上由连接器管理的任务。\n\n继续吗？", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
      if (!await Stop()) return;
    }
    bool saved = await LegacyConfigure();
    if (saved || wasRunning) await Start(saved);
  }

  // A tray app has no window of its own, so dialogs get a hidden topmost owner to appear in front.
  static DialogResult Ask(string text, MessageBoxButtons buttons, MessageBoxIcon kind) {
    using (Form owner = new Form()) {
      owner.TopMost = true;
      owner.ShowInTaskbar = false;
      owner.FormBorderStyle = FormBorderStyle.None;
      owner.StartPosition = FormStartPosition.Manual;
      owner.Location = new Point(-32000, -32000);
      owner.Size = new Size(1, 1);
      owner.Show();
      owner.Activate();
      return MessageBox.Show(owner, text, Title, buttons, kind);
    }
  }

  protected override void Dispose(bool disposing) {
    if (disposing) {timer.Dispose(); healthTimer.Dispose(); icon.Dispose(); menu.Dispose(); invoker.Dispose(); if (window != null) window.Dispose();}
    base.Dispose(disposing);
  }
}
