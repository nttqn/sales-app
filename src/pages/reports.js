import { supabase } from '../lib/supabase.js';
import { showToast, formatCurrency } from '../lib/ui.js';

const state = {
  period: 'daily', // 'daily' | 'monthly'
  orders: [],
  chart: null,
};

export async function renderReports(container) {
  await loadOrders();
  paint(container);
  renderChart(container);
}

function rangeStart() {
  const now = new Date();
  if (state.period === 'daily') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() - 29);
    return d;
  }
  return new Date(now.getFullYear(), now.getMonth() - 11, 1);
}

async function loadOrders() {
  const start = rangeStart();
  const { data, error } = await supabase
    .from('orders')
    .select('id, total, discount, subtotal, shipping_fee, status, created_at, order_items(qty, unit_price, unit_cost, product_name)')
    .in('status', ['completed', 'returned', 'lost'])
    .gte('created_at', start.toISOString())
    .order('created_at', { ascending: true });

  if (error) {
    state.orders = [];
    showToast('Không tải được dữ liệu báo cáo', 'error');
    return;
  }
  state.orders = data;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function dayKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function monthKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
}
function bucketKey(date) {
  return state.period === 'daily' ? dayKey(date) : monthKey(date);
}

// Chỉ đơn 'completed' đóng góp doanh thu/giá vốn. Đơn 'returned' không có doanh thu (hàng đã
// trả lại) nhưng vẫn mất phí vận chuyển -> lỗ đúng bằng phí ship. Đơn 'lost' mất cả giá vốn
// hàng (không quay lại kho) lẫn phí vận chuyển.
function computeSeries() {
  const map = new Map();
  for (const o of state.orders) {
    const key = bucketKey(o.created_at);
    const cur = map.get(key) || { revenue: 0, cogs: 0, shipping: 0 };
    const shippingFee = Number(o.shipping_fee) || 0;
    const itemsCogs = (o.order_items || []).reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0);
    if (o.status === 'completed') {
      cur.revenue += Number(o.total);
      cur.shipping += shippingFee;
      cur.cogs += itemsCogs;
    } else if (o.status === 'returned') {
      cur.shipping += shippingFee;
    } else if (o.status === 'lost') {
      cur.shipping += shippingFee;
      cur.cogs += itemsCogs;
    }
    map.set(key, cur);
  }

  const labels = [];
  const now = new Date();
  if (state.period === 'daily') {
    for (let d = rangeStart(); d <= now; d.setDate(d.getDate() + 1)) {
      labels.push(dayKey(d));
    }
  } else {
    for (let d = rangeStart(); d <= now; d.setMonth(d.getMonth() + 1)) {
      labels.push(monthKey(d));
    }
  }

  const revenue = labels.map((k) => map.get(k)?.revenue || 0);
  const cogs = labels.map((k) => map.get(k)?.cogs || 0);
  const shipping = labels.map((k) => map.get(k)?.shipping || 0);
  const profit = labels.map((k, i) => revenue[i] - cogs[i] - shipping[i]);
  return { labels, revenue, cogs, shipping, profit };
}

