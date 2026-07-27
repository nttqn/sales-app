import { supabase } from '../lib/supabase.js';
import { formatCurrency } from '../lib/ui.js';

const state = {
  orders: [],
  channelFilter: 'all', // all | in_store | online
  syncFilter: 'all', // all | synced | conflict
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
  return state.orders.filter((o) => {
    if (state.channelFilter !== 'all' && o.channel !== state.channelFilter) return false;
    if (state.syncFilter !== 'all' && o.sync_status !== state.syncFilter) return false;
    return true;
  });
}

function paint(container) {
  const list = getFiltered();

  container.innerHTML = `
    <h2 class="page-title">Đơn hàng</h2>

    <div class="filter-chips" style="margin-bottom: 8px;">
      <button class="chip ${state.channelFilter === 'all' ? 'active' : ''}" data-channel="all">Tất cả kênh</button>
      <button class="chip ${state.channelFilter === 'in_store' ? 'active' : ''}" data-channel="in_store">Tại quầy</button>
      <button class="chip ${state.channelFilter === 'online' ? 'active' : ''}" data-channel="online">Online</button>
    </div>
    <div class="filter-chips" style="margin-bottom: 16px;">
      <button class="chip ${state.syncFilter === 'all' ? 'active' : ''}" data-sync="all">Tất cả trạng thái</button>
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

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <span class="empty-icon">🧾</span>
      <p>Chưa có đơn hàng nào</p>
      <p class="empty-sub">Đơn hàng tạo từ trang Bán hàng sẽ hiện ở đây</p>
    </div>`;
}

function orderRowHtml(o) {
  const channelLabel = o.channel === 'online' ? 'Online' : 'Tại quầy';
  const statusBadge =
    o.sync_status === 'conflict'
      ? `<span class="badge-warning">Cần đối soát</span>`
      : `<span class="badge-success">Đã đồng bộ</span>`;

  return `
    <div class="card product-row order-row" data-id="${o.id}">
      <div class="product-row-main">
        <div>
          <div class="product-name">${channelLabel} · ${paymentLabel(o.payment_method)}</div>
          <div class="product-sub">${new Date(o.created_at).toLocaleString('vi-VN')}${o.created_offline ? ' · Tạo lúc offline' : ''}</div>
        </div>
        <div class="product-prices">
          <div class="product-sell">${formatCurrency(o.total)}</div>
          <div style="margin-top:4px;">${statusBadge}</div>
        </div>
      </div>
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

function openOrderDetail(container, order) {
  const modal = container.querySelector('#modal-order-detail');
  const body = container.querySelector('#order-detail-body');
  const channelLabel = order.channel === 'online' ? 'Online' : 'Tại quầy';

  const cogs = (order.order_items || []).reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0);
  const shippingFee = Number(order.shipping_fee) || 0;
  const profit = Number(order.total) - cogs - shippingFee;

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

  body.innerHTML = `
    <p class="form-label">${channelLabel} · ${paymentLabel(order.payment_method)} · ${new Date(order.created_at).toLocaleString('vi-VN')}</p>
    ${order.created_offline ? `<span class="badge-muted" style="margin-top:6px; display:inline-block;">Tạo lúc offline</span>` : ''}
    <div style="margin-top:16px;">${itemsHtml}</div>
    <div class="pos-totals" style="margin-top:16px; padding-top:16px; border-top:1px solid var(--border);">
      <div class="pos-total-row"><span>Tạm tính</span><span>${formatCurrency(order.subtotal)}</span></div>
      <div class="pos-total-row"><span>Giảm giá</span><span>-${formatCurrency(order.discount)}</span></div>
      <div class="pos-total-row pos-total-final"><span>Tổng cộng</span><span>${formatCurrency(order.total)}</span></div>
    </div>
    <div class="pos-totals" style="margin-top:12px; padding-top:12px; border-top:1px solid var(--border);">
      <div class="pos-total-row"><span>Giá vốn hàng bán</span><span>-${formatCurrency(cogs)}</span></div>
      ${shippingFee > 0 ? `<div class="pos-total-row"><span>Phí vận chuyển</span><span>-${formatCurrency(shippingFee)}</span></div>` : ''}
      <div class="pos-total-row pos-total-final"><span>Lợi nhuận thực tế</span><span>${formatCurrency(profit)}</span></div>
    </div>
    ${order.note ? `<p class="product-sub" style="margin-top:12px;">Ghi chú: ${escapeHtml(order.note)}</p>` : ''}
  `;

  modal.classList.add('active');
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function paymentLabel(m) {
  return { cash: 'Tiền mặt', transfer: 'Chuyển khoản', card: 'Thẻ' }[m] || m;
}

function wireEvents(container) {
  container.querySelectorAll('[data-channel]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.channelFilter = chip.dataset.channel;
      paint(container);
    });
  });

  container.querySelectorAll('[data-sync]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.syncFilter = chip.dataset.sync;
      paint(container);
    });
  });

  container.querySelectorAll('.order-row').forEach((row) => {
    row.addEventListener('click', () => {
      const order = state.orders.find((o) => o.id === row.dataset.id);
      if (order) openOrderDetail(container, order);
    });
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
