import { supabase } from '../lib/supabase.js';
import { cacheCustomers, getCachedCustomers } from '../lib/db.js';
import { showToast, showConfirm } from '../lib/ui.js';

const state = {
  customers: [],
  search: '',
  editingId: null,
  realtimeChannel: null,
};

export async function renderCustomers(container) {
  await loadCustomers();
  paint(container);
  subscribeRealtime(container);
}

async function loadCustomers() {
  const { data, error } = await supabase.from('customers').select('*').order('name');

  if (error) {
    state.customers = await getCachedCustomers();
    return;
  }

  state.customers = data;
  await cacheCustomers(data);
}

function subscribeRealtime(container) {
  if (state.realtimeChannel) return;
  state.realtimeChannel = supabase
    .channel('customers-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, async () => {
      await loadCustomers();
      paint(container);
    })
    .subscribe();
}

function getFilteredCustomers() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.customers;
  return state.customers.filter(
    (c) => c.name.toLowerCase().includes(q) || (c.phone || '').includes(q)
  );
}

function paint(container) {
  const list = getFilteredCustomers();

  container.innerHTML = `
    <div class="section-header">
      <h2 class="page-title" style="margin-bottom: 0;">Khách hàng</h2>
      <button id="btn-add-customer" class="icon-btn" aria-label="Thêm khách hàng">
        <i data-lucide="plus-circle"></i>
      </button>
    </div>

    <div class="search-bar-wrap">
      <input type="text" id="customer-search" class="form-input" placeholder="Tìm theo tên hoặc số điện thoại..." value="${escapeAttr(state.search)}">
    </div>

    <div id="customer-list" style="margin-top: 12px;">
      ${list.length === 0 ? emptyStateHtml() : list.map(customerRowHtml).join('')}
    </div>

    ${customerModalHtml()}
  `;

  wireEvents(container);
  refreshIcons();
}