function computeTopProducts() {
  const map = new Map();
  for (const o of state.orders) {
    if (o.status !== 'completed') continue; // hàng trả lại không tính là bán chạy
    for (const it of o.order_items || []) {
      const cur = map.get(it.product_name) || { name: it.product_name, qty: 0, revenue: 0, cogs: 0 };
      cur.qty += Number(it.qty);
      cur.revenue += Number(it.qty) * Number(it.unit_price);
      cur.cogs += Number(it.qty) * Number(it.unit_cost);
      map.set(it.product_name, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10);
}

function computeTotals() {
  let revenue = 0;
  let cogs = 0;
  let shipping = 0;
  for (const o of state.orders) {
    const shippingFee = Number(o.shipping_fee) || 0;
    const itemsCogs = (o.order_items || []).reduce((s, it) => s + Number(it.qty) * Number(it.unit_cost), 0);
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
  return { revenue, cogs, shipping, profit: revenue - cogs - shipping };
}

function paint(container) {
  const totals = computeTotals();
  const topProducts = computeTopProducts();

  container.innerHTML = `
    <h2 class="page-title">Báo cáo</h2>

    <div class="filter-chips" style="margin-bottom: 16px;">
      <button class="chip ${state.period === 'daily' ? 'active' : ''}" data-period="daily">30 ngày qua</button>
      <button class="chip ${state.period === 'monthly' ? 'active' : ''}" data-period="monthly">12 tháng qua</button>
      <button id="btn-export-csv" class="chip">Xuất CSV</button>
    </div>

    <div class="stat-grid">
      <div class="card stat-card">
        <span class="stat-label">Doanh thu</span>
        <span class="stat-value">${formatCurrency(totals.revenue)}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Giá vốn hàng bán</span>
        <span class="stat-value">${formatCurrency(totals.cogs)}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Phí vận chuyển</span>
        <span class="stat-value">${formatCurrency(totals.shipping)}</span>
      </div>
      <div class="card stat-card">
        <span class="stat-label">Lợi nhuận thực tế</span>
        <span class="stat-value">${formatCurrency(totals.profit)}</span>
      </div>
    </div>

    <div class="card">
      <div class="chart-wrap">
        <canvas id="reports-chart"></canvas>
      </div>
    </div>

    <div class="section-header">
      <span class="section-title">Top sản phẩm</span>
    </div>
    ${
      topProducts.length
        ? `<div class="card">${topProducts.map(topProductRowHtml).join('')}</div>`
        : `<p class="empty-sub">Chưa có dữ liệu trong khoảng thời gian này</p>`
    }
  `;

  wireEvents(container);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function topProductRowHtml(p, i) {
  return `
    <div class="history-row">
      <div>
        <div class="history-reason">#${i + 1} ${escapeHtml(p.name)}</div>
        <div class="history-date">SL: ${p.qty} · Vốn: ${formatCurrency(p.cogs)}</div>
      </div>
      <div class="history-qty positive">${formatCurrency(p.revenue)}</div>
    </div>`;
}

function formatLabel(key) {
  if (state.period === 'daily') {
    const [, m, d] = key.split('-');
    return `${d}/${m}`;
  }
  const [y, m] = key.split('-');
  return `${m}/${y}`;
}

function renderChart(container) {
  const canvas = container.querySelector('#reports-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  const { labels, revenue, profit } = computeSeries();

  state.chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: labels.map(formatLabel),
      datasets: [
        {
          label: 'Doanh thu',
          data: revenue,
          borderColor: '#818cf8',
          backgroundColor: 'rgba(129,140,248,0.15)',
          tension: 0.3,
          fill: true,
        },
        {
          label: 'Lợi nhuận',
          data: profit,
          borderColor: '#22c55e',
          backgroundColor: 'rgba(34,197,94,0.15)',
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#9494b0' } } },
      scales: {
        x: { ticks: { color: '#58586f' }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#58586f' }, grid: { color: 'rgba(255,255,255,0.05)' } },
      },
    },
  });
}

function wireEvents(container) {
  container.querySelectorAll('[data-period]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      state.period = chip.dataset.period;
      await loadOrders();
      paint(container);
      renderChart(container);
    });
  });

  const exportBtn = container.querySelector('#btn-export-csv');
  if (exportBtn) exportBtn.addEventListener('click', exportCsv);
}

function exportCsv() {
  const { labels, revenue, cogs, shipping, profit } = computeSeries();
  const rows = [['Kỳ', 'Doanh thu', 'Giá vốn', 'Phí vận chuyển', 'Lợi nhuận']];
  labels.forEach((l, i) => rows.push([l, revenue[i], cogs[i], shipping[i], profit[i]]));

  const csv = rows.map((r) => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `bao-cao-${state.period}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
