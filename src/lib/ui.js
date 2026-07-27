let toastTimeout;

export function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.className = `toast ${type}`;

  void toast.offsetWidth; // force reflow to restart animation
  toast.classList.add('show');

  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

export function showConfirm(title, message) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-confirm');
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    overlay.classList.add('active');

    const cleanup = (result) => {
      overlay.classList.remove('active');
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      overlay.removeEventListener('click', onBackdrop);
      resolve(result);
    };

    const onCancel = () => cleanup(false);
    const onOk = () => cleanup(true);
    const onBackdrop = (e) => {
      if (e.target === overlay) cleanup(false);
    };

    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    overlay.addEventListener('click', onBackdrop);

    if (typeof lucide !== 'undefined') lucide.createIcons();
  });
}

export function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(amount || 0);
}
