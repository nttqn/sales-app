import { supabase } from '../lib/supabase.js';
import { cacheProducts, getCachedProducts } from '../lib/db.js';
import { showToast, showConfirm, formatCurrency } from '../lib/ui.js';

const state = {
  products: [],
  categories: [],
  filter: 'active', // 'active' | 'inactive' | 'all'
  categoryFilter: 'all', // 'all' | 'none' | <category id>
  search: '',
  editingId: null,
  editingCategoryId: null,
  realtimeChannel: null,
  categoryRealtimeChannel: null,
};

export async function renderProducts(container) {
  await Promise.all([loadProducts(), loadCategories()]);
  paint(container);
  subscribeRealtime(container);
}

async function loadProducts() {
  const { data, error } = await supabase.from('products').select('*, categories(name)').order('name');

  if (error) {
    // Offline hoặc lỗi mạng -> dùng cache local
    state.products = await getCachedProducts();
    return;
  }

  state.products = data;
  await cacheProducts(data);
}

async function loadCategories() {
  const { data, error } = await supabase.from('categories').select('*').order('name');
  if (!error) state.categories = data;
}

function subscribeRealtime(container) {
  if (!state.realtimeChannel) {
    state.realtimeChannel = supabase
      .channel('products-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, async () => {
        await loadProducts();
        paint(container);
      })
      .subscribe();
  }

  if (!state.categoryRealtimeChannel) {
    state.categoryRealtimeChannel = supabase
      .channel('categories-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, async () => {
        await loadCategories();
        await loadProducts();
        paint(container);
      })
      .subscribe();
  }
}

function getFilteredProducts() {
  let list = state.products;

  if (state.filter === 'active') list = list.filter((p) => p.is_active);
  else if (state.filter === 'inactive') list = list.filter((p) => !p.is_active);

  if (state.categoryFilter === 'none') list = list.filter((p) => !p.category_id);
  else if (state.categoryFilter !== 'all') list = list.filter((p) => p.category_id === state.categoryFilter);

  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(
      (p) => p.name.toLowerCase().includes(q) || (p.sku || '').toLowerCase().includes(q)
    );
  }

  return list;
}

function paint(container) {
  const list = getFilteredProducts();

  container.innerHTML = `
    <div class="section-header">
      <h2 class="page-title" style="margin-bottom: 0;">Sản phẩm &amp; Tồn kho</h2>
      <div style="display:flex; gap:6px;">
        <button id="btn-manage-categories" class="icon-btn" aria-label="Quản lý danh mục">
          <i data-lucide="tags"></i>
        </button>
        <button id="btn-add-product" class="icon-btn" aria-label="Thêm sản phẩm">
          <i data-lucide="plus-circle"></i>
        </button>
      </div>
    </div>

    <div class="search-bar-wrap">
      <input type="text" id="product-search" class="form-input" placeholder="Tìm theo tên hoặc SKU..." value="${escapeAttr(state.search)}">
    </div>

    <div class="filter-chips" style="margin: 12px 0 8px;">
      <button class="chip ${state.filter === 'active' ? 'active' : ''}" data-filter="active">Đang bán</button>
      <button class="chip ${state.filter === 'inactive' ? 'active' : ''}" data-filter="inactive">Ngừng bán</button>
      <button class="chip ${state.filter === 'all' ? 'active' : ''}" data-filter="all">Tất cả</button>
    </div>

    <div class="filter-chips" style="margin-bottom: 12px;">
      <button class="chip ${state.categoryFilter === 'all' ? 'active' : ''}" data-category-filter="all">Tất cả danh mục</button>
      ${state.categories.map((c) => `<button class="chip ${state.categoryFilter === c.id ? 'active' : ''}" data-category-filter="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
      <button class="chip ${state.categoryFilter === 'none' ? 'active' : ''}" data-category-filter="none">Chưa phân loại</button>
    </div>

    <div id="product-list">
      ${list.length === 0 ? emptyStateHtml() : list.map(productRowHtml).join('')}
    </div>

    ${productModalHtml()}
    ${stockModalHtml()}
    ${historyModalHtml()}
    ${categoryModalHtml()}
  `;

  wireEvents(container);
  refreshIcons();
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <span class="empty-icon">📦</span>
      <p>Chưa có sản phẩm nào</p>
      <p class="empty-sub">Bấm nút + ở góc trên để thêm sản phẩm đầu tiên</p>
    </div>`;
}

