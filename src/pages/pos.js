import { supabase } from '../lib/supabase.js';
import {
  cacheProducts,
  getCachedProducts,
  cacheCustomers,
  getCachedCustomers,
  queuePendingOrder,
} from '../lib/db.js';
import { showToast, formatCurrency } from '../lib/ui.js';
import { syncPendingOrders } from '../lib/sync.js';

const DEFAULT_ONLINE_SHIPPING_FEE = 14000;

const state = {
  products: [],
  search: '',
  cart: [], // { product_id, product_name, unit_price, unit_cost, qty, stock_qty }
  channel: 'in_store',
  paymentMethod: 'cash',
  discount: 0,
  shippingFee: 0, // chi phí ship trả cho đơn vị vận chuyển (kênh online), không phải phí thu khách
  customers: [],
  customer: { name: '', phone: '', address: '', note: '' },
  customerSuggestions: [],
  editingPriceIdx: null, // index của dòng giỏ hàng đang sửa giá bán (chỉ áp dụng cho đơn này)
  realtimeChannel: null,
  customerRealtimeChannel: null,
  checkingOut: false,
  eventsWired: false,
};

export async function renderPos(container) {
  await Promise.all([loadProducts(), loadCustomers()]);
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

async function loadCustomers() {
  if (navigator.onLine) {
    const { data, error } = await supabase.from('customers').select('*');
    if (!error) {
      state.customers = data;
      await cacheCustomers(data);
      return;
    }
  }
  state.customers = await getCachedCustomers();
}

function subscribeRealtime(container) {
  if (!state.realtimeChannel) {
    state.realtimeChannel = supabase
      .channel('pos-products-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, async () => {
        await loadProducts();
        renderProductGrid(container);
      })
      .subscribe();
  }

  if (!state.customerRealtimeChannel) {
    state.customerRealtimeChannel = supabase
      .channel('pos-customers-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customers' }, async () => {
        await loadCustomers();
      })
      .subscribe();
  }
}

function getFilteredProducts() {
  const q = state.search.trim().toLowerCase();
  if (!q) return state.products;
  return state.products.filter(
    (p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)
  );
}

function updateCustomerSuggestions() {
  const q = state.customer.phone.trim();
  if (!q) {
    state.customerSuggestions = [];
    return;
  }
  state.customerSuggestions = state.customers.filter((c) => c.phone.startsWith(q)).slice(0, 6);
}

