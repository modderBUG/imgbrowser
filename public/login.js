/** 登录页逻辑：纯前端校验 + 调用 /api/login */
(() => {
  'use strict';

  const form = document.getElementById('loginForm');
  const input = document.getElementById('password');
  const error = document.getElementById('loginError');
  const submit = document.getElementById('submitBtn');
  const toggle = document.getElementById('togglePassword');

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    input.focus();
    input.select();
  }

  function clearError() {
    error.hidden = true;
    error.textContent = '';
  }

  input.addEventListener('input', clearError);

  toggle.addEventListener('click', () => {
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(reveal));
    toggle.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
    input.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();

    const password = input.value.trim();
    if (!password) {
      showError('请输入访问密码');
      return;
    }

    submit.disabled = true;
    submit.textContent = '登录中…';

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(data.error || '登录失败，请重试');
        return;
      }

      window.location.href = '/';
    } catch {
      showError('网络错误，请检查与服务器的连接');
    } finally {
      submit.disabled = false;
      submit.textContent = '登录';
    }
  });
})();
