// System tray launcher for the Windows portable package.
// Compiled by scripts/package-windows.ts with the .NET Framework C# 5 compiler that ships with Windows,
// so it must stay within C# 5 (no string interpolation, no ?. operator, no expression-bodied members).
// All service work is delegated to the existing PowerShell scripts, which stay the single source of truth.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

static class Program {
  [STAThread]
  static int Main(string[] args) {
    if (args.Length == 2 && args[0] == "--write-icon") {Logo.WriteIco(args[1]); return 0;}
    bool background = Array.IndexOf(args, "--background") >= 0;
    string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
    string key = "Local\\CodexMobileWeb-" + Hash(root.ToLowerInvariant());
    bool created;
    using (Mutex mutex = new Mutex(true, key, out created)) {
      if (!created) {
        // Already running for this folder: ask that instance to show the connection page.
        if (!background) {try {EventWaitHandle.OpenExisting(key + "-show").Set();} catch (Exception) {}}
        return 0;
      }
      using (EventWaitHandle show = new EventWaitHandle(false, EventResetMode.AutoReset, key + "-show")) {
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

sealed class ScriptResult {
  public int Code;
  public string Error;
}

enum ServiceState {Stopped, Partial, Running}

sealed class TrayContext : ApplicationContext {
  const string Title = "Codex Mobile Web";
  readonly string root, local, configPath;
  readonly NotifyIcon icon = new NotifyIcon();
  readonly ContextMenuStrip menu = new ContextMenuStrip();
  readonly Control invoker = new Control();
  readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
  readonly ToolStripMenuItem statusItem, showItem, startItem, stopItem, configureItem, logsItem, autostartItem, exitItem;
  readonly Icon runningIcon, partialIcon, stoppedIcon, busyIcon;
  ServiceState state = ServiceState.Stopped;
  bool busy, quiet, expectRunning, balloonOpensLogs;
  string busyText = "";

  public TrayContext(string root, bool background, EventWaitHandle show) {
    this.root = root;
    local = Path.Combine(root, ".local");
    configPath = Path.Combine(local, "config.json");
    IntPtr handle = invoker.Handle; // Creates the window used to marshal calls back to the UI thread.

    int size = SystemInformation.SmallIconSize.Width;
    runningIcon = Logo.Create(size, Color.FromArgb(34, 197, 94));
    partialIcon = Logo.Create(size, Color.FromArgb(239, 68, 68));
    stoppedIcon = Logo.Create(size, Color.FromArgb(156, 163, 175));
    busyIcon = Logo.Create(size, Color.FromArgb(245, 158, 11));

    statusItem = new ToolStripMenuItem("") {Enabled = false};
    showItem = new ToolStripMenuItem("显示连接二维码", null, delegate {OpenOrStart();});
    showItem.Font = new Font(showItem.Font, FontStyle.Bold);
    startItem = new ToolStripMenuItem("启动服务", null, delegate {StartClicked();});
    stopItem = new ToolStripMenuItem("停止服务", null, delegate {StopClicked();});
    configureItem = new ToolStripMenuItem("修改连接配置…", null, delegate {ChangeConfig();});
    logsItem = new ToolStripMenuItem("打开日志文件夹", null, delegate {OpenLogs();});
    autostartItem = new ToolStripMenuItem("登录 Windows 时自动启动", null, delegate {ToggleAutostart();});
    exitItem = new ToolStripMenuItem("退出", null, delegate {Exit();});
    menu.Items.AddRange(new ToolStripItem[] {
      statusItem, new ToolStripSeparator(), showItem, new ToolStripSeparator(),
      startItem, stopItem, configureItem, logsItem, autostartItem, new ToolStripSeparator(), exitItem
    });
    menu.Opening += delegate {autostartItem.Checked = File.Exists(StartupLink);};

    icon.ContextMenuStrip = menu;
    icon.MouseClick += delegate(object sender, MouseEventArgs e) {if (e.Button == MouseButtons.Left) OpenOrStart();};
    icon.BalloonTipClicked += delegate {if (balloonOpensLogs) OpenLogs();};
    state = ReadState();
    UpdateUi();
    icon.Visible = true;

    timer.Interval = 3000;
    timer.Tick += delegate {RefreshStatus();};
    timer.Start();

    Thread listener = new Thread(delegate() {
      while (true) {show.WaitOne(); invoker.BeginInvoke((MethodInvoker)delegate {OpenOrStart();});}
    });
    listener.IsBackground = true;
    listener.Start();

    invoker.BeginInvoke((MethodInvoker)delegate {Launch(background);});
  }

  string StartupLink {
    get {return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "Codex Mobile Web.lnk");}
  }

  async void Launch(bool background) {
    if (!File.Exists(configPath)) {
      if (background) {Notify("尚未完成连接配置", "点击托盘图标完成配置后启动。", ToolTipIcon.Info, false); return;}
      if (!await Configure()) return;
    }
    quiet = background;
    await Start(!background);
    quiet = false;
  }

  async void OpenOrStart() {
    if (busy) return;
    if (state == ServiceState.Running) {OpenPage(); return;}
    if (!File.Exists(configPath) && !await Configure()) return;
    await Start(true);
  }

  async void StartClicked() {
    if (busy) return;
    if (!File.Exists(configPath) && !await Configure()) return;
    await Start(false);
  }

  async void StopClicked() {
    if (busy) return;
    if (Ask("停止后，电脑上由连接器管理的任务会被中断，手机也无法再连接这台电脑。\n\n确定停止服务吗？", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
    await Stop();
  }

  async void ChangeConfig() {
    if (busy) return;
    bool wasRunning = state != ServiceState.Stopped;
    if (wasRunning) {
      if (Ask("修改连接配置需要先停止服务，会中断电脑上由连接器管理的任务。\n\n继续吗？", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning) != DialogResult.OK) return;
      if (!await Stop()) return;
    }
    bool saved = await Configure();
    // Cancelled after stopping: bring the previous configuration back up.
    if (saved || wasRunning) await Start(saved);
  }

  async void ToggleAutostart() {
    if (busy) return;
    bool enabled = File.Exists(StartupLink);
    SetBusy(enabled ? "正在取消自动启动…" : "正在设置自动启动…");
    ScriptResult result = await RunScript("autostart.ps1", enabled ? "-Disable" : "", 30000);
    SetIdle();
    if (result.Code != 0) Report("自动启动设置失败", result.Error);
  }

  async void Exit() {
    if (busy) return;
    if (state != ServiceState.Stopped) {
      DialogResult answer = Ask("退出时要同时停止服务吗？\n\n是：停止服务并退出（会中断连接器管理的任务）\n否：只退出图标，服务继续在后台运行", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
      if (answer == DialogResult.Cancel) return;
      if (answer == DialogResult.Yes && !await Stop()) return;
    }
    timer.Stop();
    icon.Visible = false;
    ExitThread();
  }

  async Task<bool> Configure() {
    SetBusy("正在打开连接配置…");
    ScriptResult result = await RunScript("configure.ps1", "", Timeout.Infinite);
    SetIdle();
    // configure.ps1 shows its own errors and exits 1 when the window is closed without saving.
    if (result.Code != 0 && !string.IsNullOrEmpty(result.Error)) Report("连接配置未完成", result.Error);
    return result.Code == 0;
  }

  async Task Start(bool openPage) {
    SetBusy("正在启动…");
    ScriptResult result = await RunScript("start.ps1", "-NoOpen", 120000);
    SetIdle();
    if (result.Code != 0) {
      Report("启动失败", string.IsNullOrEmpty(result.Error) ? "请打开日志文件夹查看 *.error.log。" : result.Error);
      return;
    }
    if (openPage) OpenPage();
  }

  async Task<bool> Stop() {
    expectRunning = false;
    SetBusy("正在停止…");
    ScriptResult result = await RunScript("stop.ps1", "", 60000);
    SetIdle();
    if (result.Code != 0) {Report("停止失败", result.Error); return false;}
    return true;
  }

  Task<ScriptResult> RunScript(string script, string arguments, int timeout) {
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
      ScriptResult result = new ScriptResult();
      try {
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

  static string Quote(string value) {return "'" + value.Replace("'", "''") + "'";}

  void OpenPage() {
    string page = Path.Combine(local, "connect.html");
    if (!File.Exists(page)) {Report("找不到连接页面", "请先启动服务。"); return;}
    try {Process.Start(new ProcessStartInfo(page) {UseShellExecute = true});}
    catch (Exception error) {Report("无法打开连接页面", error.Message);}
  }

  void OpenLogs() {
    Directory.CreateDirectory(local);
    Process.Start(new ProcessStartInfo("explorer.exe", "\"" + local + "\"") {UseShellExecute = true});
  }

  void SetBusy(string text) {busy = true; busyText = text; UpdateUi();}
  void SetIdle() {busy = false; RefreshStatus();}

  void RefreshStatus() {
    state = ReadState();
    if (!busy) {
      if (state == ServiceState.Running) expectRunning = true;
      else if (expectRunning) {
        expectRunning = false;
        Notify("服务已停止运行", "如果不是手动停止，点击这里查看日志。", ToolTipIcon.Warning, true);
      }
    }
    UpdateUi();
  }

  void UpdateUi() {
    string status;
    if (busy) {icon.Icon = busyIcon; status = busyText;}
    else if (state == ServiceState.Running) {icon.Icon = runningIcon; status = "运行中";}
    else if (state == ServiceState.Partial) {icon.Icon = partialIcon; status = "部分服务未运行";}
    else {icon.Icon = stoppedIcon; status = File.Exists(configPath) ? "已停止" : "尚未配置";}
    string tip = Title + " · " + status;
    icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
    statusItem.Text = status;
    showItem.Enabled = !busy;
    startItem.Enabled = !busy && state != ServiceState.Running;
    stopItem.Enabled = !busy && state != ServiceState.Stopped;
    configureItem.Enabled = !busy;
    autostartItem.Enabled = !busy;
    exitItem.Enabled = !busy;
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
    if (quiet) Notify(title, message, ToolTipIcon.Error, true);
    else Ask(title + "\n\n" + message, MessageBoxButtons.OK, MessageBoxIcon.Error);
  }

  void Notify(string title, string message, ToolTipIcon kind, bool opensLogs) {
    balloonOpensLogs = opensLogs;
    icon.ShowBalloonTip(10000, title, string.IsNullOrEmpty(message) ? " " : message, kind);
  }

  // A tray app has no window, so dialogs get a hidden topmost owner to appear in front.
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
    if (disposing) {timer.Dispose(); icon.Dispose(); menu.Dispose(); invoker.Dispose();}
    base.Dispose(disposing);
  }
}

static class Logo {
  static readonly Color Ink = Color.FromArgb(17, 17, 17);

  // Same artwork as web/public/icon.svg (192 unit canvas), with an optional status dot.
  public static void Draw(Graphics g, int size, Color dot) {
    g.SmoothingMode = SmoothingMode.AntiAlias;
    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
    g.Clear(Color.Transparent);
    float s = size / 192f;
    using (GraphicsPath path = Rounded(new RectangleF(0, 0, size, size), 44 * s))
    using (SolidBrush brush = new SolidBrush(Ink)) g.FillPath(brush, path);
    using (Pen pen = new Pen(Color.White, Math.Max(12 * s, 1.75f))) {
      pen.StartCap = LineCap.Round;
      pen.EndCap = LineCap.Round;
      pen.LineJoin = LineJoin.Round;
      g.DrawLines(pen, new[] {P(73, 62, s), P(40, 96, s), P(73, 130, s)});
      g.DrawLines(pen, new[] {P(119, 62, s), P(152, 96, s), P(119, 130, s)});
    }
    if (dot.IsEmpty) return;
    float d = size * 0.4f, ring = Math.Max(size * 0.07f, 1f);
    using (SolidBrush brush = new SolidBrush(Ink)) g.FillEllipse(brush, size - d - ring, size - d - ring, d + ring * 2, d + ring * 2);
    using (SolidBrush brush = new SolidBrush(dot)) g.FillEllipse(brush, size - d, size - d, d - 0.5f, d - 0.5f);
  }

  public static Icon Create(int size, Color dot) {
    using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(bitmap)) Draw(g, size, dot);
      return Icon.FromHandle(bitmap.GetHicon());
    }
  }

  // Writes a multi-size .ico (PNG entries) used as the executable's own icon.
  public static void WriteIco(string path) {
    int[] sizes = {16, 20, 24, 32, 40, 48, 64, 256};
    List<byte[]> images = new List<byte[]>();
    foreach (int size in sizes) {
      using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
      using (MemoryStream stream = new MemoryStream()) {
        using (Graphics g = Graphics.FromImage(bitmap)) Draw(g, size, Color.Empty);
        bitmap.Save(stream, ImageFormat.Png);
        images.Add(stream.ToArray());
      }
    }
    using (BinaryWriter writer = new BinaryWriter(File.Create(path))) {
      writer.Write((short)0);
      writer.Write((short)1);
      writer.Write((short)sizes.Length);
      int offset = 6 + 16 * sizes.Length;
      for (int i = 0; i < sizes.Length; i++) {
        byte edge = (byte)(sizes[i] >= 256 ? 0 : sizes[i]);
        writer.Write(edge);
        writer.Write(edge);
        writer.Write((byte)0);
        writer.Write((byte)0);
        writer.Write((short)1);
        writer.Write((short)32);
        writer.Write(images[i].Length);
        writer.Write(offset);
        offset += images[i].Length;
      }
      foreach (byte[] image in images) writer.Write(image);
    }
  }

  static PointF P(float x, float y, float s) {return new PointF(x * s, y * s);}

  static GraphicsPath Rounded(RectangleF r, float radius) {
    float d = radius * 2;
    GraphicsPath path = new GraphicsPath();
    path.AddArc(r.X, r.Y, d, d, 180, 90);
    path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    path.CloseFigure();
    return path;
  }
}
