// Original Windows launcher. No execution-policy changes or administrator install.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Drawing;

internal static class Launcher {
    private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1048576 };
    private static void CheckLink(string p) { if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) throw new Exception("Linked package paths are unsupported"); }
    private static string Full(string relative) {
        if (String.IsNullOrEmpty(relative) || relative.IndexOfAny(new[] {'\\', ':', '\0'}) >= 0) throw new Exception("Unsafe package member");
        foreach (string part in relative.Split('/')) if (part == "" || part == "." || part == "..") throw new Exception("Unsafe package path");
        string full = Path.GetFullPath(Path.Combine(Root, relative));
        if (!full.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Path traversal");
        string current = Root; CheckLink(current); foreach (string part in relative.Split('/')) { current = Path.Combine(current, part); CheckLink(current); } return full;
    }
    private static string Digest(string file) { using (var sha = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    private static Dictionary<string, object> Verify() {
        string file = Full("manifest.json"); if (new FileInfo(file).Length > 1048576) throw new Exception("Manifest exceeds budget");
        var manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
        if (Convert.ToInt32(manifest["format"]) != 1 || (string)manifest["platform"] != "win32") throw new Exception("Invalid package platform");
        var files = (Dictionary<string, object>)manifest["files"]; if (files.Count > 128) throw new Exception("Package file budget exceeded");
        foreach (var item in files) { string exact = Full(item.Key); long limit = item.Key == "runtime/node.exe" ? 268435456L : 16777216L; if (new FileInfo(exact).Length > limit || !Regex.IsMatch((string)item.Value, "^[a-f0-9]{64}$") || Digest(exact) != (string)item.Value) throw new Exception("Package checksum mismatch"); }
        if (!files.ContainsKey("runtime/node.exe") || !files.ContainsKey("MoonRestore.exe")) throw new Exception("Use the desktop package with embedded runtime"); return manifest;
    }
    private static Process StartHost() {
        var p = new Process(); p.StartInfo.FileName = Full("runtime/node.exe"); p.StartInfo.Arguments = "\"" + Full("scripts/desktop-host.mjs") + "\"";
        p.StartInfo.WorkingDirectory = Root; p.StartInfo.UseShellExecute = false; p.StartInfo.CreateNoWindow = true; p.StartInfo.RedirectStandardInput = true; p.StartInfo.RedirectStandardOutput = true; p.StartInfo.RedirectStandardError = true;
        if (String.IsNullOrEmpty(Environment.GetEnvironmentVariable("MOONRESTORE_HOME"))) p.StartInfo.EnvironmentVariables["MOONRESTORE_HOME"] = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MoonRestoreState");
        p.Start(); p.BeginErrorReadLine(); return p;
    }
    private static string Address(Process p) { Task<string> line = p.StandardOutput.ReadLineAsync(); if (!line.Wait(20000)) throw new Exception("Workbench startup timed out"); var data = Json.Deserialize<Dictionary<string, object>>(line.Result ?? "{}"); string url = (string)data["url"]; if (!Regex.IsMatch(url, "^http://127\\.0\\.0\\.1:[0-9]+/#[a-f0-9]{64}$")) throw new Exception("Invalid local session"); return url; }
    private static void Stop(Process p) { if (p == null) return; try { if (!p.HasExited) { try { p.StandardInput.WriteLine("stop"); } catch {} if (!p.WaitForExit(20000)) p.Kill(); } } catch {} finally { p.Dispose(); } }
    private static void Open(string url) { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
    private static string InstallTarget(Dictionary<string, object> manifest) {
        string version = (string)manifest["version"]; if (!Regex.IsMatch(version, "^\\d+\\.\\d+\\.\\d+$")) throw new Exception("Invalid release version");
        string parent = Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MoonRestore")); string target = Path.GetFullPath(Path.Combine(parent, version));
        if (Path.GetDirectoryName(target) != parent) throw new Exception("Unsafe installation path");
        for (string ancestor = parent; !String.IsNullOrEmpty(ancestor); ancestor = Path.GetDirectoryName(ancestor)) if (Directory.Exists(ancestor)) CheckLink(ancestor); return target;
    }
    private static void Install(Dictionary<string, object> manifest) {
        string target = InstallTarget(manifest), desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "MoonRestore.lnk");
        if (Directory.Exists(target) || File.Exists(desktop)) throw new Exception("Version or desktop shortcut already exists; nothing overwritten");
        if (MessageBox.Show("Install for this user and create a desktop shortcut? No backup or system schedule will be created.", "MoonRestore", MessageBoxButtons.YesNo) != DialogResult.Yes) return;
        Directory.CreateDirectory(target);
        foreach (var item in (Dictionary<string, object>)manifest["files"]) { string destination = Path.Combine(target, item.Key); Directory.CreateDirectory(Path.GetDirectoryName(destination)); File.Copy(Full(item.Key), destination, false); }
        File.Copy(Full("manifest.json"), Path.Combine(target, "manifest.json"), false);
        Type shellType = Type.GetTypeFromProgID("WScript.Shell"); object shell = Activator.CreateInstance(shellType); object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] {desktop}); Type type = shortcut.GetType();
        type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] {Path.Combine(target, "MoonRestore.exe")}); type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] {target}); type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
        MessageBox.Show("Installed. Backups remain wherever you explicitly configure them.", "MoonRestore");
    }
    [STAThread] private static int Main(string[] args) {
        bool check = args.Length == 1 && (args[0] == "--check" || args[0] == "--host-check" || args[0] == "--install-check"); Process host = null;
        try {
            var manifest = Verify(); if (args.Length == 1 && args[0] == "--check") return 0; if (args.Length == 1 && args[0] == "--install-check") { InstallTarget(manifest); return 0; } if (args.Length == 1 && args[0] == "--install") { Install(manifest); return 0; }
            if (args.Length > 0 && args[0] != "--host-check") throw new Exception("Unknown launcher argument");
            if (check) { host = StartHost(); string address = Address(host); using (var client = new WebClient()) { var uri = new Uri(address); client.Headers["Authorization"] = "Bearer " + uri.Fragment.Substring(1); if (!client.DownloadString(uri.GetLeftPart(UriPartial.Authority) + "/api/jobs").Contains("\"ok\":true")) throw new Exception("Desktop transport check failed"); } return 0; }
            string home = Environment.GetEnvironmentVariable("MOONRESTORE_HOME") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MoonRestoreState"), suffix;
            home = Path.GetFullPath(home).TrimEnd(Path.DirectorySeparatorChar).ToLowerInvariant();
            using (var sha = SHA256.Create()) suffix = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(home))).Replace("-", "");
            bool owns; using (var mutex = new Mutex(true, "Local\\MoonRestore-" + suffix, out owns)) {
                if (!owns) { MessageBox.Show("MoonRestore is already running. Open it from its system tray icon.", "MoonRestore"); return 0; }
                try { host = StartHost(); string address = Address(host); Application.EnableVisualStyles(); using (var tray = new NotifyIcon()) using (var menu = new ContextMenuStrip()) { tray.Icon = SystemIcons.Application; tray.Text = "MoonRestore - local backup"; menu.Items.Add("Open workbench", null, (sender,e) => Open(address)); menu.Items.Add("Stop safely and exit", null, (sender,e) => Application.Exit()); tray.DoubleClick += (sender,e) => Open(address); tray.ContextMenuStrip = menu; tray.Visible = true; Open(address); Application.Run(); tray.Visible = false; } } finally { mutex.ReleaseMutex(); }
            }
            return 0;
        } catch (Exception error) { if (!check) MessageBox.Show(error.Message, "MoonRestore", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; } finally { Stop(host); }
    }
}
