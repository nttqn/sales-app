import { supabase } from './supabase.js';
import { getPendingOrders, removePendingOrder, bumpPendingOrderAttempts } from './db.js';
import { showToast } from './ui.js';

const listeners = new Set();
let syncing = false;

export function onSyncStateChange(fn) {
  listeners.add(fn);
  fn(currentState());
  return () => listeners.delete(fn);
}

function currentState() {
  return { syncing, online: navigator.onLine };
}

async function notify() {
  const state = currentState();
  const pending = await getPendingOrders();
  const full = { ...state, pendingCount: pending.length };
  listeners.forEach((fn) => fn(full));
  return full;
}

export async function syncPendingOrders({ silent = false } = {}) {
  if (syncing) return currentState();
  if (!navigator.onLine) return notify();

  syncing = true;
  await notify();

  const pending = await getPendingOrders();
  let successCount = 0;
  let conflictCount = 0;
  let failCount = 0;

  for (const record of pending) {
    try {
      const { data, error } = await supabase.rpc('create_order', {
        payload: { order: record.order, items: record.items },
      });
      if (error) throw error;
      await removePendingOrder(record.id);
      successCount += 1;
      if (data?.sync_status === 'conflict') conflictCount += 1;
    } catch (err) {
      failCount += 1;
      await bumpPendingOrderAttempts(record.id);
    }
  }

  syncing = false;
  const state = await notify();

  if (!silent) {
    if (successCount > 0 && conflictCount > 0) {
      showToast(`Đã đồng bộ ${successCount} đơn (${conflictCount} đơn cần đối soát tồn kho)`, 'warning');
    } else if (successCount > 0 && failCount === 0) {
      showToast(`Đã đồng bộ ${successCount} đơn hàng`, 'success');
    } else if (successCount > 0 && failCount > 0) {
      showToast(`Đã đồng bộ ${successCount} đơn, còn ${failCount} đơn lỗi`, 'warning');
    } else if (failCount > 0) {
      showToast(`Đồng bộ thất bại (${failCount} đơn), sẽ tự thử lại`, 'error');
    } else {
      showToast('Không có đơn nào cần đồng bộ', 'info');
    }
  }

  return state;
}

let initialized = false;

export function initSync() {
  if (initialized) return;
  initialized = true;

  window.addEventListener('online', () => syncPendingOrders({ silent: true }));
  window.addEventListener('offline', () => notify());

  setInterval(() => {
    if (navigator.onLine) syncPendingOrders({ silent: true });
  }, 30000);

  notify();
  if (navigator.onLine) syncPendingOrders({ silent: true });
}

export async function refreshSyncState() {
  return notify();
}
