import { supabase } from '../lib/supabase.js';
import { showToast, formatCurrency } from '../lib/ui.js';

const STATUS_LABELS = {
  new: 'Đơn mới',
  shipping: 'Đang vận chuyển',
  completed: 'Hoàn thành',
  returned: 'Chuyển hoàn',
  cancelled: 'Đã hủy',
  lost: 'Thất lạc/mất hàng',
};
const STATUS_ORDER = ['new', 'shipping', 'completed', 'returned', 'cancelled', 'lost'];
// Trạng thái cuối — không cho đổi status tiếp (khớp với ràng buộc trong RPC update_order_status).
// Hình thức thanh toán vẫn sửa được kể cả khi đơn đã ở các trạng thái này.
const LOCKED_STATUSES = ['completed', 'returned', 'cancelled', 'lost'];
const PAYMENT_LABELS = { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ' };

const state = {
  orders: [],
  search: '',
  channelFilter: 'all', // all | in_store | online
  syncFilter: 'all', // all | synced | conflict
  statusFilter: 'all', // all | new | shipping | completed | returned | cancelled | lost
  paymentFilter: 'all', // all | cash | transfer | card
  realtimeChannel: null,
};

export async function renderOrders(container) {
  await loadOrders();
  paint(container);
  subscribeRealtime(container);
}

async function loadOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (!error) state.orders = data;
}

function subscribeRealtime(container) {
  if (state.realtimeChannel) return;
  state.realtimeChannel = supabase
    .channel('orders-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, async () => {
      await loadOrders();
      paint(container);
    })
    .subscribe();
}

function getFiltered() {
  const q = state.search.trim().toLowerCase();
  return state.orders.filter((o) => {
    if (state.channelFilter !== 'all' && o.channel !== state.channelFilter) return false;
    if (state.syncFilter !== 'all' && o.sync_status !== state.syncFilter) return false;
    if (state.statusFilter !== 'all' && o.status !== state.statusFilter) return false;
    if (state.paymentFilter !== 'all' && o.payment_method !== state.paymentFilter) return false;
    if (q) {
      const name = (o.customer_name || '').toLowerCase();
      const phone = o.customer_phone || '';
      if (!name.includes(q) && !phone.includes(q)) return false;
    }
    return true;
  });
}

