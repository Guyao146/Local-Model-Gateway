using System.Diagnostics;
using System.Net.Http;
using System.Net;
using System.Net.Sockets;
using Microsoft.Web.WebView2.WinForms;

namespace LocalModelGateway.WebView2;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new GatewayForm());
    }
}

internal sealed class GatewayForm : Form
{
    private int port;
    private readonly Microsoft.Web.WebView2.WinForms.WebView2 webView = new() { Dock = DockStyle.Fill };
    private readonly Label status = new()
    {
        Dock = DockStyle.Fill,
        Text = "正在启动本地模型网关…",
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 14),
        ForeColor = Color.FromArgb(237, 243, 239),
        BackColor = Color.FromArgb(16, 19, 21)
    };
    private Process? gateway;
    private readonly object logLock = new();
    private string logPath = "";

    public GatewayForm()
    {
        Text = "Local Model Gateway · Edge WebView2";
        Width = 1220;
        Height = 860;
        MinimumSize = new Size(880, 620);
        Controls.Add(webView);
        Controls.Add(status);
        status.BringToFront();
        Shown += async (_, _) => await StartAsync();
        FormClosing += (_, _) => StopGateway();
    }

    private async Task StartAsync()
    {
        try
        {
            port = await FindFreePortAsync();
            string root = AppContext.BaseDirectory;
            string node = Path.Combine(root, "runtime", "node.exe");
            string gatewayRoot = Path.Combine(root, "gateway");
            string entry = Path.Combine(gatewayRoot, "src", "server.js");
            if (!File.Exists(node) || !File.Exists(entry)) throw new FileNotFoundException("客户端缺少 Node.js 运行时或网关文件。");
            string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalModelGateway", "gateway-data");
            Directory.CreateDirectory(data);
            logPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalModelGateway", "gateway.log");
            var start = new ProcessStartInfo(node, $"\"{entry}\"")
            {
                WorkingDirectory = gatewayRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.Environment["HOST"] = "127.0.0.1";
            start.Environment["PORT"] = port.ToString();
            start.Environment["LOCAL_MODEL_GATEWAY_FORCE_HOST"] = "127.0.0.1";
            start.Environment["LOCAL_MODEL_GATEWAY_FORCE_PORT"] = port.ToString();
            start.Environment["LOCAL_MODEL_GATEWAY_FORCE_SETTINGS"] = "true";
            start.Environment["LOCAL_MODEL_GATEWAY_DATA_DIR"] = data;
            gateway = Process.Start(start) ?? throw new InvalidOperationException("无法启动本地网关进程。");
            gateway.EnableRaisingEvents = true;
            gateway.Exited += (_, _) =>
            {
                if (gateway.ExitCode != 0 && IsHandleCreated)
                    BeginInvoke(() => status.Text = $"Local Model Gateway 启动失败\n\n网关子进程已退出（代码 {gateway.ExitCode}）。\n\n请查看：\n{logPath}");
            };
            gateway.OutputDataReceived += (_, args) => AppendLog(args.Data);
            gateway.ErrorDataReceived += (_, args) => AppendLog(args.Data);
            gateway.BeginOutputReadLine();
            gateway.BeginErrorReadLine();
            await WaitForGatewayAsync();
            string webData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalModelGateway", "webview2");
            var environment = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, webData);
            await webView.EnsureCoreWebView2Async(environment);
            status.Visible = false;
            webView.CoreWebView2.Navigate($"http://127.0.0.1:{port}/");
        }
        catch (Exception error)
        {
            status.Text = $"Local Model Gateway 启动失败\n\n{error.Message}\n\n请确认客户端文件完整，并查看：\n{logPath}";
        }
    }

    private static async Task<int> FindFreePortAsync()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int selected = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        await Task.Yield();
        return selected;
    }

    private async Task WaitForGatewayAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
        for (int attempt = 0; attempt < 80; attempt++)
        {
            try { if ((await client.GetAsync($"http://127.0.0.1:{port}/health")).IsSuccessStatusCode) return; } catch { }
            await Task.Delay(250);
        }
        throw new TimeoutException("本地网关启动超时。");
    }

    private void StopGateway()
    {
        try { if (gateway is { HasExited: false }) gateway.Kill(true); } catch { }
        gateway?.Dispose();
    }

    private void AppendLog(string? line)
    {
        if (string.IsNullOrWhiteSpace(line) || string.IsNullOrWhiteSpace(logPath)) return;
        Debug.WriteLine(line);
        lock (logLock) File.AppendAllText(logPath, $"{line}{Environment.NewLine}");
    }
}