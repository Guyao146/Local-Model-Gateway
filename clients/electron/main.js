const { app, BrowserWindow, dialog, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = 8787;
let gatewayProcess;

function gatewayRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'gateway') : path.join(__dirname, 'gateway');
}

function waitForGateway(timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(`http://127.0.0.1:${PORT}/health`, (response) => {
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

function startGateway() {
  const root = gatewayRoot();
  const entry = path.join(root, 'src', 'server.js');
  if (!fs.existsSync(entry)) throw new Error(`缺少网关文件：${entry}`);
  const dataDir = path.join(app.getPath('userData'), 'gateway-data');
  fs.mkdirSync(dataDir, { recursive: true });
  gatewayProcess = utilityProcess.fork(entry, [], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT), LOCAL_MODEL_GATEWAY_DATA_DIR: dataDir },
    stdio: 'pipe',
    serviceName: 'Local Model Gateway'
  });
  gatewayProcess.stdout?.on('data', (chunk) => console.log(chunk.toString().trimEnd()));
  gatewayProcess.stderr?.on('data', (chunk) => console.error(chunk.toString().trimEnd()));
}

async function createWindow() {
  startGateway();
  await waitForGateway();
  const window = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    title: 'Local Model Gateway · Electron',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  await window.loadURL(`http://127.0.0.1:${PORT}/`);
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Local Model Gateway 启动失败', error.stack || error.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (gatewayProcess) gatewayProcess.kill(); });