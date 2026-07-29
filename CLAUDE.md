# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm run dev       # Vite dev server
npm run build     # production build to dist/ (also regenerates the PWA service worker)
npm run preview   # serve the dist/ build locally
```

There is no test suite and no linter configured. The only correctness check available is `npm run build` succeeding — always run it after changes.

Database changes live in `supabase/schema.sql`, which is not run automatically. After editing it, the user must paste it into the Supabase SQL Editor and run it manually. The file is written to be idempotent/re-runnable against a database that already has an earlier version applied (uses `add column if not exists`, dynamic constraint lookups by `conkey` instead of guessed names, `pg_publication_tables` checks before `alter publication ... add table`, etc.) — preserve that property when editing it, since it gets re-run repeatedly as the schema evolves rather than tracked as sequential migrations.

`.env` holds `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` and is gitignored; `.env.example` documents the shape.

## Architecture

No framework — vanilla JS + Vite, in the same minimal style as the sibling `finance-app` (MoneyFlow) project, but with a real npm dependency tree and a Supabase backend instead of local-only storage.

### Page module contract

`src/main.js` is a hand-rolled router: it holds a `pages` map (`{ dashboard, pos, orders, products, reports, customers }`) and calls the matching page's `render*(container)` export into the single `#app-content` element on nav clicks. Every file in `src/pages/` follows the same internal shape:

- module-level `state` object (not component-scoped — there's exactly one instance of each page's state for the app's lifetime)
- `paint(container)` — sets `container.innerHTML` from current `state` and calls `wireEvents(container)`
- `wireEvents(container)` — attaches listeners, then a handler mutates `state` and calls `paint()` or a narrower render function again

**Known footgun in this pattern, twice already fixed in this codebase — watch for it in new code:**
1. If a page attaches a listener directly to the `container` parameter itself (event delegation on the page root) instead of to a child element, that listener is never removed. Since `container` is the same persistent `#app-content` DOM node across every visit to that page, re-running `wireEvents` on a later visit stacks a duplicate listener on top of the old one — clicks then fire N times (N = number of visits). Fixed in `pos.js` via a `state.eventsWired` guard that makes `wireEvents` a no-op after the first call. Any new container-level delegation must use the same guard.
2. If a search/text input's own `input` handler calls the page's full `paint(container)`, the input element itself gets destroyed and recreated on every keystroke, losing focus after one character. Fixed in `products.js`, `customers.js`, and `orders.js` by giving each a narrow `render*List(container)` function that only replaces the list container's `innerHTML`, while the row-action buttons inside that list are wired via delegation on the list's parent element (attached once, during the real `paint()`) rather than re-queried per row. New search/filter inputs should follow this same split (full `paint()` for chip/filter clicks is fine — only free-text typing needs the narrow re-render).

### Offline-first sync

- `src/lib/db.js` wraps IndexedDB (via `idb`) with object stores for `products`, `customers`, `pending_orders`, and `meta`. Bump `DB_VERSION` when adding a store.
- Products/customers are cached locally on every successful fetch and read from cache when `!navigator.onLine` or the fetch fails — see the `loadProducts`/`loadCustomers` pattern repeated in `pos.js`, `products.js`, `customers.js`.
- POS checkouts never call Supabase directly. `pos.js` always writes to the `pending_orders` IndexedDB queue first (`queuePendingOrder`), then `src/lib/sync.js` drains that queue via the `create_order` RPC whenever the app comes online (`online` event) or every 30s. Each queued order carries a client-generated UUID that doubles as the RPC's idempotency key (`on conflict (id) do nothing`), so a retried sync after a dropped connection can't double-create an order.
- Realtime: `products`, `orders`, `categories`, `customers` are all in the `supabase_realtime` publication and each relevant page subscribes to `postgres_changes` and reloads+repaints on any change, so edits on one device propagate to others live.

### Business logic lives in Postgres RPCs, not the client

`supabase/schema.sql` defines three RPCs that hold rules the client must not duplicate or bypass:

- **`create_order(payload)`** — inserts an order + its items in one transaction. Stock is deducted per item with `for update` row locking; if concurrent sales left insufficient stock (common after an offline sale syncs late), it deducts what's available, records the shortfall on the item, and flags the order `sync_status = 'conflict'` instead of failing the whole order — physical stock was already sold, so it can't be rejected after the fact. Also validates that online-channel orders carry full customer info, and upserts the customer into the `customers` directory (insert-only, never overwrites an existing phone match).
- **`adjust_stock(...)`** — manual stock in/out from the Products page, always ledgered in `stock_movements`.
- **`update_order_status(order_id, new_status, payment_method?)`** — order status is a small state machine: `new → shipping → {completed | returned | cancelled | lost}`. `completed`/`returned`/`cancelled`/`lost` are terminal — the RPC rejects any further *status* change once in one of those (payment method can still be corrected afterward; only the status field is locked). Transitioning to `returned` or `cancelled` auto-restocks the order's items (ledgered with reason `'return'`); `lost` does not restock. The lock/restock logic is keyed off whether `new_status` actually differs from the current status, so calling the RPC again just to change `payment_method` on an already-terminal order doesn't re-run the restock or get blocked.

Profit is derived, not stored, and is computed client-side (duplicated across `dashboard.js`, `reports.js`, `orders.js` — keep them in sync if the formula changes): only `completed` and `returned`/`lost` orders count toward revenue/profit at all (`new`/`shipping`/`cancelled` are excluded everywhere). `completed` profit = `total − COGS − shipping_fee`. `returned` profit = `−shipping_fee` (goods came back, so only the wasted shipping cost is a loss). `lost` profit = `−(COGS + shipping_fee)` (goods are gone for good).

Channel-dependent defaults matter: `in_store` orders complete immediately with no customer info required; `online` orders start at `new`, require full customer info, and default to a 14,000₫ shipping fee in the POS UI (still editable).

### PWA / service worker

`registerType: 'prompt'` in `vite.config.js` (not `'autoUpdate'`) — a new service worker installs but waits rather than taking over mid-session, because `autoUpdate`'s immediate `clientsClaim()` caused a real production incident (stale SW served a mismatched HTML/asset-hash pair, breaking all CSS). `src/main.js` registers manually via the `virtual:pwa-register` module and shows a dismissible-by-action `#update-banner` with a "Tải lại" button wired to `updateSW(true)`; there is no silent auto-reload path anymore.

Lucide icons and Chart.js are imported as real ES modules (not the CDN `<script>` tags Vite scaffolds by default) so they're bundled and precached for offline use. Only the specific icon components actually referenced via `data-lucide="..."` anywhere in the app are imported into `usedIcons` in `main.js` — grep for `data-lucide=` before assuming an icon is available, and add any new one to both the import list and `usedIcons` in `main.js`, or `window.lucide.createIcons()` will silently no-op for it.

### Deployment

Static Vite build, deployed on Vercel from `github.com/nttqn/sales-app` (auto-deploys on push to `main`). No server-side code — Supabase is the entire backend, so hosting is just the built `dist/` output plus the `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` env vars configured in the Vercel project settings.
