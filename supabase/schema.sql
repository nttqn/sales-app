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

-- ========== CUSTOMERS ==========
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null unique,
  address text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists customers_set_updated_at on customers;
create trigger customers_set_updated_at
before update on customers
for each row execute function set_updated_at();

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
  customer_id uuid references customers(id) on delete set null,
  customer_name text,
  customer_phone text,
  customer_address text,
  customer_note text,
  note text,
  created_offline boolean not null default false,
  sync_status text not null default 'synced' check (sync_status in ('synced', 'conflict')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Migration-safe: adds the columns when running this file against a database
-- that already has the orders table from before shipping_fee/customer existed.
alter table orders add column if not exists shipping_fee numeric(14,2) not null default 0;
alter table orders add column if not exists customer_id uuid references customers(id) on delete set null;
alter table orders add column if not exists customer_name text;
alter table orders add column if not exists customer_phone text;
alter table orders add column if not exists customer_address text;
alter table orders add column if not exists customer_note text;

-- Mở rộng trạng thái đơn hàng cho luồng fulfillment của đơn Online:
-- new (đơn mới) -> shipping (đang vận chuyển) -> completed (hoàn thành) | returned (chuyển hoàn)
--   | cancelled (đã hủy) | lost (thất lạc/mất hàng).
-- Đơn tại quầy vẫn tạo thẳng ở completed như trước (xem create_order bên dưới).
-- Dò constraint check hiện có trên đúng cột "status" theo conkey (không đoán tên, không nhầm với
-- sync_status) để xóa rồi tạo lại với danh sách giá trị mới nhất — an toàn khi chạy lại file nhiều lần
-- kể cả khi danh sách giá trị đã đổi giữa các lần chạy trước.
do $$
declare
  v_conname text;
  v_status_attnum smallint;
begin
  select attnum into v_status_attnum
  from pg_attribute
  where attrelid = 'orders'::regclass and attname = 'status';

  select conname into v_conname
  from pg_constraint
  where conrelid = 'orders'::regclass
    and contype = 'c'
    and conkey = array[v_status_attnum];

  if v_conname is not null then
    execute format('alter table orders drop constraint %I', v_conname);
  end if;

  alter table orders add constraint orders_status_check
    check (status in ('new', 'shipping', 'cancelled', 'returned', 'completed', 'lost'));
end $$;

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

-- Thêm reason 'return' (hoàn kho khi đơn chuyển hoàn/hủy) vào constraint hiện có, cùng cách dò
-- theo conkey như trên để an toàn khi chạy lại file nhiều lần.
do $$
declare
  v_conname text;
  v_reason_attnum smallint;
begin
  select attnum into v_reason_attnum
  from pg_attribute
  where attrelid = 'stock_movements'::regclass and attname = 'reason';

  select conname into v_conname
  from pg_constraint
  where conrelid = 'stock_movements'::regclass
    and contype = 'c'
    and conkey = array[v_reason_attnum];

  if v_conname is not null then
    execute format('alter table stock_movements drop constraint %I', v_conname);
  end if;

  alter table stock_movements add constraint stock_movements_reason_check
    check (reason in ('sale', 'restock', 'adjustment', 'return'));
end $$;

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
  v_customer_id uuid;
  v_customer_name text := nullif(trim(v_order->>'customer_name'), '');
  v_customer_phone text := nullif(trim(v_order->>'customer_phone'), '');
  v_customer_address text := nullif(trim(v_order->>'customer_address'), '');
  v_customer_note text := nullif(trim(v_order->>'customer_note'), '');
begin
  -- Đơn online bắt buộc có đầy đủ thông tin khách hàng (giao hàng cần tên/SDT/địa chỉ).
  -- Đơn tại quầy thông tin khách hàng là tùy chọn.
  if v_order->>'channel' = 'online'
     and (v_customer_name is null or v_customer_phone is null or v_customer_address is null) then
    raise exception 'Đơn online bắt buộc phải có đầy đủ tên, số điện thoại và địa chỉ khách hàng';
  end if;

  -- Chỉ ghi vào danh bạ khách hàng khi có đủ tên + SĐT (địa chỉ/ghi chú có thể bổ sung sau
  -- qua trang Quản lý khách hàng). Không ghi đè hồ sơ khách đã có, chỉ tạo mới nếu SĐT chưa tồn tại.
  if v_customer_name is not null and v_customer_phone is not null then
    insert into customers (name, phone, address, note)
    values (v_customer_name, v_customer_phone, v_customer_address, v_customer_note)
    on conflict (phone) do nothing
    returning id into v_customer_id;

    if v_customer_id is null then
      select id into v_customer_id from customers where phone = v_customer_phone;
    end if;
  end if;

  insert into orders (
    id, channel, status, payment_method, subtotal, discount, total, shipping_fee,
    customer_id, customer_name, customer_phone, customer_address, customer_note,
    note, created_offline, created_by
  )
  values (
    v_order_id,
    v_order->>'channel',
    -- Đơn tại quầy hoàn tất ngay; đơn online bắt đầu ở "new" và đi qua luồng fulfillment thủ công.
    coalesce(v_order->>'status', case when v_order->>'channel' = 'online' then 'new' else 'completed' end),
    coalesce(v_order->>'payment_method', 'cash'),
    coalesce((v_order->>'subtotal')::numeric, 0),
    coalesce((v_order->>'discount')::numeric, 0),
    coalesce((v_order->>'total')::numeric, 0),
    coalesce((v_order->>'shipping_fee')::numeric, 0),
    v_customer_id,
    v_customer_name,
    v_customer_phone,
    v_customer_address,
    v_customer_note,
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

-- Xóa chữ ký cũ (2 tham số) trước khi tạo lại với tham số p_payment_method mới — PostgreSQL coi
-- đây là 2 overload khác nhau (không tự "replace" chỉ vì có default), và PostgREST không nên có
-- nhiều overload trùng tên cho cùng 1 RPC.
drop function if exists update_order_status(uuid, text);

-- ============================================
-- RPC: update_order_status
-- Đổi trạng thái + (tùy chọn) hình thức thanh toán của đơn hàng.
-- 'returned'/'cancelled' tự động hoàn lại tồn kho (ghi ledger reason 'return').
-- 'completed'/'returned'/'cancelled'/'lost' là trạng thái cuối — khóa, không cho đổi status
-- tiếp; nhưng hình thức thanh toán vẫn sửa được kể cả khi đơn đã ở trạng thái cuối (sửa lỗi
-- nhập liệu không có tác dụng phụ nghiệp vụ nào). Chỉ áp dụng khóa/hoàn kho khi p_new_status
-- thực sự khác trạng thái hiện tại, để gọi lại RPC chỉ để đổi thanh toán không bị chặn hay
-- hoàn kho lặp lại.
-- ============================================
create or replace function update_order_status(p_order_id uuid, p_new_status text, p_payment_method text default null)
returns jsonb
language plpgsql
as $$
declare
  v_current_status text;
  v_item record;
begin
  select status into v_current_status from orders where id = p_order_id for update;

  if v_current_status is null then
    raise exception 'Không tìm thấy đơn hàng';
  end if;

  if p_payment_method is not null and p_payment_method not in ('cash', 'transfer', 'card') then
    raise exception 'Hình thức thanh toán không hợp lệ: %', p_payment_method;
  end if;

  if p_new_status is distinct from v_current_status then
    if v_current_status in ('completed', 'cancelled', 'returned', 'lost') then
      raise exception 'Đơn đã ở trạng thái cuối (%), không thể chỉnh sửa thêm', v_current_status;
    end if;

    if p_new_status not in ('new', 'shipping', 'completed', 'returned', 'cancelled', 'lost') then
      raise exception 'Trạng thái không hợp lệ: %', p_new_status;
    end if;
  end if;

  update orders
  set status = p_new_status,
      payment_method = coalesce(p_payment_method, payment_method)
  where id = p_order_id;

  if p_new_status in ('returned', 'cancelled') and p_new_status is distinct from v_current_status then
    for v_item in
      select product_id, qty from order_items where order_id = p_order_id and product_id is not null
    loop
      update products set stock_qty = stock_qty + v_item.qty where id = v_item.product_id;

      insert into stock_movements (product_id, qty_change, reason, order_id, note, created_by)
      values (
        v_item.product_id,
        v_item.qty,
        'return',
        p_order_id,
        case when p_new_status = 'returned' then 'Hoàn kho do đơn chuyển hoàn' else 'Hoàn kho do đơn bị hủy' end,
        auth.uid()
      );
    end loop;
  end if;

  return jsonb_build_object('order_id', p_order_id, 'status', p_new_status, 'payment_method', p_payment_method);
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
alter table customers enable row level security;

drop policy if exists "authenticated_all_products" on products;
create policy "authenticated_all_products" on products for all to authenticated using (true) with check (true);

drop policy if exists "authenticated_all_categories" on categories;
create policy "authenticated_all_categories" on categories for all to authenticated using (true) with check (true);

drop policy if exists "authenticated_all_customers" on customers;
create policy "authenticated_all_customers" on customers for all to authenticated using (true) with check (true);

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
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'customers') then
    alter publication supabase_realtime add table customers;
  end if;
end $$;
