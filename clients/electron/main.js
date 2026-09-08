const { app, BrowserWindow, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

let gatewayPort = 0;
let gatewayProcess;
let logStream;
let mainWindow;

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function gatewayRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'gateway') : path.join(__dirname, 'gateway');
}

function waitForGateway(port, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => Date.now() - started >= timeoutMs ? reject(new Error('本地网关启动超时')) : setTimeout(probe, 250);
    probe();
  });
}

async function startGateway() {
  gatewayPort = await findFreePort();
  const root = gatewayRoot();
  const entry = path.join(root, 'src', 'server.js');
  if (!fs.existsSync(entry)) throw new Error(`缺少网关文件：${entry}`);
  const dataDir = path.join(app.getPath('userData'), 'gateway-data');
  fs.mkdirSync(dataDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'gateway.log'), { flags: 'a' });
  gatewayProcess = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: String(gatewayPort),
      LOCAL_MODEL_GATEWAY_FORCE_SETTINGS: 'true',
      LOCAL_MODEL_GATEWAY_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  gatewayProcess.on('exit', (code) => {
    if (code !== 0) logStream?.write(`[client] Local Model Gateway 子进程退出，代码：${code}\n`);
  });
  gatewayProcess.stdout?.pipe(logStream, { end: false });
  gatewayProcess.stderr?.pipe(logStream, { end: false });
}

function statusHtml(title, detail) {
  const safe = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#101315;color:#edf3ef;font:15px system-ui;display:grid;place-items:center;height:100vh}.box{max-width:680px;padding:34px;border:1px solid #303a3c;border-radius:14px;background:#171c1e}h1{font-size:24px}p{color:#98a6a1;line-height:1.7;white-space:pre-wrap}</style><div class="box"><h1>${safe(title)}</h1><p>${safe(detail)}</p></div>`)}`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    title: 'Local Model Gateway · Electron',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  await mainWindow.loadURL(statusHtml('正在启动本地模型网关', '正在准备内嵌 Node.js 服务，请稍候…'));
  try {
    await startGateway();
    await waitForGateway(gatewayPort);
    await mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/`);
  } catch (error) {
    const logPath = path.join(app.getPath('userData'), 'gateway.log');
    await mainWindow.loadURL(statusHtml('Local Model Gateway 启动失败', `${error.stack || error.message}\n\n诊断日志：${logPath}`));
  }
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Local Model Gateway 启动失败', error.stack || error.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (gatewayProcess) gatewayProcess.kill(); logStream?.end(); });