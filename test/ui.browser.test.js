// Optional Chrome regression: npm run test:ui (Node 22+, CHROME_PATH if needed).
// Uses temporary data only; never connects to a real upstream.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert(fs.existsSync(chrome), '设置 CHROME_PATH 为本机 Chrome 路径');
  assert.equal(typeof WebSocket, 'function', 'UI 测试需要 Node 22+ 内置 WebSocket');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ui-'));
  const profile = path.join(temporary, 'chrome');
  let gateway;
  let browser;
  let socket;
  const pending = new Map();
  try {
    const reservation = http.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    gateway = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      cwd: root,
      env: { ...process.env, LOCAL_MODEL_GATEWAY_DATA_DIR: path.join(temporary, 'data'), LOCAL_MODEL_GATEWAY_FORCE_HOST: '127.0.0.1', LOCAL_MODEL_GATEWAY_FORCE_PORT: String(port), ADMIN_REMOTE_MODE: 'oidc' },
      stdio: 'ignore'
    });
    let ready = false;
    for (let i = 0; i < 200; i += 1) {
      ready = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false);
      if (ready) break;
      assert.equal(gateway.exitCode, null, '临时网关意外退出');
      await pause(50);
    }
    assert(ready, '临时网关启动超时');
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i += 1) await pause(50);
    assert(fs.existsSync(portFile), 'Chrome 启动超时');
    const debugPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    const exceptions = [];
    let serial = 0;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
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
      for (let i = 0; i < 150; i += 1) {
        if (await evaluate(expression)) return;
        await pause(50);
      }
      throw new Error(`等待超时: ${expression}`);
    };
    const viewport = (width) => cdp('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: width < 700 });
    const motion = (value) => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
    const style = (selector, property) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`);
    const screenshot = async (name) => {
      if (!process.env.GATEWAY_UI_SCREENSHOTS) return;
      const directory = path.resolve(process.env.GATEWAY_UI_SCREENSHOTS);
      fs.mkdirSync(directory, { recursive: true });
      const image = await cdp('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(directory, `${name}.png`), Buffer.from(image.data, 'base64'));
    };

    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await viewport(1440);
    await motion('no-preference');
    await cdp('Page.navigate', { url: base });
    await waitFor('Boolean(window.ModelGroups && document.querySelector("#dashboard:not(.hidden)"))');
    const settled = 'document.getAnimations().every(animation => animation.playState === "finished")';
    const noOverflow = 'document.documentElement.scrollWidth <= window.innerWidth';
    const tabs = await evaluate('[...document.querySelectorAll(".tab")].map(tab => tab.dataset.tab)');
    assert.equal(await evaluate('document.querySelectorAll(".nav-icon[aria-hidden=true]").length'), tabs.length);
    for (const tab of tabs) {
      await evaluate(`document.querySelector('[data-tab="${tab}"]').click()`);
      assert.equal(await evaluate('document.querySelector(".tab.active").dataset.tab'), tab);
      assert.equal(await evaluate(`[...document.querySelectorAll('.dashboard-card:not(.hidden)')].every(panel => panel.dataset.tabPage === '${tab}')`), true);
      assert.equal(await style('.dashboard-card:not(.hidden)', 'animationName'), 'gateway-reveal');
    }
    await evaluate('switchTab("about")');
    await waitFor(settled);
    assert.equal(await evaluate('/^v?\\d+\\.\\d+\\.\\d+$/.test(document.querySelector("#aboutVersion").textContent)'), true, '关于页应显示当前版本');
    assert.equal(await evaluate('Boolean(document.querySelector(\'[data-tab-page="about"] a[href*="/blob/main/LICENSE"]\'))'), true, '关于页应提供许可正文入口');
    await evaluate('switchTab("metrics")');
    await waitFor(settled);
    await evaluate('refreshMetrics()');
    assert.equal(await evaluate('document.querySelector("#statsGrid").getAnimations({subtree:true}).length'), 0, '自动刷新不能重播卡片动画');
    await screenshot('metrics-desktop');
    await evaluate('switchTab("overview")');
    await waitFor(settled);
    await screenshot('dashboard-desktop');
    await evaluate('switchTab("upstreams"); document.querySelector("#addUpstreamButton").click()');
    assert.equal(await evaluate('document.querySelector("#upstreamDialog").open'), true);
    assert.equal(await style('#upstreamDialog', 'animationName'), 'gateway-dialog');
    assert.equal(await evaluate('document.activeElement.closest("dialog")?.id'), 'upstreamDialog');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor('!document.querySelector("#upstreamDialog").open');
    await evaluate('toast("界面测试完成")');
    await waitFor('getComputedStyle(document.querySelector("#toast")).opacity === "1"');
    await evaluate('clearTimeout(toast.timer); document.querySelector("#toast").className = "toast"');
    await waitFor('getComputedStyle(document.querySelector("#toast")).opacity === "0"');
    for (const width of [1024, 768, 390, 320]) {
      await viewport(width);
      for (const tab of tabs) {
        await evaluate(`switchTab('${tab}')`);
        assert.equal(await evaluate(noOverflow), true, `${width}px / ${tab} 不应横向溢出`);
      }
      await evaluate('switchTab("upstreams"); document.querySelector("#addUpstreamButton").click()');
      assert.equal(await evaluate('document.querySelector("#upstreamDialog").scrollWidth <= document.querySelector("#upstreamDialog").clientWidth'), true, `${width}px 弹窗不应横向溢出`);
      await evaluate('document.querySelector("[data-dialog-close=upstreamDialog]").click()');
    }
    await evaluate('switchTab("overview")');
    await waitFor(settled);
    await screenshot('dashboard-mobile');
    await motion('reduce');
    await evaluate('switchTab("upstreams"); document.querySelector("#addUpstreamButton").click()');
    assert.equal(await style('#upstreamDialog', 'animationName'), 'none');
    assert.equal(await style('.dashboard-card:not(.hidden)', 'animationName'), 'none');
    assert.equal(await style('.button', 'transitionDuration'), '0s');
    await evaluate('document.querySelector("[data-dialog-close=upstreamDialog]").click(); document.querySelector("#loadButton").focus()');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid', '键盘焦点应可见');

    // Mock only the session response so localhost can display the login page.
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
      const originalFetch = window.fetch;
      window.fetch = (input, options) => input === '/auth/status'
        ? Promise.resolve(new Response(JSON.stringify({authenticated:false, configured:true, remoteMode:'password'}), {headers:{'Content-Type':'application/json'}}))
        : originalFetch(input, options);
    ` });
    await viewport(1440);
    await motion('no-preference');
    await cdp('Page.navigate', { url: `${base}/login.html` });
    await waitFor('Boolean(document.querySelector("#passwordLoginForm:not(.hidden)"))');
    assert.equal(await style('.login-card', 'animationName'), 'gateway-reveal');
    await waitFor(settled);
    await screenshot('login-desktop');
    await evaluate('document.querySelector("#passwordLoginButton").click()');
    assert.equal(await evaluate('document.querySelector("#loginError").textContent'), '请输入用户名和密码');
    for (const width of [1024, 900, 768, 390, 320]) {
      await viewport(width);
      assert.equal(await evaluate(noOverflow), true, `${width}px 登录页不应横向溢出`);
      assert.equal(await style('#passwordLoginForm', 'display'), 'grid');
      assert.equal(await style('#loginActions', 'display'), 'none', '隐藏状态不能被动画覆盖');
    }
    await waitFor(settled);
    await screenshot('login-mobile');
    await motion('reduce');
    await evaluate('setStatus("检查会话", "请稍候")');
    assert.equal(await style('.login-spinner', 'animationName'), 'none');
    assert.equal(await style('.login-card', 'animationName'), 'none');
    assert.equal(await evaluate('document.getAnimations().length'), 0);
    await evaluate('showOidcLogin()');
    assert.equal(await style('#passwordLoginForm', 'display'), 'none');
    assert.equal(await style('#loginActions', 'display'), 'grid');
    assert.deepEqual(exceptions, [], '浏览器不应出现未处理异常');
    console.log('UI browser tests passed (navigation, dialogs, responsive layout, login, reduced motion)');
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer);
    socket?.close();
    if (browser && browser.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
      } else {
        const exited = once(browser, 'exit');
        browser.kill();
        await exited;
      }
    }
    if (gateway && gateway.exitCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    await pause(300);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
