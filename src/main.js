import './styles/main.css';
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Legend,
  Tooltip,
  Filler,
} from 'chart.js';
import {
  createIcons,
  RefreshCw,
  Settings,
  LayoutDashboard,
  Receipt,
  ShoppingCart,
  Package,
  PieChart,
  X,
  LogOut,
  PlusCircle,
  History,
  PackagePlus,
  Pencil,
  Search,
  Trash2,
  AlertTriangle,
  Box,
  Tags,
  Plus,
  Check,
  Users,
  Truck,
} from 'lucide';
import { supabase } from './lib/supabase.js';

// Only the icons actually referenced via data-lucide="..." across the app —
// importing the full lucide icon barrel bloats the offline-precached bundle.
const usedIcons = {
  RefreshCw,
  Settings,
  LayoutDashboard,
  Receipt,
  ShoppingCart,
  Package,
  PieChart,
  X,
  LogOut,
  PlusCircle,
  History,
  PackagePlus,
  Pencil,
  Search,
  Trash2,
  AlertTriangle,
  Box,
  Tags,
  Plus,
  Check,
  Users,
  Truck,
};
import { showToast } from './lib/ui.js';
import { initSync, syncPendingOrders, onSyncStateChange } from './lib/sync.js';
import { renderLogin } from './pages/login.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderPos } from './pages/pos.js';
import { renderOrders } from './pages/orders.js';
import { renderProducts } from './pages/products.js';
import { renderReports } from './pages/reports.js';
import { renderCustomers } from './pages/customers.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Legend, Tooltip, Filler);
window.Chart = Chart;
window.lucide = { createIcons: () => createIcons({ icons: usedIcons }) };

const appContentEl = document.getElementById('app-content');
const shellEls = {
  header: document.querySelector('.app-header'),
  nav: document.querySelector('.bottom-nav'),
};

const pages = {
  dashboard: renderDashboard,
  pos: renderPos,
  orders: renderOrders,
  products: renderProducts,
  reports: renderReports,
  customers: renderCustomers,
};

const state = { currentPage: 'dashboard' };

function refreshIcons() {
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function setShellVisible(visible) {
  shellEls.header.style.display = visible ? '' : 'none';
  shellEls.nav.style.display = visible ? '' : 'none';
}

function navigateTo(pageName) {
  if (!pages[pageName]) return;
  state.currentPage = pageName;

  document.querySelectorAll('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.page === pageName);
  });

  pages[pageName](appContentEl);
  refreshIcons();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setupNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.page));
  });
}

function setupSettingsModal() {
  const overlay = document.getElementById('modal-settings');

  document.getElementById('btn-settings').addEventListener('click', async () => {
    const { data } = await supabase.auth.getUser();
    document.getElementById('settings-user-email').textContent = data.user?.email ?? '';
    overlay.classList.add('active');
    refreshIcons();
  });

  overlay.querySelector('.close-modal').addEventListener('click', () => {
    overlay.classList.remove('active');
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });

  document.getElementById('btn-sync-now').addEventListener('click', () => {
    if (!navigator.onLine) {
      showToast('Đang offline, không thể đồng bộ', 'error');
      return;
    }
    syncPendingOrders();
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await supabase.auth.signOut();
    overlay.classList.remove('active');
  });
}

function setupSyncUi() {
  const banner = document.getElementById('net-banner');
  const badge = document.getElementById('sync-badge');
  const syncBtn = document.getElementById('btn-sync-status');
  const appContent = document.getElementById('app-content');

  onSyncStateChange(({ online, syncing, pendingCount }) => {
    if (pendingCount > 0) {
      badge.hidden = false;
      badge.textContent = pendingCount > 99 ? '99+' : String(pendingCount);
    } else {
      badge.hidden = true;
    }

    syncBtn.classList.toggle('syncing', syncing);

    if (!online) {
      banner.textContent = pendingCount > 0
        ? `Đang offline · ${pendingCount} đơn chờ đồng bộ`
        : 'Đang offline';
      banner.classList.add('show');
    } else if (syncing) {
      banner.textContent = 'Đang đồng bộ...';
      banner.classList.add('show');
    } else if (pendingCount > 0) {
      banner.textContent = `${pendingCount} đơn chờ đồng bộ`;
      banner.classList.add('show');
    } else {
      banner.classList.remove('show');
    }

    appContent.classList.toggle('banner-visible', banner.classList.contains('show'));
  });

  syncBtn.addEventListener('click', () => {
    if (!navigator.onLine) {
      showToast('Đang offline, không thể đồng bộ', 'error');
      return;
    }
    syncPendingOrders();
  });
}

function showLoadingScreen() {
  appContentEl.innerHTML = `
    <div class="loading-screen">
      <div class="spinner"></div>
      <p>Đang tải...</p>
    </div>`;
}

let shellInitialized = false;

async function startApp() {
  setShellVisible(true);
  if (!shellInitialized) {
    setupNav();
    setupSettingsModal();
    setupSyncUi();
    shellInitialized = true;
  }
  initSync();
  navigateTo('dashboard');
}

async function boot() {
  setShellVisible(false);
  showLoadingScreen();

  const { data } = await supabase.auth.getSession();

  if (data.session) {
    await startApp();
  } else {
    renderLogin(appContentEl, { onSuccess: () => startApp() });
  }

  refreshIcons();
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    setShellVisible(false);
    renderLogin(appContentEl, { onSuccess: () => startApp() });
    refreshIcons();
  }
});

boot();
