-- ============================================
-- SalesFlow - Supabase schema (Phase 1)
-- Chạy toàn bộ file này trong Supabase SQL Editor
-- (Dashboard > SQL Editor > New query > dán vào > Run)
-- ============================================

create extension if not exists "pgcrypto";

-- ========== PRODUCTS ==========
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  sku text,
  name text not null,
  category text,
  cost_price numeric(14,2) not null default 0,
  sell_price numeric(14,2) not null default 0,
  stock_qty numeric(14,2) not null default 0,
  low_stock_threshold numeric(14,2) not null default 5,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists products_sku_idx on products (sku) where sku is not null;

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on products;
create trigger products_set_updated_at
before update on products
for each row execute function set_updated_at();

-- ========== CATEGORIES ==========
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table products add column if not exists category_id uuid references categories(id) on delete set null;

-- Migration-safe: nếu bảng products đã tồn tại từ trước với cột category dạng
-- text tự do, chuyển các giá trị khác nhau đó thành các dòng trong bảng
-- categories rồi trỏ products về đúng category_id, sau đó xóa cột cũ.
do $$
begin
  if exists (select 1 from information_schema.columns where table_name = 'products' and column_name = 'category') then
    insert into categories (name)
    select distinct category from products where category is not null and category <> ''
    on conflict (name) do nothing;

    update products set category_id = categories.id
    from categories
    where products.category = categories.name and products.category_id is null;

    alter table products drop column category;
  end if;
end $$;