function productRowHtml(p) {
  const lowStock = Number(p.stock_qty) <= Number(p.low_stock_threshold);
  const categoryName = p.categories?.name;
  return `
    <div class="card product-row" data-id="${p.id}">
      <div class="product-row-main">
        <div>
          <div class="product-name">${escapeHtml(p.name)} ${p.is_active ? '' : '<span class="badge-muted">Ngừng bán</span>'}</div>
          <div class="product-sub">${escapeHtml(p.sku || '(không SKU)')} ${categoryName ? '· ' + escapeHtml(categoryName) : ''}</div>
        </div>
        <div class="product-prices">
          <div class="product-sell">${formatCurrency(p.sell_price)}</div>
          <div class="product-cost">Vốn: ${formatCurrency(p.cost_price)}</div>
        </div>
      </div>
      <div class="product-row-footer">
        <span class="stock-badge ${lowStock ? 'low' : ''}">
          <i data-lucide="${lowStock ? 'alert-triangle' : 'box'}"></i>
          Tồn: ${p.stock_qty}
        </span>
        <div class="product-actions">
          <button class="btn-icon-text btn-history-product" data-id="${p.id}">
            <i data-lucide="history"></i> Lịch sử
          </button>
          <button class="btn-icon-text btn-adjust-stock" data-id="${p.id}">
            <i data-lucide="package-plus"></i> Điều chỉnh
          </button>
          <button class="btn-icon-text btn-edit-product" data-id="${p.id}">
            <i data-lucide="pencil"></i> Sửa
          </button>
        </div>
      </div>
    </div>`;
}

function productModalHtml() {
  return `
    <div id="modal-product" class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3 id="product-modal-title">Thêm sản phẩm</h3>
          <button class="icon-btn close-product-modal" aria-label="Đóng"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <form id="form-product">
            <div class="form-section">
              <label class="form-label" for="pf-name">Tên sản phẩm</label>
              <input type="text" id="pf-name" class="form-input" required>
            </div>
            <div class="form-section">
              <label class="form-label" for="pf-sku">SKU (mã sản phẩm, tùy chọn)</label>
              <input type="text" id="pf-sku" class="form-input">
            </div>
            <div class="form-section">
              <label class="form-label" for="pf-category">Danh mục</label>
              <select id="pf-category" class="form-input">
                <option value="">(Không có danh mục)</option>
                ${state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="form-section" style="display:flex; gap:10px;">
              <div style="flex:1;">
                <label class="form-label" for="pf-cost">Giá vốn</label>
                <input type="number" id="pf-cost" class="form-input" min="0" step="1000" required>
              </div>
              <div style="flex:1;">
                <label class="form-label" for="pf-sell">Giá bán</label>
                <input type="number" id="pf-sell" class="form-input" min="0" step="1000" required>
              </div>
            </div>
            <div class="form-section" style="display:flex; gap:10px;">
              <div style="flex:1;">
                <label class="form-label" for="pf-stock">Tồn kho ban đầu</label>
                <input type="number" id="pf-stock" class="form-input" min="0" step="1" required>
              </div>
              <div style="flex:1;">
                <label class="form-label" for="pf-threshold">Ngưỡng cảnh báo</label>
                <input type="number" id="pf-threshold" class="form-input" min="0" step="1" value="5" required>
              </div>
            </div>
            <div class="form-section" id="pf-active-section" style="display:none;">
              <label class="form-label" style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="pf-active" style="width:auto;"> Đang bán sản phẩm này
              </label>
            </div>
            <button type="submit" class="btn-primary"><span id="pf-submit-label">Lưu sản phẩm</span></button>
          </form>
        </div>
      </div>
    </div>`;
}

function stockModalHtml() {
  return `
    <div id="modal-stock" class="modal-overlay">
      <div class="modal modal-sm">
        <div class="modal-header">
          <h3>Điều chỉnh tồn kho</h3>
          <button class="icon-btn close-stock-modal" aria-label="Đóng"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <form id="form-stock">
            <p id="stock-product-name" class="form-label" style="margin-bottom:16px;"></p>
            <div class="form-section">
              <label class="form-label" for="sf-reason">Lý do</label>
              <select id="sf-reason" class="form-input">
                <option value="restock">Nhập kho</option>
                <option value="adjustment">Điều chỉnh (kiểm kê, hư hỏng...)</option>
              </select>
            </div>
            <div class="form-section">
              <label class="form-label" for="sf-qty">Số lượng thay đổi (dùng số âm để xuất kho)</label>
              <input type="number" id="sf-qty" class="form-input" step="1" required>
            </div>
            <div class="form-section">
              <label class="form-label" for="sf-note">Ghi chú</label>
              <input type="text" id="sf-note" class="form-input" placeholder="Tùy chọn">
            </div>
            <button type="submit" class="btn-primary">Xác nhận</button>
          </form>
        </div>
      </div>
    </div>`;
}

