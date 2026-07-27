import { supabase } from '../lib/supabase.js';
import { cacheProducts, getCachedProducts, queuePendingOrder } from '../lib/db.js';
import { showToast, formatCurrency } from '../lib/ui.js';
import { syncPendingOrders } from '../lib/sync.js';

const state = {
  products: [],
  search: '',
  cart: [], // { product_id, product_name, unit_price, unit_cost, qty, stock_qty }
  channel: 'in_store',
  paymentMethod: 'cash',
  discount: 0,
  shippingFee: 0, // chi phí ship trả cho đơn vị vận chuyển (kênh online), không phải phí thu khách
  realtimeChannel: null,
  checkingOut: false,
};

export async function renderPos(container) {
  await loadProducts();
  paint(container);
  wireEvents(container);
  subscribeRealtime(container);
}

async function loadProducts() {
  if (navigator.onLine) {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_active', true)
      .order('name');
    if (!error) {
      state.products = data;
      await cacheProducts(data);
      return;
    }
  }
  const cached = await getCachedProducts();
  state.products = cached.filter((p) => p.is_active);
}

function subscribeRealtime(container) {
  if (state.realtimeChannel) return;
  state.realtimeChannel = supabase
    .channel('pos-products-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, async () => {
      await loadProducts();
      renderProductGrid(container);
    })
    .subscribe();
}

function getFilteredProducts() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.products;
  return state.products.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)
  );
}

function computeTotals() {
  const subtotal = state.cart.reduce((s, i) => s + i.qty * i.unit_price, 0);
  const discount = Math.min(Number(state.discount) || 0, subtotal);
  const total = subtotal - discount;
  return { subtotal, discount, total };
}

function addToCart(productId) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return;

  const existing = state.cart.find((i) => i.product_id === productId);
  if (existing) {
    if (existing.qty + 1 > Number(product.stock_qty) && navigator.onLine) {
      showToast('Số lượng vượt tồn kho hiện có', 'warning');
    }
    existing.qty += 1;
  } else {
    state.cart.push({
      product_id: product.id,
      product_name: product.name,
      unit_price: Number(product.sell_price),
      unit_cost: Number(product.cost_price),
      qty: 1,
      stock_qty: Number(product.stock_qty),
    });
  }
}

function changeQty(idx, delta) {
  const item = state.cart[idx];
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) {
    state.cart.splice(idx, 1);
  }
}