function renderCustomerList(container) {
  const el = container.querySelector('#customer-list');
  if (!el) return;
  const list = getFilteredCustomers();
  el.innerHTML = list.length === 0 ? emptyStateHtml() : list.map(customerRowHtml).join('');
  refreshIcons();
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <span class="empty-icon">👤</span>
      <p>Chưa có khách hàng nào</p>
      <p class="empty-sub">Khách hàng sẽ tự động được lưu khi bạn lên đơn, hoặc bấm nút + để thêm thủ công</p>
    </div>`;
}

function customerRowHtml(c) {
  return `
    <div class="card product-row" data-id="${c.id}">
      <div class="product-row-main">
        <div>
          <div class="product-name">${escapeHtml(c.name)}</div>
          <div class="product-sub">${escapeHtml(c.phone)}${c.address ? ' · ' + escapeHtml(c.address) : ''}</div>
        </div>
      </div>
      ${c.note ? `<div class="product-sub" style="margin-top: 8px;">Ghi chú: ${escapeHtml(c.note)}</div>` : ''}
      <div class="product-row-footer">
        <span></span>
        <div class="product-actions">
          <button class="btn-icon-text btn-edit-customer" data-id="${c.id}">
            <i data-lucide="pencil"></i> Sửa
          </button>
          <button class="btn-icon-text btn-delete-customer" data-id="${c.id}">
            <i data-lucide="trash-2"></i> Xóa
          </button>
        </div>
      </div>
    </div>`;
}

function customerModalHtml() {
  return `
    <div id="modal-customer" class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3 id="customer-modal-title">Thêm khách hàng</h3>
          <button class="icon-btn close-customer-modal" aria-label="Đóng"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <form id="form-customer">
            <div class="form-section">
              <label class="form-label" for="cf-name">Tên khách hàng</label>
              <input type="text" id="cf-name" class="form-input" required>
            </div>
            <div class="form-section">
              <label class="form-label" for="cf-phone">Số điện thoại</label>
              <input type="tel" id="cf-phone" class="form-input" required>
            </div>
            <div class="form-section">
              <label class="form-label" for="cf-address">Địa chỉ</label>
              <input type="text" id="cf-address" class="form-input">
            </div>
            <div class="form-section">
              <label class="form-label" for="cf-note">Lưu ý riêng</label>
              <input type="text" id="cf-note" class="form-input" placeholder="Tùy chọn">
            </div>
            <button type="submit" class="btn-primary"><span id="cf-submit-label">Lưu khách hàng</span></button>
          </form>
        </div>
      </div>
    </div>`;
}

function wireEvents(container) {
  container.querySelector('#btn-add-customer').addEventListener('click', () => openCustomerModal(container, null));

  container.querySelector('#customer-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderCustomerList(container);
  });

  // Delegated trên #customer-list (thay vì gắn từng nút) vì renderCustomerList() chỉ thay
  // innerHTML của nó khi gõ tìm kiếm — gắn trực tiếp lên từng nút sẽ mất tác dụng sau lần gõ đầu.
  container.querySelector('#customer-list').addEventListener('click', (e) => {
    const editBtn = e.target.closest('.btn-edit-customer');
    if (editBtn) {
      const customer = state.customers.find((c) => c.id === editBtn.dataset.id);
      openCustomerModal(container, customer);
      return;
    }

    const deleteBtn = e.target.closest('.btn-delete-customer');
    if (deleteBtn) {
      handleCustomerDelete(deleteBtn.dataset.id, container);
    }
  });

  const modal = container.querySelector('#modal-customer');
  container.querySelector('.close-customer-modal').addEventListener('click', () => closeModal(modal));
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(modal); });
  container.querySelector('#form-customer').addEventListener('submit', (e) => handleCustomerSubmit(e, container));
}

function openModal(modal) {
  modal.classList.add('active');
  refreshIcons();
}
function closeModal(modal) {
  modal.classList.remove('active');
}

function openCustomerModal(container, customer) {
  state.editingId = customer ? customer.id : null;

  container.querySelector('#customer-modal-title').textContent = customer ? 'Sửa khách hàng' : 'Thêm khách hàng';
  container.querySelector('#cf-submit-label').textContent = customer ? 'Cập nhật' : 'Lưu khách hàng';
  container.querySelector('#cf-name').value = customer?.name ?? '';
  container.querySelector('#cf-phone').value = customer?.phone ?? '';
  container.querySelector('#cf-address').value = customer?.address ?? '';
  container.querySelector('#cf-note').value = customer?.note ?? '';

  openModal(container.querySelector('#modal-customer'));
}

async function handleCustomerSubmit(e, container) {
  e.preventDefault();
  const payload = {
    name: container.querySelector('#cf-name').value.trim(),
    phone: container.querySelector('#cf-phone').value.trim(),
    address: container.querySelector('#cf-address').value.trim() || null,
    note: container.querySelector('#cf-note').value.trim() || null,
  };

  try {
    if (state.editingId) {
      const { error } = await supabase.from('customers').update(payload).eq('id', state.editingId);
      if (error) throw error;
      showToast('Đã cập nhật khách hàng', 'success');
    } else {
      const { error } = await supabase.from('customers').insert(payload);
      if (error) throw error;
      showToast('Đã thêm khách hàng', 'success');
    }

    closeModal(container.querySelector('#modal-customer'));
    await loadCustomers();
    paint(container);
  } catch (err) {
    const message = err.code === '23505' ? 'Số điện thoại này đã tồn tại' : err.message;
    showToast(message || 'Lỗi khi lưu khách hàng', 'error');
  }
}

async function handleCustomerDelete(customerId, container) {
  const customer = state.customers.find((c) => c.id === customerId);
  const confirmed = await showConfirm(
    'Xóa khách hàng',
    `Xóa khách hàng "${customer?.name ?? ''}"? Các đơn hàng cũ vẫn giữ nguyên thông tin đã lưu.`
  );
  if (!confirmed) return;

  try {
    const { error } = await supabase.from('customers').delete().eq('id', customerId);
    if (error) throw error;
    await loadCustomers();
    paint(container);
    showToast('Đã xóa khách hàng', 'success');
  } catch (err) {
    showToast(err.message || 'Lỗi khi xóa khách hàng', 'error');
  }
}

function refreshIcons() {
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
