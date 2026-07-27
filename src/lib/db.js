import { openDB } from 'idb';

const DB_NAME = 'SalesFlowDB';
const DB_VERSION = 2;

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains('products')) {
      db.createObjectStore('products', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('pending_orders')) {
      // keyPath 'id' = order.id (client-generated uuid), doubles as the
      // idempotency key used by the create_order RPC when syncing.
      db.createObjectStore('pending_orders', { keyPath: 'id' });
    }
    if (!db.objectStoreNames.contains('meta')) {
      db.createObjectStore('meta');
    }
    if (!db.objectStoreNames.contains('customers')) {
      db.createObjectStore('customers', { keyPath: 'id' });
    }
  },
});

// --- Products cache (for offline reads) ---
export async function cacheProducts(products) {
  const db = await dbPromise;
  const tx = db.transaction('products', 'readwrite');
  await tx.store.clear();
  for (const p of products) await tx.store.put(p);
  await tx.done;
}

export async function upsertCachedProduct(product) {
  const db = await dbPromise;
  await db.put('products', product);
}

export async function getCachedProducts() {
  const db = await dbPromise;
  return db.getAll('products');
}

// --- Customers cache (for offline reads + POS autocomplete) ---
export async function cacheCustomers(customers) {
  const db = await dbPromise;
  const tx = db.transaction('customers', 'readwrite');
  await tx.store.clear();
  for (const c of customers) await tx.store.put(c);
  await tx.done;
}

export async function getCachedCustomers() {
  const db = await dbPromise;
  return db.getAll('customers');
}

// --- Pending orders queue (offline sales waiting to sync) ---
export async function queuePendingOrder(order, items) {
  const db = await dbPromise;
  await db.put('pending_orders', {
    id: order.id,
    order,
    items,
    createdAt: Date.now(),
    attempts: 0,
  });
}

export async function getPendingOrders() {
  const db = await dbPromise;
  return db.getAll('pending_orders');
}

export async function removePendingOrder(id) {
  const db = await dbPromise;
  await db.delete('pending_orders', id);
}

export async function bumpPendingOrderAttempts(id) {
  const db = await dbPromise;
  const record = await db.get('pending_orders', id);
  if (!record) return;
  record.attempts += 1;
  await db.put('pending_orders', record);
}

// --- Misc key/value ---
export async function getMeta(key) {
  const db = await dbPromise;
  return db.get('meta', key);
}

export async function setMeta(key, value) {
  const db = await dbPromise;
  await db.put('meta', value, key);
}
