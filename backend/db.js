const fs   = require('fs');
const path = require('path');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'orders.json');

const DEFAULT_SCHEDULE = [
  { day: 4, from: '18:00', to: '23:00' }, // Jueves
  { day: 5, from: '18:00', to: '23:00' }, // Viernes
  { day: 6, from: '18:00', to: '23:00' }, // Sábado
  { day: 0, from: '18:00', to: '23:00' }, // Domingo
];

const DEFAULT_PRICES = {
  lucy_solo:7999,  lucy_combo:13999, lucy_promo:49999,
  doble_solo:15999, doble_combo:19999, doble_promo:35999,
  capresa_solo:9999, capresa_combo:14999, capresa_promo:39999,
  argenta_solo:11999, argenta_combo:16999, argenta_promo:49999,
  pollo_solo:11999,  pollo_combo:16999, pollo_promo:49999,
  coca_zero:3000, coca:3000, sprite_zero:3000, sprite:3000,
  papas:4900, panceta:2399
};

const VALID_PRICE_KEYS = new Set(Object.keys(DEFAULT_PRICES));

function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      if (!data.users)  data.users  = [];
      if (!data.store)  data.store  = { manualOverride: 'auto', schedule: DEFAULT_SCHEDULE };
      if (!data.prices) data.prices = {};
      return data;
    }
  } catch (e) { console.error('Error leyendo DB:', e.message); }
  return { orders: [], nextId: 1, users: [], store: { manualOverride: 'auto', schedule: DEFAULT_SCHEDULE }, prices: {} };
}

// ── Prices ───────────────────────────────────────────────
function getPrices() {
  return { ...DEFAULT_PRICES, ...(load().prices || {}) };
}

function updatePrices(patch) {
  const db = load();
  const safe = {};
  for (const [key, val] of Object.entries(patch)) {
    if (VALID_PRICE_KEYS.has(key) && typeof val === 'number' && val >= 0 && val <= 999999) {
      safe[key] = Math.round(val);
    }
  }
  db.prices = { ...(db.prices || {}), ...safe };
  save(db);
  return { ...DEFAULT_PRICES, ...db.prices };
}

// ── Store ─────────────────────────────────────────────────
function getStoreConfig() {
  return load().store;
}

function updateStoreConfig(patch) {
  const db = load();
  db.store = { ...db.store, ...patch };
  save(db);
  return db.store;
}

// ── Usuarios ─────────────────────────────────────────────
function getUser(uid) {
  return load().users.find(u => u.uid === uid) || null;
}

function upsertUser(uid, email, displayName) {
  const db  = load();
  const idx = db.users.findIndex(u => u.uid === uid);
  if (idx === -1) {
    db.users.push({ uid, email, displayName, approved: false, createdAt: new Date().toISOString() });
  } else {
    db.users[idx].email       = email;
    db.users[idx].displayName = displayName;
  }
  save(db);
  return getUser.call(null, uid) || db.users.find(u => u.uid === uid);
}

function approveUser(uid, approved) {
  const db  = load();
  const idx = db.users.findIndex(u => u.uid === uid);
  if (idx === -1) return null;
  db.users[idx].approved = approved;
  save(db);
  return db.users[idx];
}

function getPendingUsers() {
  return load().users.filter(u => !u.approved);
}