function historyModalHtml() {
  return `
    <div id="modal-history" class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3 id="history-product-name">Lịch sử tồn kho</h3>
          <button class="icon-btn close-history-modal" aria-label="Đóng"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <div id="history-list"><p class="form-label">Đang tải...</p></div>
        </div>
      </div>
    </div>`;
}

function categoryModalHtml() {
  return `
    <div id="modal-category" class="modal-overlay">
      <div class="modal">
        <div class="modal-header">
          <h3>Quản lý danh mục</h3>
          <button class="icon-btn close-category-modal" aria-label="Đóng"><i data-lucide="x"></i></button>
        </div>
        <div class="modal-body">
          <form id="form-category-add" class="category-add-row">
            <input type="text" id="cf-name" class="form-input" placeholder="Tên danh mục mới" required>
            <button type="submit" class="icon-btn category-add-btn" aria-label="Thêm danh mục"><i data-lucide="plus"></i></button>
          </form>
          <div id="category-manage-list" class="category-manage-list">
            ${categoryListHtml()}
          </div>
        </div>
      </div>
    </div>`;
}

function categoryListHtml() {
  if (!state.categories.length) {
    return `<p class="empty-sub" style="padding: 12px 0;">Chưa có danh mục nào</p>`;
  }
  return state.categories.map(categoryRowHtml).join('');
}

function categoryRowHtml(c) {
  if (state.editingCategoryId === c.id) {
    return `
      <div class="category-row" data-id="${c.id}">
        <input type="text" class="form-input category-edit-input" data-id="${c.id}" value="${escapeAttr(c.name)}">
        <div class="category-row-actions">
          <button class="icon-btn-sm btn-save-category" data-id="${c.id}" aria-label="Lưu"><i data-lucide="check"></i></button>
          <button class="icon-btn-sm btn-cancel-edit-category" aria-label="Hủy"><i data-lucide="x"></i></button>
        </div>
      </div>`;
  }
  return `
    <div class="category-row" data-id="${c.id}">
      <span class="category-name">${escapeHtml(c.name)}</span>
      <div class="category-row-actions">
        <button class="icon-btn-sm btn-edit-category" data-id="${c.id}" aria-label="Sửa"><i data-lucide="pencil"></i></button>
        <button class="icon-btn-sm btn-delete-category" data-id="${c.id}" aria-label="Xóa"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`;
}

function renderCategoryList(container) {
  const el = container.querySelector('#category-manage-list');
  if (!el) return;
  el.innerHTML = categoryListHtml();
  refreshIcons();
}

function wireEvents(container) {
  container.querySelector('#btn-add-product').addEventListener('click', () => openProductModal(container, null));

  container.querySelector('#product-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    paint(container);
  });

  container.querySelectorAll('.filter-chips [data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.filter = chip.dataset.filter;
      paint(container);
    });
  });

  container.querySelectorAll('.filter-chips [data-category-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.categoryFilter = chip.dataset.categoryFilter;
      paint(container);
    });
  });

  container.querySelectorAll('.btn-edit-product').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = state.products.find((p) => p.id === btn.dataset.id);
      openProductModal(container, product);
    });
  });

  container.querySelectorAll('.btn-adjust-stock').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = state.products.find((p) => p.id === btn.dataset.id);
      openStockModal(container, product);
    });
  });

  container.querySelectorAll('.btn-history-product').forEach((btn) => {
    btn.addEventListener('click', () => {
      const product = state.products.find((p) => p.id === btn.dataset.id);
      openHistoryModal(container, product);
    });
  });

  const historyModal = container.querySelector('#modal-history');
  container.querySelector('.close-history-modal').addEventListener('click', () => closeModal(historyModal));
  historyModal.addEventListener('click', (e) => { if (e.target === historyModal) closeModal(historyModal); });

  const productModal = container.querySelector('#modal-product');
  container.querySelector('.close-product-modal').addEventListener('click', () => closeModal(productModal));
  productModal.addEventListener('click', (e) => { if (e.target === productModal) closeModal(productModal); });
  container.querySelector('#form-product').addEventListener('submit', (e) => handleProductSubmit(e, container));

  const stockModal = container.querySelector('#modal-stock');
  container.querySelector('.close-stock-modal').addEventListener('click', () => closeModal(stockModal));
  stockModal.addEventListener('click', (e) => { if (e.target === stockModal) closeModal(stockModal); });
  container.querySelector('#form-stock').addEventListener('submit', (e) => handleStockSubmit(e, container));

  wireCategoryModal(container);
}

