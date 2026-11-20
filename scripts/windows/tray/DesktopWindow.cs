// The desktop window: a native frame hosting build/desktop/index.html in WebView2.
// Every WebView2 type lives in this file so the tray can run (and fall back) when the runtime is missing.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

static class Web {
  // Must run before any other WebView2 call: the loader DLL ships in runtime\, not next to the exe.
  [MethodImpl(MethodImplOptions.NoInlining)]
  public static bool Available(string runtimeDir) {
    try {
      CoreWebView2Environment.SetLoaderDllFolderPath(runtimeDir);
      return !string.IsNullOrEmpty(CoreWebView2Environment.GetAvailableBrowserVersionString());
    } catch (Exception) {return false;}
  }
}

sealed class DesktopWindow : Form {
  const string Origin = "http://codex-mobile-web.example/";
  readonly string pageDir, dataDir;
  readonly Queue<string> pending = new Queue<string>();
  readonly JavaScriptSerializer json = new JavaScriptSerializer();
  CoreWebView2Controller controller;
  bool ready;

  public event Action<Dictionary<string, object>> MessageReceived;
  public event Action<string> Failed;

  public DesktopWindow(string root, Icon icon) {
    pageDir = Path.Combine(root, "build", "desktop");
    dataDir = Path.Combine(root, ".local", "webview2");
    Text = "Codex 随行";
    Icon = icon;
    StartPosition = FormStartPosition.CenterScreen;
    float scale;
    using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
    ClientSize = new Size((int)(480 * scale), (int)(760 * scale));
    MinimumSize = new Size((int)(420 * scale), (int)(560 * scale));
    ApplyTheme();
    SystemEvents.UserPreferenceChanged += OnPreferenceChanged;
  }

  static bool Dark {
    get {
      try {
        object value = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
        return value is int && (int)value == 0;
      } catch (Exception) {return false;}
    }
  }

  void OnPreferenceChanged(object sender, UserPreferenceChangedEventArgs e) {
    if (e.Category == UserPreferenceCategory.General && !IsDisposed) BeginInvoke((MethodInvoker)ApplyTheme);
  }

  // Title bar and border take the page's background colour so the window reads as one surface.
  void ApplyTheme() {
    bool dark = Dark;
    BackColor = dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(247, 247, 247);
    if (controller != null) controller.DefaultBackgroundColor = BackColor;
    if (!IsHandleCreated) return;
    int on = dark ? 1 : 0, caption = ColorRef(BackColor), border = ColorRef(dark ? Color.FromArgb(58, 58, 58) : Color.FromArgb(220, 220, 220));
    try {
      DwmSetWindowAttribute(Handle, 20, ref on, 4);       // DWMWA_USE_IMMERSIVE_DARK_MODE
      DwmSetWindowAttribute(Handle, 35, ref caption, 4);  // DWMWA_CAPTION_COLOR (Windows 11)
      DwmSetWindowAttribute(Handle, 34, ref border, 4);   // DWMWA_BORDER_COLOR (Windows 11)
    } catch (Exception) {}
  }

  static int ColorRef(Color color) {return color.R | (color.G << 8) | (color.B << 16);}

  [DllImport("dwmapi.dll")]
  static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    ApplyTheme();
  }

  protected override async void OnLoad(EventArgs e) {
    base.OnLoad(e);
    try {
      CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, dataDir, null);
      if (IsDisposed) return;
      controller = await environment.CreateCoreWebView2ControllerAsync(Handle);
      if (IsDisposed) {controller.Close(); return;}
      controller.DefaultBackgroundColor = BackColor;
      controller.Bounds = ClientRectangle;
      controller.IsVisible = true;
      CoreWebView2 core = controller.CoreWebView2;
      CoreWebView2Settings settings = core.Settings;
      settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("CODEX_MOBILE_WEB_DEVTOOLS") == "1";
      settings.AreDefaultContextMenusEnabled = false;
      settings.IsStatusBarEnabled = false;
      settings.IsZoomControlEnabled = false;
      settings.AreBrowserAcceleratorKeysEnabled = false;
      settings.IsPasswordAutosaveEnabled = false;
      settings.IsGeneralAutofillEnabled = false;
      core.SetVirtualHostNameToFolderMapping("codex-mobile-web.example", pageDir, CoreWebView2HostResourceAccessKind.Deny);
      core.WebMessageReceived += OnWebMessage;
      core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs args) {
        if (args.Uri.StartsWith(Origin, StringComparison.OrdinalIgnoreCase)) return;
        args.Cancel = true;
        OpenExternal(args.Uri);
      };
      core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args) {
        args.Handled = true;
        OpenExternal(args.Uri);
      };
      core.ProcessFailed += delegate {ready = false; if (!IsDisposed) core.Reload();};
      core.Navigate(Origin + "index.html");
    } catch (Exception error) {
      if (Failed != null) Failed(error.Message);
    }
  }

  void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
    Dictionary<string, object> message;
    try {message = json.DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>;}
    catch (Exception) {return;}
    if (message == null) return;
    if (Equals(message.ContainsKey("type") ? message["type"] : null, "ready")) {
      ready = true;
      while (pending.Count > 0) controller.CoreWebView2.PostWebMessageAsJson(pending.Dequeue());
    }
    if (MessageReceived != null) MessageReceived(message);
  }

  // Messages sent before the page says it is ready are queued, so menu actions can open the window and act at once.
  public void Post(object message) {
    string text = json.Serialize(message);
    if (ready && controller != null) controller.CoreWebView2.PostWebMessageAsJson(text);
    else pending.Enqueue(text);
  }

  public static void OpenExternal(string url) {
    Uri uri;
    if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return;
    try {Process.Start(new ProcessStartInfo(uri.AbsoluteUri) {UseShellExecute = true});} catch (Exception) {}
  }

  public void Reveal() {
    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
    Show();
    Activate();
  }

  protected override void OnResize(EventArgs e) {
    base.OnResize(e);
    if (controller != null) controller.Bounds = ClientRectangle;
  }

  protected override void OnMove(EventArgs e) {
    base.OnMove(e);
    if (controller != null) controller.NotifyParentWindowPositionChanged();
  }

  protected override void Dispose(bool disposing) {
    if (disposing) {
      SystemEvents.UserPreferenceChanged -= OnPreferenceChanged;
      if (controller != null) {controller.Close(); controller = null;}
    }
    base.Dispose(disposing);
  }
}