function applyCustomerSuggestion(customerId) {
  const customer = state.customers.find((c) => c.id === customerId);
  if (!customer) return;
  state.customer = {
    name: customer.name,
    phone: customer.phone,
    address: customer.address || '',
    note: customer.note || '',
  };
  state.customerSuggestions = [];
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
    <div class="pos-product-card ${outOfStock ? 'out-of-stock' : ''}" data-id="${p.id}" role="button" tabindex="0">
      <span class="pos-copyable-wrap">
        <span class="pos-product-name">${escapeHtml(p.name)}</span>
        <button type="button" class="copy-btn" data-copy="${escapeAttr(p.name)}" data-copy-label="Đã sao chép tên sản phẩm" aria-label="Sao chép tên sản phẩm">
          <i data-lucide="copy"></i>
        </button>
      </span>
      <span class="pos-copyable-wrap">
        <span class="pos-product-price">${formatCurrency(p.sell_price)}</span>
        <button type="button" class="copy-btn" data-copy="${p.sell_price}" data-copy-label="Đã sao chép giá sản phẩm" aria-label="Sao chép giá sản phẩm">
          <i data-lucide="copy"></i>
        </button>
      </span>
      <span class="pos-product-stock ${outOfStock ? 'zero' : ''}">Tồn: ${p.stock_qty}</span>
    </div>`;
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

      <div id="pos-customer-section">
        ${customerSectionHtml()}
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
  const isEditingPrice = state.editingPriceIdx === idx;
  return `
    <div class="pos-cart-row" data-idx="${idx}">
      <div class="pos-cart-row-main">
        <span class="pos-cart-name">${escapeHtml(item.product_name)}</span>
        ${
          isEditingPrice
            ? `<span class="pos-cart-price pos-cart-price-editing">
                <input type="number" class="pos-price-input" data-idx="${idx}" value="${item.unit_price}" min="0" step="1000">
                <span>x ${item.qty}</span>
              </span>`
            : `<span class="pos-cart-price">
                ${formatCurrency(item.unit_price)} x ${item.qty}
                <button type="button" class="edit-price-btn" data-idx="${idx}" aria-label="Sửa giá bán">
                  <i data-lucide="pencil"></i>
                </button>
              </span>`
        }
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

function customerSectionHtml() {
  const required = state.channel === 'online';
  const mark = required ? ' *' : '';
  return `
    <div class="pos-customer-label">
      Thông tin khách hàng ${required ? '<span class="required-mark">*</span>' : '<span class="optional-mark">(tùy chọn)</span>'}
    </div>
    <div class="pos-customer-field" style="position: relative;">
      <input type="tel" id="pos-customer-phone" class="form-input" placeholder="Số điện thoại${mark}" value="${escapeAttr(state.customer.phone)}" autocomplete="off">
      <div id="pos-customer-suggestions">${customerSuggestionsHtml()}</div>
    </div>
    <div class="pos-customer-field">
      <input type="text" id="pos-customer-name" class="form-input" placeholder="Tên khách hàng${mark}" value="${escapeAttr(state.customer.name)}">
    </div>
    <div class="pos-customer-field">
      <input type="text" id="pos-customer-address" class="form-input" placeholder="Địa chỉ${mark}" value="${escapeAttr(state.customer.address)}">
    </div>
    <div class="pos-customer-field">
      <input type="text" id="pos-customer-note" class="form-input" placeholder="Lưu ý riêng (tùy chọn)" value="${escapeAttr(state.customer.note)}">
    </div>`;
}

function customerSuggestionsHtml() {
  if (!state.customerSuggestions.length) return '';
  return `
    <div class="customer-suggestions">
      ${state.customerSuggestions
        .map(
          (c) => `
        <button type="button" class="customer-suggestion-item" data-id="${c.id}">
          <span class="customer-suggestion-name">${escapeHtml(c.name)}</span>
          <span class="customer-suggestion-phone">${escapeHtml(c.phone)}</span>
        </button>`
        )
        .join('')}
    </div>`;
}

function renderCustomerSuggestions(container) {
  const el = container.querySelector('#pos-customer-suggestions');
  if (!el) return;
  el.innerHTML = customerSuggestionsHtml();
}

function renderCustomerSection(container) {
  const el = container.querySelector('#pos-customer-section');
  if (!el) return;
  el.innerHTML = customerSectionHtml();
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

function focusPriceInput(container) {
  const input = container.querySelector('.pos-price-input');
  if (input) {
    input.focus();
    input.select();
  }
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
  // #app-content là node cố định, không bị tạo lại mỗi lần vào trang Bán hàng (chỉ innerHTML
  // đổi) -> nếu không chặn, mỗi lần renderPos() chạy lại sẽ cộng dồn thêm 1 bộ listener lên
  // cùng node đó, khiến 1 click bị xử lý nhiều lần (số lượng giỏ hàng tự nhân đôi/ba/bốn...).
  if (state.eventsWired) return;
  state.eventsWired = true;

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
    if (e.target.id === 'pos-customer-phone') {
      state.customer.phone = e.target.value;
      updateCustomerSuggestions();
      renderCustomerSuggestions(container);
    }
    if (e.target.id === 'pos-customer-name') state.customer.name = e.target.value;
    if (e.target.id === 'pos-customer-address') state.customer.address = e.target.value;
    if (e.target.id === 'pos-customer-note') state.customer.note = e.target.value;
    if (e.target.classList.contains('pos-price-input')) {
      const item = state.cart[Number(e.target.dataset.idx)];
      if (item) {
        item.unit_price = Number(e.target.value) || 0;
        renderTotals(container);
      }
    }
  });

  container.addEventListener('change', (e) => {
    if (e.target.id === 'pos-payment') {
      state.paymentMethod = e.target.value;
    }
  });

  container.addEventListener('focusout', (e) => {
    if (e.target.id === 'pos-customer-phone') {
      // Delay so a click on a suggestion button registers before the list is hidden.
      setTimeout(() => {
        state.customerSuggestions = [];
        renderCustomerSuggestions(container);
      }, 150);
    }
    if (e.target.classList.contains('pos-price-input')) {
      state.editingPriceIdx = null;
      renderCart(container);
    }
  });

  container.addEventListener('keydown', (e) => {
    if (e.target.classList.contains('pos-price-input') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
  });

  container.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      copyToClipboard(copyBtn.dataset.copy, copyBtn.dataset.copyLabel);
      return;
    }

    const editPriceBtn = e.target.closest('.edit-price-btn');
    if (editPriceBtn) {
      state.editingPriceIdx = Number(editPriceBtn.dataset.idx);
      renderCart(container);
      focusPriceInput(container);
      return;
    }

    const card = e.target.closest('.pos-product-card');
    if (card && !card.classList.contains('out-of-stock')) {
      addToCart(card.dataset.id);
      renderCart(container);
      return;
    }

    const channelBtn = e.target.closest('#pos-channel .chip');
    if (channelBtn) {
      state.channel = channelBtn.dataset.channel;
      state.shippingFee = state.channel === 'online' ? DEFAULT_ONLINE_SHIPPING_FEE : 0;
      renderCart(container);
      return;
    }

    const suggestionBtn = e.target.closest('.customer-suggestion-item');
    if (suggestionBtn) {
      applyCustomerSuggestion(suggestionBtn.dataset.id);
      renderCustomerSection(container);
      return;
    }

    if (e.target.closest('#pos-clear-cart')) {
      state.cart = [];
      state.editingPriceIdx = null;
      renderCart(container);
      return;
    }

    const qtyBtn = e.target.closest('.qty-btn');
    if (qtyBtn) {
      changeQty(Number(qtyBtn.dataset.idx), qtyBtn.dataset.action === 'inc' ? 1 : -1);
      // changeQty() có thể xóa dòng khi số lượng về 0, làm dịch chỉ số các dòng sau.
      state.editingPriceIdx = null;
      renderCart(container);
      return;
    }

    const removeBtn = e.target.closest('.remove-cart-item');
    if (removeBtn) {
      state.cart.splice(Number(removeBtn.dataset.idx), 1);
      // Bỏ chỉ số dòng đang sửa giá vì mảng giỏ hàng đã dịch lại sau khi xóa,
      // tránh input giá bị lệch sang đúng dòng khác.
      state.editingPriceIdx = null;
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

  const customerName = state.customer.name.trim();
  const customerPhone = state.customer.phone.trim();
  const customerAddress = state.customer.address.trim();

  if (state.channel === 'online' && (!customerName || !customerPhone || !customerAddress)) {
    showToast('Đơn online bắt buộc phải có đầy đủ tên, số điện thoại và địa chỉ khách hàng', 'error');
    return;
  }

  state.checkingOut = true;
  renderTotals(container);

  const totals = computeTotals();
  const order = {
    id: crypto.randomUUID(),
    channel: state.channel,
    // status không set ở client — RPC create_order tự quyết định: 'completed'
    // ngay cho đơn tại quầy, 'new' cho đơn online để đi qua luồng fulfillment.
    payment_method: state.paymentMethod,
    subtotal: totals.subtotal,
    discount: totals.discount,
    total: totals.total,
    shipping_fee: state.channel === 'online' ? Number(state.shippingFee) || 0 : 0,
    customer_name: customerName || null,
    customer_phone: customerPhone || null,
    customer_address: customerAddress || null,
    customer_note: state.customer.note.trim() || null,
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
  state.shippingFee = state.channel === 'online' ? DEFAULT_ONLINE_SHIPPING_FEE : 0;
  state.customer = { name: '', phone: '', address: '', note: '' };
  state.customerSuggestions = [];
  state.editingPriceIdx = null;
  state.checkingOut = false;
  renderCart(container);

  showToast(
    navigator.onLine ? 'Đã lưu đơn hàng, đang đồng bộ...' : 'Đã lưu đơn hàng (offline), sẽ đồng bộ khi có mạng',
    'success'
  );

  if (navigator.onLine) syncPendingOrders({ silent: true });
}

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(String(text));
    showToast(label || 'Đã sao chép', 'success');
  } catch (err) {
    showToast('Không thể sao chép', 'error');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
