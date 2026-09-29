// 可选真实 Chrome 冒烟测试：GATEWAY_BROWSER_TEST=1 node test/modalities.integration.test.js
// 仅 Node 22+（内置 WebSocket），不引入浏览器自动化依赖。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');

module.exports = async function browserSmoke(base, upstreamId) {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert(fs.existsSync(chrome), '设置 CHROME_PATH 为本机 Chrome 路径');
  assert.equal(typeof WebSocket, 'function', '浏览器测试需要内置 WebSocket');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-modality-browser-'));
  const child = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket;
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i += 1) await pause(50);
    assert(fs.existsSync(portFile), 'Chrome 未启动调试端口');
    const debugPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    let serial = 0;
    const pending = new Map();
    const exceptions = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
      if (!message.id) return;
      const task = pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async (expression) => {
      for (let i = 0; i < 200; i += 1) {
        if (await evaluate(expression)) return;
        await pause(50);
      }
      throw new Error(`浏览器等待超时：${expression}`);
    };
    await cdp('Runtime.enable');
    await waitFor('Boolean(document.querySelector("[data-action=modality-translator]"))');
    assert.equal(await evaluate('document.querySelector(".model-modalities").textContent.includes("输入")'), true);
    assert.equal(await evaluate('document.querySelector("[data-action=modality-translator]").value'), 'captioner');
    assert.deepEqual(await evaluate('[...document.querySelector("[data-model-key=reasoning-extra] [data-action=thinking-level]").options].map(option => option.value)'), ['client', 'auto', 'off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    await evaluate('document.querySelector("[data-action=modality-translator]").value = "anthropic-captioner"; document.querySelector("[data-action=modality-translator]").dispatchEvent(new Event("change", {bubbles:true})); saveModelSelections()');
    const config = await (await fetch(`${base}/api/admin/config`)).json();
    assert.equal(config.modelSelections[0].modalityTranslator, 'anthropic-captioner');
    await evaluate('document.querySelector("[data-action=modality-translator]").value = "captioner"; document.querySelector("[data-action=modality-translator]").dispatchEvent(new Event("change", {bubbles:true})); saveModelSelections()');
    await evaluate('refreshModelCapabilities(document.querySelector("[data-model-key=plain] [data-action=refresh-capabilities]"))');
    assert.equal(await evaluate('document.querySelector("[data-model-key=plain] .model-modalities").textContent.includes("文本")'), true);
    await evaluate('fillRouteForm()');
    assert.equal(await evaluate('document.querySelector("#routeModalityTranslator").options.length > 1'), true);
    await evaluate(`document.querySelector('#localModel').value = 'browser-target'; document.querySelector('#routeUpstreamId').value = ${JSON.stringify(upstreamId)}; document.querySelector('#routeUpstreamModel').value = 'plain'; document.querySelector('#routeModalityTranslator').value = 'captioner'; saveRoute({preventDefault(){}})`);
    const updated = await (await fetch(`${base}/api/admin/config`)).json();
    assert.equal(updated.routes.find((route) => route.localModel === 'browser-target').modalityTranslator, 'captioner');
    await evaluate('fillRouteForm(state.config.routes.find(route => route.localModel === "browser-target"))');
    assert.equal(await evaluate('document.querySelector("#routeModalityTranslator").value'), 'captioner');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.equal(await evaluate('Boolean(document.querySelector("#routeModalityTranslator"))'), true);
    assert.deepEqual(exceptions, []);
    console.log('modality browser smoke tests passed');
  } finally {
    socket?.close();
    if (child.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
      } else child.kill();
    }
    await pause(300);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};