function paint(container) {
  const list = getFiltered();

  container.innerHTML = `
    <h2 class="page-title">Đơn hàng</h2>

    <div class="search-bar-wrap">
      <input type="text" id="order-search" class="form-input" placeholder="Tìm theo tên hoặc SĐT khách hàng..." value="${escapeAttr(state.search)}">
    </div>

    <div class="filter-chips" style="margin: 12px 0 8px;">
      <button class="chip ${state.channelFilter === 'all' ? 'active' : ''}" data-channel="all">Tất cả kênh</button>
      <button class="chip ${state.channelFilter === 'in_store' ? 'active' : ''}" data-channel="in_store">Tại quầy</button>
      <button class="chip ${state.channelFilter === 'online' ? 'active' : ''}" data-channel="online">Online</button>
    </div>
    <div class="filter-chips" style="margin-bottom: 8px;">
      <button class="chip ${state.statusFilter === 'all' ? 'active' : ''}" data-status="all">Tất cả trạng thái đơn</button>
      ${STATUS_ORDER.map((s) => `<button class="chip ${state.statusFilter === s ? 'active' : ''}" data-status="${s}">${STATUS_LABELS[s]}</button>`).join('')}
    </div>
    <div class="filter-chips" style="margin-bottom: 8px;">
      <button class="chip ${state.paymentFilter === 'all' ? 'active' : ''}" data-payment="all">Tất cả thanh toán</button>
      ${Object.keys(PAYMENT_LABELS).map((p) => `<button class="chip ${state.paymentFilter === p ? 'active' : ''}" data-payment="${p}">${PAYMENT_LABELS[p]}</button>`).join('')}
    </div>
    <div class="filter-chips" style="margin-bottom: 16px;">
      <button class="chip ${state.syncFilter === 'all' ? 'active' : ''}" data-sync="all">Tất cả đồng bộ</button>
      <button class="chip ${state.syncFilter === 'synced' ? 'active' : ''}" data-sync="synced">Đã đồng bộ</button>
      <button class="chip ${state.syncFilter === 'conflict' ? 'active' : ''}" data-sync="conflict">Cần đối soát</button>
    </div>

    <div id="order-list">
      ${list.length ? list.map(orderRowHtml).join('') : emptyStateHtml()}
    </div>

    ${detailModalHtml()}
  `;

  wireEvents(container);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderOrderList(container) {
  const el = container.querySelector('#order-list');
  if (!el) return;
  const list = getFiltered();
  el.innerHTML = list.length ? list.map(orderRowHtml).join('') : emptyStateHtml();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <span class="empty-icon">🧾</span>
      <p>Chưa có đơn hàng nào</p>
      <p class="empty-sub">Đơn hàng tạo từ trang Bán hàng sẽ hiện ở đây</p>
    </div>`;
}

function statusBadgeHtml(status) {
  return `<span class="status-badge status-${status}">${STATUS_LABELS[status] || status}</span>`;
}

function orderRowHtml(o) {
  const channelLabel = o.channel === 'online' ? 'Online' : 'Tại quầy';
  const syncBadge =
    o.sync_status === 'conflict'
      ? `<span class="badge-warning">Cần đối soát</span>`
      : `<span class="badge-success">Đã đồng bộ</span>`;

  return `
    <div class="card product-row order-row" data-id="${o.id}">
      <div class="product-row-main">
        <div>
          <div class="product-name">${channelLabel} · ${paymentLabel(o.payment_method)}</div>
          <div class="product-sub">${new Date(o.created_at).toLocaleString('vi-VN')}${o.created_offline ? ' · Tạo lúc offline' : ''}</div>
          ${o.customer_name ? `<div class="order-customer-line">Khách: ${escapeHtml(o.customer_name)}${o.customer_phone ? ' · ' + escapeHtml(o.customer_phone) : ''}</div>` : ''}
        </div>
        <div class="product-prices">
          <div class="product-sell">${formatCurrency(o.total)}</div>
          <div style="margin-top:4px; display:flex; flex-direction:column; gap:4px; align-items:flex-end;">
            ${statusBadgeHtml(o.status)}
            ${syncBadge}
          </div>
        </div>
      </div>
      ${
        o.status === 'new'
          ? `<div class="product-row-footer">
              <span></span>
              <button type="button" class="btn-icon-text btn-mark-shipping" data-id="${o.id}">
                <i data-lucide="truck"></i> Chuyển sang Đang vận chuyển
              </button>
            </div>`
          : ''
      }
    </div>`;
}

function detailModalHtml() {
  return `
    <div id="modal-order-detail" class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3>Chi tiết đơn hàng</h3>
          <button class="icon-btn close-order-modal" aria-label="Đóng"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body" id="order-detail-body"></div>
      </div>
    </div>`;
}

function profitSectionHtml(order) {
  const cogs = (order.order_items || []).reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0);
  const shippingFee = Number(order.shipping_fee) || 0;

  if (order.status === 'completed') {
    const profit = Number(order.total) - cogs - shippingFee;
    return `
      <div class="pos-totals" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div class="pos-total-row"><span>Giá vốn hàng bán</span><span>-${formatCurrency(cogs)}</span></div>
        ${shippingFee > 0 ? `<div class="pos-total-row"><span>Phí vận chuyển</span><span>-${formatCurrency(shippingFee)}</span></div>` : ''}
        <div class="pos-total-row pos-total-final"><span>Lợi nhuận thực tế</span><span>${formatCurrency(profit)}</span></div>
      </div>`;
  }

  if (order.status === 'returned') {
    return `
      <div class="pos-totals" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div class="pos-total-row"><span>Phí vận chuyển (mất do chuyển hoàn)</span><span>-${formatCurrency(shippingFee)}</span></div>
        <div class="pos-total-row pos-total-final"><span>Lợi nhuận thực tế</span><span>${formatCurrency(-shippingFee)}</span></div>
      </div>`;
  }

  if (order.status === 'lost') {
    const loss = cogs + shippingFee;
    return `
      <div class="pos-totals" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
        <div class="pos-total-row"><span>Giá vốn hàng bán (thất lạc)</span><span>-${formatCurrency(cogs)}</span></div>
        ${shippingFee > 0 ? `<div class="pos-total-row"><span>Phí vận chuyển</span><span>-${formatCurrency(shippingFee)}</span></div>` : ''}
        <div class="pos-total-row pos-total-final"><span>Lợi nhuận thực tế</span><span>${formatCurrency(-loss)}</span></div>
      </div>`;
  }

  return `<p class="empty-sub" style="margin-top:12px;">Lợi nhuận sẽ được tính khi đơn ở trạng thái Hoàn thành, Chuyển hoàn hoặc Thất lạc</p>`;
}

function openOrderDetail(container, order) {
  const modal = container.querySelector('#modal-order-detail');
  const body = container.querySelector('#order-detail-body');
  const channelLabel = order.channel === 'online' ? 'Online' : 'Tại quầy';

  const itemsHtml = (order.order_items || [])
    .slice()
    .sort((a, b) => a.product_name.localeCompare(b.product_name))
    .map(
      (it) => `
      <div class="history-row">
        <div>
          <div class="history-reason">${escapeHtml(it.product_name)} ${Number(it.stock_shortfall) > 0 ? `<span class="badge-warning">Thiếu ${it.stock_shortfall}</span>` : ''}</div>
          <div class="history-date">${formatCurrency(it.unit_price)} x ${it.qty}</div>
        </div>
        <div class="history-qty">${formatCurrency(it.qty * it.unit_price)}</div>
      </div>`
    )
    .join('');

  const isLocked = LOCKED_STATUSES.includes(order.status);
  const statusOptionsHtml = STATUS_ORDER.map(
    (s) => `<option value="${s}" ${order.status === s ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`
  ).join('');
  const paymentOptionsHtml = Object.keys(PAYMENT_LABELS)
    .map((p) => `<option value="${p}" ${order.payment_method === p ? 'selected' : ''}>${PAYMENT_LABELS[p]}</option>`)
    .join('');

  body.innerHTML = `
    <p class="form-label">${channelLabel} · ${paymentLabel(order.payment_method)} · ${new Date(order.created_at).toLocaleString('vi-VN')}</p>
    ${order.created_offline ? `<span class="badge-muted" style="margin-top:6px; display:inline-block;">Tạo lúc offline</span>` : ''}

    <div class="form-section" style="margin-top:14px;">
      <label class="form-label" for="order-status-select">Trạng thái đơn hàng</label>
      <select id="order-status-select" class="form-input" style="margin-top:6px;" ${isLocked ? 'disabled' : ''}>${statusOptionsHtml}</select>
      ${isLocked ? `<p class="empty-sub" style="margin-top:6px;">Đơn đã ở trạng thái cuối, không thể đổi trạng thái tiếp</p>` : ''}
    </div>

    <div class="form-section" style="margin-top:12px;">
      <label class="form-label" for="order-payment-select">Hình thức thanh toán</label>
      <select id="order-payment-select" class="form-input" style="margin-top:6px;">${paymentOptionsHtml}</select>
    </div>

    <button type="button" id="btn-save-status" class="btn-primary" style="margin-top:12px;">Lưu thay đổi</button>

    ${
      order.customer_name
        ? `<div class="card" style="margin-top:14px; padding:14px;">
            <div class="product-name">${escapeHtml(order.customer_name)}</div>
            ${order.customer_phone ? `<div class="product-sub" style="margin-top:4px;">${escapeHtml(order.customer_phone)}</div>` : ''}
            ${order.customer_address ? `<div class="product-sub" style="margin-top:2px;">${escapeHtml(order.customer_address)}</div>` : ''}
            ${order.customer_note ? `<div class="product-sub" style="margin-top:6px;">Lưu ý: ${escapeHtml(order.customer_note)}</div>` : ''}
          </div>`
        : ''
    }
    <div style="margin-top:16px;">${itemsHtml}</div>
    <div class="pos-totals" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
      <div class="pos-total-row"><span>Tạm tính</span><span>${formatCurrency(order.subtotal)}</span></div>
      <div class="pos-total-row"><span>Giảm giá</span><span>-${formatCurrency(order.discount)}</span></div>
      <div class="pos-total-row pos-total-final"><span>Tổng cộng</span><span>${formatCurrency(order.total)}</span></div>
    </div>
    ${profitSectionHtml(order)}
    ${order.note ? `<p class="product-sub" style="margin-top:12px;">Ghi chú: ${escapeHtml(order.note)}</p>` : ''}
  `;

  container.querySelector('#btn-save-status').addEventListener('click', () => {
    const newStatus = container.querySelector('#order-status-select').value;
    const newPayment = container.querySelector('#order-payment-select').value;
    handleStatusUpdate(order.id, newStatus, newPayment, container, 'Đã lưu thay đổi đơn hàng');
  });

  modal.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function handleStatusUpdate(orderId, newStatus, paymentMethod, container, successMessage) {
  try {
    const { error } = await supabase.rpc('update_order_status', {
      p_order_id: orderId,
      p_new_status: newStatus,
      p_payment_method: paymentMethod,
    });
    if (error) throw error;
    showToast(successMessage, 'success');
    container.querySelector('#modal-order-detail')?.classList.remove('active');
    await loadOrders();
    paint(container);
  } catch (err) {
    showToast(err.message || 'Lỗi khi cập nhật đơn hàng', 'error');
  }
}

function paymentLabel(m) {
  return PAYMENT_LABELS[m] || m;
}

function wireEvents(container) {
  container.querySelector('#order-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderOrderList(container);
  });

  container.querySelectorAll('[data-channel]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.channelFilter = chip.dataset.channel;
      paint(container);
    });
  });

  container.querySelectorAll('[data-status]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.statusFilter = chip.dataset.status;
      paint(container);
    });
  });

  container.querySelectorAll('[data-payment]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.paymentFilter = chip.dataset.payment;
      paint(container);
    });
  });

  container.querySelectorAll('[data-sync]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.syncFilter = chip.dataset.sync;
      paint(container);
    });
  });

  container.querySelector('#order-list').addEventListener('click', (e) => {
    const shipBtn = e.target.closest('.btn-mark-shipping');
    if (shipBtn) {
      handleStatusUpdate(shipBtn.dataset.id, 'shipping', null, container, 'Đã chuyển sang Đang vận chuyển');
      return;
    }

    const row = e.target.closest('.order-row');
    if (row) {
      const order = state.orders.find((o) => o.id === row.dataset.id);
      if (order) openOrderDetail(container, order);
    }
  });

  const modal = container.querySelector('#modal-order-detail');
  container.querySelector('.close-order-modal').addEventListener('click', () => modal.classList.remove('active'));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('active');
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