function paint(container) {
  container.innerHTML = `
    <h2 class="page-title">Bán hàng</h2>
    <div class="pos-layout">
      <div class="pos-products">
        <div class="search-bar-wrap">
          <i data-lucide="search"></i>
          <input id="pos-search" type="text" placeholder="Tìm sản phẩm..." value="${escapeAttr(state.search)}">
        </div>
        <div id="pos-product-list" class="pos-product-grid">
          ${productGridHtml()}
        </div>
      </div>

      <div class="pos-cart">
        <div id="pos-cart-body">
          ${cartBodyHtml()}
        </div>
      </div>
    </div>`;

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function productGridHtml() {
  const filtered = getFilteredProducts();
  if (!filtered.length) return `<p class="empty-sub">Không tìm thấy sản phẩm</p>`;
  return filtered.map(productCardHtml).join('');
}

function productCardHtml(p) {
  const outOfStock = Number(p.stock_qty) <= 0;
  return `
    <button type="button" class="pos-product-card ${outOfStock ? 'out-of-stock' : ''}" data-id="${p.id}" ${outOfStock ? 'disabled' : ''}>
      <span class="pos-product-name">${escapeHtml(p.name)}</span>
      <span class="pos-product-price">${formatCurrency(p.sell_price)}</span>
      <span class="pos-product-stock ${outOfStock ? 'zero' : ''}">Tồn: ${p.stock_qty}</span>
    </button>`;
}

function cartBodyHtml() {
  const cartCount = state.cart.reduce((s, i) => s + i.qty, 0);
  return `
    <div class="pos-cart-header">
      <h3>Giỏ hàng ${cartCount ? `<span class="cart-count">${cartCount}</span>` : ''}</h3>
      ${state.cart.length ? `<button type="button" id="pos-clear-cart" class="btn-link">Xóa hết</button>` : ''}
    </div>

    <div id="pos-cart-items" class="pos-cart-items">
      ${state.cart.length ? state.cart.map(cartRowHtml).join('') : `<p class="empty-sub">Chưa có sản phẩm nào</p>`}
    </div>

    <div class="pos-cart-footer">
      <div class="pos-field-row">
        <label>Kênh bán</label>
        <div class="chip-group" id="pos-channel">
          <button type="button" class="chip ${state.channel === 'in_store' ? 'active' : ''}" data-channel="in_store">Tại quầy</button>
          <button type="button" class="chip ${state.channel === 'online' ? 'active' : ''}" data-channel="online">Online</button>
        </div>
      </div>

      <div class="pos-field-row">
        <label>Thanh toán</label>
        <select id="pos-payment">
          <option value="cash" ${state.paymentMethod === 'cash' ? 'selected' : ''}>Tiền mặt</option>
          <option value="transfer" ${state.paymentMethod === 'transfer' ? 'selected' : ''}>Chuyển khoản</option>
          <option value="card" ${state.paymentMethod === 'card' ? 'selected' : ''}>Thẻ</option>
        </select>
      </div>

      <div class="pos-field-row">
        <label>Giảm giá</label>
        <input id="pos-discount" type="number" min="0" step="1000" value="${state.discount || ''}" placeholder="0">
      </div>

      ${
        state.channel === 'online'
          ? `<div class="pos-field-row">
              <label>Phí vận chuyển</label>
              <input id="pos-shipping" type="number" min="0" step="1000" value="${state.shippingFee || ''}" placeholder="0">
            </div>`
          : ''
      }

      <div id="pos-totals">
        ${totalsHtml()}
      </div>
    </div>`;
}

function totalsHtml() {
  const totals = computeTotals();
  return `
    <div class="pos-totals">
      <div class="pos-total-row"><span>Tạm tính</span><span>${formatCurrency(totals.subtotal)}</span></div>
      <div class="pos-total-row"><span>Giảm giá</span><span>-${formatCurrency(totals.discount)}</span></div>
      <div class="pos-total-row pos-total-final"><span>Tổng cộng</span><span>${formatCurrency(totals.total)}</span></div>
    </div>
    <button type="button" id="pos-checkout" class="btn-primary btn-block" ${!state.cart.length || state.checkingOut ? 'disabled' : ''}>
      ${state.checkingOut ? 'Đang xử lý...' : `Thanh toán ${formatCurrency(totals.total)}`}
    </button>`;
}

function cartRowHtml(item, idx) {
  return `
    <div class="pos-cart-row" data-idx="${idx}">
      <div class="pos-cart-row-main">
        <span class="pos-cart-name">${escapeHtml(item.product_name)}</span>
        <span class="pos-cart-price">${formatCurrency(item.unit_price)} x ${item.qty}</span>
      </div>
      <div class="pos-cart-row-actions">
        <button type="button" class="qty-btn" data-action="dec" data-idx="${idx}">−</button>
        <span class="qty-value">${item.qty}</span>
        <button type="button" class="qty-btn" data-action="inc" data-idx="${idx}">+</button>
        <button type="button" class="icon-btn-sm remove-cart-item" data-idx="${idx}" aria-label="Xóa">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    </div>`;
}

function renderProductGrid(container) {
  const el = container.querySelector('#pos-product-list');
  if (!el) return;
  el.innerHTML = productGridHtml();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderCart(container) {
  const el = container.querySelector('#pos-cart-body');
  if (!el) return;
  el.innerHTML = cartBodyHtml();
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function renderTotals(container) {
  const el = container.querySelector('#pos-totals');
  const btn = container.querySelector('#pos-checkout');
  if (el) el.innerHTML = totalsHtml();
  else if (btn) {
    // totalsHtml() also renders the checkout button; if #pos-totals wasn't
    // found fall back to a full cart repaint so the button stays in sync.
    renderCart(container);
  }
}

function wireEvents(container) {
  container.addEventListener('input', (e) => {
    if (e.target.id === 'pos-search') {
      state.search = e.target.value;
      renderProductGrid(container);
    }
    if (e.target.id === 'pos-discount') {
      state.discount = Number(e.target.value) || 0;
      renderTotals(container);
    }
    if (e.target.id === 'pos-shipping') {
      state.shippingFee = Number(e.target.value) || 0;
    }
  });

  container.addEventListener('change', (e) => {
    if (e.target.id === 'pos-payment') {
      state.paymentMethod = e.target.value;
    }
  });

  container.addEventListener('click', (e) => {
    const card = e.target.closest('.pos-product-card');
    if (card && !card.disabled) {
      addToCart(card.dataset.id);
      renderCart(container);
      return;
    }

    const channelBtn = e.target.closest('#pos-channel .chip');
    if (channelBtn) {
      state.channel = channelBtn.dataset.channel;
      if (state.channel !== 'online') state.shippingFee = 0;
      renderCart(container);
      return;
    }

    if (e.target.closest('#pos-clear-cart')) {
      state.cart = [];
      renderCart(container);
      return;
    }

    const qtyBtn = e.target.closest('.qty-btn');
    if (qtyBtn) {
      changeQty(Number(qtyBtn.dataset.idx), qtyBtn.dataset.action === 'inc' ? 1 : -1);
      renderCart(container);
      return;
    }

    const removeBtn = e.target.closest('.remove-cart-item');
    if (removeBtn) {
      state.cart.splice(Number(removeBtn.dataset.idx), 1);
      renderCart(container);
      return;
    }

    if (e.target.closest('#pos-checkout')) {
      handleCheckout(container);
    }
  });
}

async function handleCheckout(container) {
  if (!state.cart.length || state.checkingOut) return;

  state.checkingOut = true;
  renderTotals(container);

  const totals = computeTotals();
  const order = {
    id: crypto.randomUUID(),
    channel: state.channel,
    status: 'completed',
    payment_method: state.paymentMethod,
    subtotal: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
    shipping_fee: state.channel === 'online' ? Number(state.shippingFee) || 0 : 0,
    note: null,
    created_offline: !navigator.onLine,
  };
  const items = state.cart.map((i) => ({
    product_id: i.product_id,
    product_name: i.product_name,
    qty: i.qty,
    unit_price: i.unit_price,
    unit_cost: i.unit_cost,
  }));

  await queuePendingOrder(order, items);

  state.cart = [];
  state.discount = 0;
  state.shippingFee = 0;
  state.checkingOut = false;
  renderCart(container);

  showToast(
    navigator.onLine ? 'Đã lưu đơn hàng, đang đồng bộ...' : 'Đã lưu đơn hàng (offline), sẽ đồng bộ khi có mạng',
    'success'
  );

  if (navigator.onLine) syncPendingOrders({ silent: true });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