function getAllUsers() {
  return load().users;
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function nowStr() {
  return new Date().toLocaleString('es-AR', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
}

function createOrder(data) {
  const db  = load();
  const now = nowStr();
  const order = {
    id:             db.nextId++,
    order_num:      data.order_num,
    client_name:    data.client_name,
    client_phone:   data.client_phone,
    client_address: data.client_address || '',
    items_json:     data.items_json,
    total:          data.total,
    payment_method: data.payment_method || 'mp',
    status:         'recibido',
    paid_at:        null,   // se setea al confirmar pago
    whatsapp_msg:   data.whatsapp_msg || '',
    created_at:     data._created_at || now,
    updated_at:     now
  };
  db.orders.unshift(order);
  save(db);
  return order;
}

function getOrders() {
  return load().orders;
}

function resetOrders() {
  const db = load();
  db.orders = [];
  db.nextId = 1;
  save(db);
}

function updateStatus(id, status, _paidAt, _mpPaymentId) {
  const db  = load();
  const idx = db.orders.findIndex(o => o.id === id);
  if (idx === -1) return null;
  db.orders[idx].status     = status;
  db.orders[idx].updated_at = _paidAt || nowStr();
  if (status === 'pago_confirmado') {
    db.orders[idx].paid_at       = _paidAt || nowStr();
    db.orders[idx].mp_payment_id = _mpPaymentId || null;
  }
  save(db);
  return db.orders[idx];
}

function parseDate(str) {
  // "03/04/2026, 18:05:00" → "2026-04-03"
  const parts = str.split(',')[0].split('/');
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

function parseDateTime(str) {
  // "03/04/2026, 18:05:00" → ms timestamp
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +m[6]).getTime();
}

function getMetrics(from, to) {
  const orders = load().orders.filter(o => {
    if (!from && !to) return true;
    const d = parseDate(o.created_at);
    if (from && to)  return d >= from && d <= to;
    if (from)        return d >= from;
    return true;
  });

  const total        = orders.length;
  const totalRevenue = orders.reduce((s, o) => s + o.total, 0);
  const avgTicket    = total ? Math.round(totalRevenue / total) : 0;
  const completed    = orders.filter(o => o.status === 'entregado').length;

  const byStatus = { recibido:0, pago_confirmado:0, en_preparacion:0, en_camino:0, entregado:0, cancelado:0 };
  orders.forEach(o => { if (byStatus[o.status] !== undefined) byStatus[o.status]++; });

  const dayMap = {};
  orders.forEach(o => {
    const day = parseDate(o.created_at);
    if (!dayMap[day]) dayMap[day] = { date: day, count: 0, revenue: 0 };
    dayMap[day].count++;
    dayMap[day].revenue += o.total;
  });
  const byDay = Object.values(dayMap).sort((a, b) => a.date.localeCompare(b.date));

  const productMap = {};
  orders.forEach(o => {
    let items;
    try { items = JSON.parse(o.items_json); } catch { return; }
    items.forEach(item => {
      const key = `${item.name} – ${item.sub}`;
      if (!productMap[key]) productMap[key] = { name: key, emoji: item.emoji || '🍔', qty: 0, revenue: 0 };
      productMap[key].qty     += item.qty;
      productMap[key].revenue += item.unitPrice * item.qty;
    });
  });
  const topProducts = Object.values(productMap)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  // Tiempo promedio de entrega (created_at → updated_at de pedidos entregados)
  const deliveredOrders = orders.filter(o => o.status === 'entregado');
  let avgDeliveryMinutes = null;
  if (deliveredOrders.length) {
    const totalMs = deliveredOrders.reduce((sum, o) => {
      const created  = parseDateTime(o.created_at);
      const delivered = parseDateTime(o.updated_at);
      return (created && delivered) ? sum + (delivered - created) : sum;
    }, 0);
    avgDeliveryMinutes = Math.round(totalMs / deliveredOrders.length / 60000);
  }

  // Ingresos confirmados por Mercado Pago (paid_at presente)
  const mpOrders  = orders.filter(o => o.paid_at);
  const mpRevenue = mpOrders.reduce((s, o) => s + o.total, 0);
  const mpCount   = mpOrders.length;

  // Pedidos con pago confirmado que aún no fueron enviados (para la tabla)
  const NOT_SHIPPED = new Set(['recibido', 'pago_confirmado', 'en_preparacion']);
  const pendingShipments = orders
    .filter(o => o.paid_at && NOT_SHIPPED.has(o.status))
    .map(o => ({
      id:            o.id,
      order_num:     o.order_num,
      client_name:   o.client_name,
      total:         o.total,
      status:        o.status,
      paid_at:       o.paid_at,
      mp_payment_id: o.mp_payment_id || null
    }))
    .sort((a, b) => b.id - a.id);

  return { total, totalRevenue, avgTicket, completed, byStatus, byDay, topProducts,
           avgDeliveryMinutes, mpRevenue, mpCount, pendingShipments };
}

module.exports = { createOrder, getOrders, resetOrders, updateStatus, getMetrics, getUser, upsertUser, approveUser, getPendingUsers, getAllUsers, getStoreConfig, updateStoreConfig, getPrices, updatePrices, DEFAULT_PRICES };