function wireCategoryModal(container) {
  const categoryModal = container.querySelector('#modal-category');

  container.querySelector('#btn-manage-categories').addEventListener('click', () => {
    state.editingCategoryId = null;
    renderCategoryList(container);
    openModal(categoryModal);
  });

  const closeCategoryModalAndRefresh = async () => {
    closeModal(categoryModal);
    await loadCategories();
    await loadProducts();
    paint(container);
  };

  container.querySelector('.close-category-modal').addEventListener('click', closeCategoryModalAndRefresh);
  container.querySelector('#form-category-add').addEventListener('submit', (e) => handleCategoryAdd(e, container));

  categoryModal.addEventListener('click', async (e) => {
    if (e.target === categoryModal) {
      await closeCategoryModalAndRefresh();
      return;
    }

    const editBtn = e.target.closest('.btn-edit-category');
    if (editBtn) {
      state.editingCategoryId = editBtn.dataset.id;
      renderCategoryList(container);
      return;
    }

    const cancelBtn = e.target.closest('.btn-cancel-edit-category');
    if (cancelBtn) {
      state.editingCategoryId = null;
      renderCategoryList(container);
      return;
    }

    const saveBtn = e.target.closest('.btn-save-category');
    if (saveBtn) {
      await handleCategorySave(saveBtn.dataset.id, container);
      return;
    }

    const deleteBtn = e.target.closest('.btn-delete-category');
    if (deleteBtn) {
      await handleCategoryDelete(deleteBtn.dataset.id, container);
    }
  });
}

function openModal(modal) {
  modal.classList.add('active');
  refreshIcons();
}
function closeModal(modal) {
  modal.classList.remove('active');
}

function openProductModal(container, product) {
  state.editingId = product ? product.id : null;
  const modal = container.querySelector('#modal-product');

  container.querySelector('#product-modal-title').textContent = product ? 'Sửa sản phẩm' : 'Thêm sản phẩm';
  container.querySelector('#pf-submit-label').textContent = product ? 'Cập nhật' : 'Lưu sản phẩm';
  container.querySelector('#pf-name').value = product?.name ?? '';
  container.querySelector('#pf-sku').value = product?.sku ?? '';
  container.querySelector('#pf-category').value = product?.category_id ?? '';
  container.querySelector('#pf-cost').value = product?.cost_price ?? '';
  container.querySelector('#pf-sell').value = product?.sell_price ?? '';
  container.querySelector('#pf-stock').value = product ? product.stock_qty : 0;
  container.querySelector('#pf-stock').disabled = !!product; // sửa tồn kho phải qua "Điều chỉnh" để có ledger
  container.querySelector('#pf-threshold').value = product?.low_stock_threshold ?? 5;

  const activeSection = container.querySelector('#pf-active-section');
  if (product) {
    activeSection.style.display = '';
    container.querySelector('#pf-active').checked = product.is_active;
  } else {
    activeSection.style.display = 'none';
  }

  openModal(modal);
}

function openStockModal(container, product) {
  state.editingId = product.id;
  container.querySelector('#stock-product-name').textContent = `${product.name} — tồn hiện tại: ${product.stock_qty}`;
  container.querySelector('#sf-qty').value = '';
  container.querySelector('#sf-note').value = '';
  openModal(container.querySelector('#modal-stock'));
}

async function openHistoryModal(container, product) {
  container.querySelector('#history-product-name').textContent = `Lịch sử tồn kho — ${product.name}`;
  const listEl = container.querySelector('#history-list');
  listEl.innerHTML = '<p class="form-label">Đang tải...</p>';
  openModal(container.querySelector('#modal-history'));

  const { data, error } = await supabase
    .from('stock_movements')
    .select('*')
    .eq('product_id', product.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    listEl.innerHTML = `<p class="form-label">Lỗi khi tải lịch sử: ${escapeHtml(error.message)}</p>`;
    return;
  }

  if (data.length === 0) {
    listEl.innerHTML = emptyStateHtml();
    return;
  }

  const reasonLabel = { sale: 'Bán hàng', restock: 'Nhập kho', adjustment: 'Điều chỉnh' };

  listEl.innerHTML = data
    .map((m) => {
      const positive = Number(m.qty_change) > 0;
      return `
        <div class="history-row">
          <div>
            <div class="history-reason">${reasonLabel[m.reason] || m.reason}</div>
            <div class="history-date">${new Date(m.created_at).toLocaleString('vi-VN')}${m.note ? ' · ' + escapeHtml(m.note) : ''}</div>
          </div>
          <div class="history-qty ${positive ? 'positive' : 'negative'}">${positive ? '+' : ''}${m.qty_change}</div>
        </div>`;
    })
    .join('');
}

