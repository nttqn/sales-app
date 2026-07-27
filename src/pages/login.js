import { supabase } from '../lib/supabase.js';

export function renderLogin(container, { onSuccess }) {
  let mode = 'signin'; // 'signin' | 'signup'

  function render() {
    container.innerHTML = `
      <div class="login-wrap">
        <div class="login-logo">🛒</div>
        <h1 class="login-title">SalesFlow</h1>
        <p class="login-subtitle">Quản lý bán hàng, tồn kho &amp; lợi nhuận</p>

        <form id="login-form" class="login-form" autocomplete="off">
          <div id="login-error-slot"></div>

          <div class="form-section">
            <label class="form-label" for="login-email">Email</label>
            <input type="email" id="login-email" class="form-input" placeholder="you@example.com" required>
          </div>

          <div class="form-section">
            <label class="form-label" for="login-password">Mật khẩu</label>
            <input type="password" id="login-password" class="form-input" placeholder="••••••••" minlength="6" required>
          </div>

          <button type="submit" id="login-submit" class="btn-primary">
            <span id="login-submit-label">${mode === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}</span>
          </button>
        </form>

        <div class="login-toggle">
          ${mode === 'signin'
            ? `Chưa có tài khoản? <button type="button" id="login-toggle-btn">Đăng ký</button>`
            : `Đã có tài khoản? <button type="button" id="login-toggle-btn">Đăng nhập</button>`}
        </div>
      </div>`;

    container.querySelector('#login-toggle-btn').addEventListener('click', () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      render();
    });

    container.querySelector('#login-form').addEventListener('submit', handleSubmit);
  }

  function showError(message) {
    container.querySelector('#login-error-slot').innerHTML =
      `<div class="login-error">${message}</div>`;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const email = container.querySelector('#login-email').value.trim();
    const password = container.querySelector('#login-password').value;
    const submitBtn = container.querySelector('#login-submit');
    const submitLabel = container.querySelector('#login-submit-label');

    submitBtn.disabled = true;
    const originalLabel = submitLabel.textContent;
    submitLabel.innerHTML = '<span class="spinner"></span>';

    const { error } =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    if (error) {
      submitBtn.disabled = false;
      submitLabel.textContent = originalLabel;
      showError(translateAuthError(error.message));
      return;
    }

    if (mode === 'signup') {
      // Nếu project bật email confirmation, chưa có session ngay -> báo cho user
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        submitBtn.disabled = false;
        submitLabel.textContent = originalLabel;
        showError('Đã tạo tài khoản! Kiểm tra email để xác nhận rồi đăng nhập lại.');
        return;
      }
    }

    onSuccess();
  }

  function translateAuthError(message) {
    if (message.includes('Invalid login credentials')) return 'Sai email hoặc mật khẩu.';
    if (message.includes('User already registered')) return 'Email này đã có tài khoản.';
    if (message.includes('Password should be at least')) return 'Mật khẩu cần ít nhất 6 ký tự.';
    return message;
  }

  render();
}
