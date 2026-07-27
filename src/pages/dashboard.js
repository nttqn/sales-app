import { supabase } from '../lib/supabase.js';
import { getPendingOrders } from '../lib/db.js';
import { formatCurrency } from '../lib/ui.js';

export async function renderDashboard(container) {
  container.innerHTML = `
    <h2 class="page-title">Tổng quan</h2>
    <div class="loading-screen" style="min-height: 200px;">
      <div class="spinner"></div>
    </div>`;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [ordersRes, productsRes, pendingLocal] = await Promise.all([
    supabase
      .from('orders')
      .select('id, total, discount, shipping_fee, status, sync_status, created_at, order_items(qty, unit_price, unit_cost, product_name)')
      .in('status', ['completed', 'returned', 'lost'])
      .gte('created_at', monthStart.toISOString()),
    supabase
      .from('products')
      .select('id, name, stock_qty, low_stock_threshold')
      .eq('is_active', true),
    getPendingOrders(),
  ]);

  if (ordersRes.error || productsRes.error) {
    const err = ordersRes.error || productsRes.error;
    container.innerHTML = `
      <h2 class="page-title">Tổng quan</h2>
      <div class="empty-state">
        <span class="empty-icon">⚠️</span>
        <p>Không tải được dữ liệu tổng quan</p>
        <p class="empty-sub">${escapeHtml(err.message)}</p>
      </div>`;
    return;
  }

  const monthOrders = ordersRes.data;
  const todayOrders = monthOrders.filter((o) => new Date(o.created_at) >= todayStart);

  const monthStats = computeStats(monthOrders);
  const todayStats = computeStats(todayOrders);

  const lowStock = productsRes.data
    .filter((p) => Number(p.stock_qty) <= Number(p.low_stock_threshold))
    .sort((a, b) => Number(a.stock_qty) - Number(b.stock_qty));

  const conflictCount = monthOrders.filter((o) => o.sync_status === 'conflict').length;
  const pendingCount = pendingLocal.length;
  const topProducts = computeTopProducts(monthOrders.filter((o) => o.status === 'completed')).slice(0, 5);

  container.innerHTML = `
    <h2 class="page-title">Tổng quan</h2>

    <div class="stat-grid">
      <div class="card stat-card">
        <span class="stat-label">Doanh thu hôm nay</span>
        <span class="stat-value">${formatCurrency(todayStats.revenue)}</span>
        <span class="stat-sub">Lợi nhuận: ${formatCurrency(todayStats.profit)}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Doanh thu tháng này</span>
        <span class="stat-value">${formatCurrency(monthStats.revenue)}</span>
        <span class="stat-sub">Lợi nhuận: ${formatCurrency(monthStats.profit)}</span>
      </div>
    </div>

    ${
      pendingCount > 0 || conflictCount > 0
        ? `<div class="card alert-card">
            <i data-lucide="alert-triangle"></i>
            <div>
              ${pendingCount > 0 ? `<p>${pendingCount} đơn đang chờ đồng bộ trên thiết bị này</p>` : ''}
              ${conflictCount > 0 ? `<p>${conflictCount} đơn cần đối soát tồn kho (bán vượt tồn lúc offline)</p>` : ''}
            </div>
          </div>`
        : ''
    }

    <div class="section-header">
      <span class="section-title">Cảnh báo tồn kho thấp</span>
    </div>
    ${
      lowStock.length
        ? `<div class="card">${lowStock.slice(0, 8).map(lowStockRowHtml).join('')}</div>`
        : `<p class="empty-sub" style="margin-bottom:16px;">Không có sản phẩm nào sắp hết hàng</p>`
    }

    <div class="section-header">
      <span class="section-title">Sản phẩm bán chạy tháng này</span>
    </div>
    ${
      topProducts.length
        ? `<div class="card">${topProducts.map(topProductRowHtml).join('')}</div>`
        : `<p class="empty-sub">Chưa có đơn hàng nào tháng này</p>`
    }
  `;

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Chỉ đơn 'completed' đóng góp doanh thu/giá vốn thật. Đơn 'returned' không có doanh thu
// (hàng đã trả lại) nhưng vẫn mất phí vận chuyển -> lỗ đúng bằng phí ship. Đơn 'lost' mất cả
// giá vốn hàng (không quay lại kho) lẫn phí vận chuyển. Đơn new/shipping/cancelled không được
// truyền vào đây (đã lọc ở query .in('status', ...)).
function computeStats(orders) {
  let revenue = 0;
  let cogs = 0;
  let shipping = 0;
  for (const o of orders) {
    const shippingFee = Number(o.shipping_fee) || 0;
    const itemsCogs = (o.order_items || []).reduce((s, item) => s + Number(item.qty) * Number(item.unit_cost), 0);
    if (o.status === 'completed') {
      revenue += Number(o.total);
      shipping += shippingFee;
      cogs += itemsCogs;
    } else if (o.status === 'returned') {
      shipping += shippingFee;
    } else if (o.status === 'lost') {
      shipping += shippingFee;
      cogs += itemsCogs;
    }
  }
  return { revenue, profit: revenue - cogs - shipping };
}

function computeTopProducts(orders) {
  const map = new Map();
  for (const o of orders) {
    for (const item of o.order_items || []) {
      const cur = map.get(item.product_name) || { name: item.product_name, qty: 0, revenue: 0 };
      cur.qty += Number(item.qty);
      cur.revenue += Number(item.qty) * Number(item.unit_price);
      map.set(item.product_name, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty);
}

function lowStockRowHtml(p) {
  return `
    <div class="history-row">
      <div>
        <div class="history-reason">${escapeHtml(p.name)}</div>
        <div class="history-date">Ngưỡng cảnh báo: ${p.low_stock_threshold}</div>
      </div>
      <div class="history-qty negative">${p.stock_qty}</div>
    </div>`;
}

function topProductRowHtml(p, i) {
  return `
    <div class="history-row">
      <div>
        <div class="history-reason">#${i + 1} ${escapeHtml(p.name)}</div>
        <div class="history-date">${formatCurrency(p.revenue)}</div>
      </div>
      <div class="history-qty positive">${p.qty}</div>
    </div>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