async function handleProductSubmit(e, container) {
  e.preventDefault();
  const payload = {
    name: container.querySelector('#pf-name').value.trim(),
    sku: container.querySelector('#pf-sku').value.trim() || null,
    category_id: container.querySelector('#pf-category').value || null,
    cost_price: parseFloat(container.querySelector('#pf-cost').value),
    sell_price: parseFloat(container.querySelector('#pf-sell').value),
    low_stock_threshold: parseFloat(container.querySelector('#pf-threshold').value),
  };

  try {
    if (state.editingId) {
      payload.is_active = container.querySelector('#pf-active').checked;
      const { error } = await supabase.from('products').update(payload).eq('id', state.editingId);
      if (error) throw error;
      showToast('Đã cập nhật sản phẩm', 'success');
    } else {
      payload.stock_qty = parseFloat(container.querySelector('#pf-stock').value) || 0;
      const { error } = await supabase.from('products').insert(payload);
      if (error) throw error;
      showToast('Đã thêm sản phẩm', 'success');
    }

    closeModal(container.querySelector('#modal-product'));
    await loadProducts();
    paint(container);
  } catch (err) {
    showToast(err.message || 'Lỗi khi lưu sản phẩm', 'error');
  }
}

async function handleStockSubmit(e, container) {
  e.preventDefault();
  const productId = state.editingId;
  const qtyChange = parseFloat(container.querySelector('#sf-qty').value);
  const reason = container.querySelector('#sf-reason').value;
  const note = container.querySelector('#sf-note').value.trim() || null;

  if (!qtyChange) {
    showToast('Vui lòng nhập số lượng khác 0', 'error');
    return;
  }

  try {
    const { error } = await supabase.rpc('adjust_stock', {
      p_product_id: productId,
      p_qty_change: qtyChange,
      p_reason: reason,
      p_note: note,
    });
    if (error) throw error;

    showToast('Đã điều chỉnh tồn kho', 'success');
    closeModal(container.querySelector('#modal-stock'));
    await loadProducts();
    paint(container);
  } catch (err) {
    showToast(err.message || 'Lỗi khi điều chỉnh tồn kho', 'error');
  }
}

async function handleCategoryAdd(e, container) {
  e.preventDefault();
  const input = container.querySelector('#cf-name');
  const name = input.value.trim();
  if (!name) return;

  try {
    const { error } = await supabase.from('categories').insert({ name });
    if (error) throw error;
    input.value = '';
    await loadCategories();
    renderCategoryList(container);
    showToast('Đã thêm danh mục', 'success');
  } catch (err) {
    showToast(err.message || 'Lỗi khi thêm danh mục', 'error');
  }
}

async function handleCategorySave(categoryId, container) {
  const input = container.querySelector(`.category-edit-input[data-id="${categoryId}"]`);
  const name = input.value.trim();
  if (!name) {
    showToast('Tên danh mục không được để trống', 'error');
    return;
  }

  try {
    const { error } = await supabase.from('categories').update({ name }).eq('id', categoryId);
    if (error) throw error;
    state.editingCategoryId = null;
    await loadCategories();
    renderCategoryList(container);
    showToast('Đã cập nhật danh mục', 'success');
  } catch (err) {
    showToast(err.message || 'Lỗi khi cập nhật danh mục', 'error');
  }
}

async function handleCategoryDelete(categoryId, container) {
  const category = state.categories.find((c) => c.id === categoryId);
  const confirmed = await showConfirm(
    'Xóa danh mục',
    `Xóa danh mục "${category?.name ?? ''}"? Sản phẩm thuộc danh mục này sẽ chuyển về "Chưa phân loại".`
  );
  if (!confirmed) return;

  try {
    const { error } = await supabase.from('categories').delete().eq('id', categoryId);
    if (error) throw error;
    await loadCategories();
    renderCategoryList(container);
    showToast('Đã xóa danh mục', 'success');
  } catch (err) {
    showToast(err.message || 'Lỗi khi xóa danh mục', 'error');
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
