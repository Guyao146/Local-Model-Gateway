using System.Diagnostics;
using System.Net.Http;
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
    private const int Port = 8787;
    private readonly Microsoft.Web.WebView2.WinForms.WebView2 webView = new() { Dock = DockStyle.Fill };
    private Process? gateway;

    public GatewayForm()
    {
        Text = "Local Model Gateway · Edge WebView2";
        Width = 1220;
        Height = 860;
        MinimumSize = new Size(880, 620);
        Controls.Add(webView);
        Shown += async (_, _) => await StartAsync();
        FormClosing += (_, _) => StopGateway();
    }

    private async Task StartAsync()
    {
        try
        {
            string root = AppContext.BaseDirectory;
            string node = Path.Combine(root, "runtime", "node.exe");
            string gatewayRoot = Path.Combine(root, "gateway");
            string entry = Path.Combine(gatewayRoot, "src", "server.js");
            if (!File.Exists(node) || !File.Exists(entry)) throw new FileNotFoundException("客户端缺少 Node.js 运行时或网关文件。");
            string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalModelGateway", "gateway-data");
            Directory.CreateDirectory(data);
            var start = new ProcessStartInfo(node, $"\"{entry}\"")
            {
                WorkingDirectory = gatewayRoot,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.Environment["HOST"] = "127.0.0.1";
            start.Environment["PORT"] = Port.ToString();
            start.Environment["LOCAL_MODEL_GATEWAY_DATA_DIR"] = data;
            gateway = Process.Start(start) ?? throw new InvalidOperationException("无法启动本地网关进程。");
            await WaitForGatewayAsync();
            string webData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalModelGateway", "webview2");
            var environment = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, webData);
            await webView.EnsureCoreWebView2Async(environment);
            webView.CoreWebView2.Navigate($"http://127.0.0.1:{Port}/");
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.ToString(), "Local Model Gateway 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private static async Task WaitForGatewayAsync()
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
        for (int attempt = 0; attempt < 80; attempt++)
        {
            try { if ((await client.GetAsync($"http://127.0.0.1:{Port}/health")).IsSuccessStatusCode) return; } catch { }
            await Task.Delay(250);
        }
        throw new TimeoutException("本地网关启动超时。");
    }

    private void StopGateway()
    {
        try { if (gateway is { HasExited: false }) gateway.Kill(true); } catch { }
        gateway?.Dispose();
    }
}