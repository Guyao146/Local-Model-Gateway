const statusElement = document.querySelector('#loginStatus');
const actionsElement = document.querySelector('#loginActions');
const errorElement = document.querySelector('#loginError');
const loginButton = document.querySelector('#oidcLoginButton');
const retryButton = document.querySelector('#retryLoginButton');
const passwordForm = document.querySelector('#passwordLoginForm');
const usernameInput = document.querySelector('#loginUsername');
const passwordInput = document.querySelector('#loginPassword');
const submitButton = document.querySelector('#passwordLoginButton');

function safeReturnTo(value) {
  const path = String(value || '/').trim();
  return path.startsWith('/') && !path.startsWith('//') && path.length <= 1000 ? path : '/';
}

const query = new URLSearchParams(window.location.search);
const returnTo = safeReturnTo(query.get('returnTo'));
loginButton.href = `/auth/oidc/login?returnTo=${encodeURIComponent(returnTo)}`;

function setStatus(label, message, state = 'loading') {
  statusElement.className = `login-status ${state}`;
  statusElement.innerHTML = `${state === 'loading' ? '<span class="login-spinner" aria-hidden="true"></span>' : '<span class="login-status-icon" aria-hidden="true"></span>'}<div><small>${label}</small><strong>${message}</strong></div>`;
}

function showError(message) {
  if (!message) {
    errorElement.classList.add('hidden');
    errorElement.textContent = '';
    return;
  }
  errorElement.textContent = message;
  errorElement.classList.remove('hidden');
}

function showOidcLogin() {
  passwordForm.classList.add('hidden');
  loginButton.classList.remove('hidden');
  actionsElement.classList.remove('hidden');
  setStatus('需要验证管理身份', '请使用 Authentik 登录', 'ready');
}

function showPasswordLogin() {
  loginButton.classList.add('hidden');
  actionsElement.classList.add('hidden');
  passwordForm.classList.remove('hidden');
  setStatus('需要验证管理身份', '请使用本地账号登录', 'ready');
  usernameInput.focus();
}

async function submitPassword(event) {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) {
    showError('请输入用户名和密码');
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = '登录中…';
  showError('');
  try {
    const response = await fetch('/auth/password/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      showError(body.error?.message || `登录失败（${response.status}）`);
      return;
    }
    setStatus('身份验证成功', '正在进入管理后台…', 'success');
    window.location.replace(safeReturnTo(body.returnTo) || returnTo);
  } catch (error) {
    showError(error.message || '无法连接本地网关，请稍后重试');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = '登录';
  }
}

async function checkSession() {
  actionsElement.classList.add('hidden');
  passwordForm.classList.add('hidden');
  setStatus('正在检查网关会话', '检测登录状态…');
  showError(query.get('error'));
  try {
    const response = await fetch('/auth/status', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    const status = await response.json().catch(() => ({}));
    if (status.authenticated) {
      setStatus('身份验证成功', '正在进入管理后台…', 'success');
      window.location.replace(returnTo);
      return;
    }
    if (status.configured === false) {
      setStatus('网关认证配置不完整', '暂时无法发起远程登录', 'error');
      loginButton.classList.add('hidden');
      actionsElement.classList.remove('hidden');
      retryButton.classList.remove('hidden');
      showError(status.error?.message || '请在网关所在本机完成管理员配置后再远程访问。');
      return;
    }
    if (status.remoteMode === 'password' || status.mode === 'password') {
      showPasswordLogin();
      return;
    }
    showOidcLogin();
  } catch (error) {
    actionsElement.classList.remove('hidden');
    loginButton.classList.add('hidden');
    setStatus('无法连接本地网关', '状态检查失败', 'error');
    showError(error.message || '请确认网关服务正在运行。');
  }
}

retryButton.addEventListener('click', checkSession);
passwordForm.addEventListener('submit', submitPassword);
checkSession();