-- ========== ORDERS ==========
-- id được sinh ở client (uuid) để idempotent khi retry đồng bộ offline
create table if not exists orders (
  id uuid primary key,
  channel text not null check (channel in ('in_store', 'online')),
  status text not null default 'completed' check (status in ('completed', 'cancelled')),
  payment_method text not null default 'cash',
  subtotal numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  shipping_fee numeric(14,2) not null default 0,
  note text,
  created_offline boolean not null default false,
  sync_status text not null default 'synced' check (sync_status in ('synced', 'conflict')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Migration-safe: adds the column when running this file against a database
-- that already has the orders table from before shipping_fee existed.
alter table orders add column if not exists shipping_fee numeric(14,2) not null default 0;

create index if not exists orders_created_at_idx on orders (created_at desc);
create index if not exists orders_channel_idx on orders (channel);

-- ========== ORDER ITEMS ==========
create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id),
  product_name text not null,
  qty numeric(14,2) not null,
  unit_price numeric(14,2) not null,
  unit_cost numeric(14,2) not null,
  stock_shortfall numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists order_items_order_id_idx on order_items (order_id);
create index if not exists order_items_product_id_idx on order_items (product_id);

-- ========== STOCK MOVEMENTS (ledger để audit tồn kho) ==========
create table if not exists stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  qty_change numeric(14,2) not null,
  reason text not null check (reason in ('sale', 'restock', 'adjustment')),
  order_id uuid references orders(id),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_product_id_idx on stock_movements (product_id);

-- ============================================
-- RPC: create_order
-- Insert 1 đơn hàng + các item trong 1 transaction, trừ tồn kho có điều kiện.
-- Idempotent theo order id (client-generated) để an toàn khi client retry sync.
-- Nếu sản phẩm không đủ tồn kho (thường do bán offline, tồn kho đã đổi ở
-- thiết bị khác), đơn vẫn được lưu nhưng đánh dấu sync_status = 'conflict'
-- và ghi rõ stock_shortfall trên từng item để đối soát thủ công.
-- ============================================
create or replace function create_order(payload jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_order jsonb := payload->'order';
  v_items jsonb := payload->'items';
  v_order_id uuid := (v_order->>'id')::uuid;
  v_inserted_id uuid;
  v_item jsonb;
  v_available numeric;
  v_shortfall numeric;
  v_deduct numeric;
  v_has_conflict boolean := false;
begin
  insert into orders (
    id, channel, status, payment_method, subtotal, discount, total, shipping_fee, note, created_offline, created_by
  )
  values (
    v_order_id,
    v_order->>'channel',
    coalesce(v_order->>'status', 'completed'),
    coalesce(v_order->>'payment_method', 'cash'),
    coalesce((v_order->>'subtotal')::numeric, 0),
    coalesce((v_order->>'discount')::numeric, 0),
    coalesce((v_order->>'total')::numeric, 0),
    coalesce((v_order->>'shipping_fee')::numeric, 0),
    v_order->>'note',
    coalesce((v_order->>'created_offline')::boolean, false),
    auth.uid()
  )
  on conflict (id) do nothing
  returning id into v_inserted_id;

  -- Đơn đã được xử lý ở lần gọi trước (retry) -> không xử lý lại tồn kho
  if v_inserted_id is null then
    return jsonb_build_object(
      'order_id', v_order_id,
      'already_processed', true,
      'sync_status', (select sync_status from orders where id = v_order_id)
    );
  end if;

  for v_item in select * from jsonb_array_elements(v_items)
  loop
    select stock_qty into v_available from products where id = (v_item->>'product_id')::uuid for update;
    v_available := coalesce(v_available, 0);

    v_shortfall := greatest(0, (v_item->>'qty')::numeric - v_available);
    v_deduct := (v_item->>'qty')::numeric - v_shortfall;

    if v_shortfall > 0 then
      v_has_conflict := true;
    end if;

    update products
    set stock_qty = stock_qty - v_deduct
    where id = (v_item->>'product_id')::uuid;

    insert into order_items (
      order_id, product_id, product_name, qty, unit_price, unit_cost, stock_shortfall
    )
    values (
      v_order_id,
      (v_item->>'product_id')::uuid,
      v_item->>'product_name',
      (v_item->>'qty')::numeric,
      (v_item->>'unit_price')::numeric,
      (v_item->>'unit_cost')::numeric,
      v_shortfall
    );

    if v_deduct > 0 then
      insert into stock_movements (product_id, qty_change, reason, order_id, created_by)
      values ((v_item->>'product_id')::uuid, -v_deduct, 'sale', v_order_id, auth.uid());
    end if;
  end loop;

  if v_has_conflict then
    update orders set sync_status = 'conflict' where id = v_order_id;
  end if;

  return jsonb_build_object(
    'order_id', v_order_id,
    'already_processed', false,
    'sync_status', case when v_has_conflict then 'conflict' else 'synced' end
  );
end;
$$;

-- ============================================
-- RPC: adjust_stock
-- Nhập/xuất/điều chỉnh kho thủ công (không qua đơn hàng), vẫn ghi ledger.
-- ============================================
create or replace function adjust_stock(p_product_id uuid, p_qty_change numeric, p_reason text, p_note text default null)
returns void
language plpgsql
as $$
begin
  update products set stock_qty = stock_qty + p_qty_change where id = p_product_id;

  insert into stock_movements (product_id, qty_change, reason, note, created_by)
  values (p_product_id, p_qty_change, p_reason, p_note, auth.uid());
end;
$$;

-- ============================================
-- ROW LEVEL SECURITY
-- v1: 1 cửa hàng, mọi user đã đăng nhập đọc/ghi toàn bộ dữ liệu.
-- Mở rộng multi-tenant sau này bằng cột store_id nếu cần.
-- ============================================
alter table products enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table stock_movements enable row level security;
alter table categories enable row level security;

drop policy if exists "authenticated_all_products" on products;
create policy "authenticated_all_products" on products for all to authenticated using (true) with check (true);

drop policy if exists "authenticated_all_categories" on categories;
create policy "authenticated_all_categories" on categories for all to authenticated using (true) with check (true);

drop policy if exists "authenticated_all_orders" on orders;
create policy "authenticated_all_orders" on orders for all to authenticated using (true) with check (true);

drop policy if exists "authenticated_all_order_items" on order_items;
create policy "authenticated_all_order_items" on order_items for all to authenticated using (true) with check (true);

drop policy if exists "authenticated_all_stock_movements" on stock_movements;
create policy "authenticated_all_stock_movements" on stock_movements for all to authenticated using (true) with check (true);

-- ============================================
-- REALTIME
-- Cho phép các thiết bị khác nhận cập nhật tồn kho/đơn hàng/danh mục real-time.
-- Bọc trong kiểm tra pg_publication_tables để chạy lại file này nhiều lần
-- không bị lỗi "relation is already member of publication".
-- ============================================
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'products') then
    alter publication supabase_realtime add table products;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'orders') then
    alter publication supabase_realtime add table orders;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'categories') then
    alter publication supabase_realtime add table categories;
  end if;
end $$;
