const admin = require('./firebase');
const fs    = admin.firestore();

const DEFAULT_SCHEDULE = [
  { day: 4, from: '18:00', to: '23:00' }, // Jueves
  { day: 5, from: '18:00', to: '23:00' }, // Viernes
  { day: 6, from: '18:00', to: '23:00' }, // Sábado
  { day: 0, from: '18:00', to: '23:00' }, // Domingo
];

const DEFAULT_CATALOG = [
  { id:'lucy_solo',     name:'Juicy Lucy',           sub:'Solo la burger',             emoji:'🧀', group:'burger', price:7999,  active:true },
  { id:'lucy_combo',    name:'Juicy Lucy',            sub:'Combo (+ papas + gaseosa)',  emoji:'🧀', group:'burger', price:13999, active:true },
  { id:'lucy_promo',    name:'Combo Familiar Lucy',   sub:'4 Juicy Lucy completas',     emoji:'🎉', group:'promo',  price:49999, active:true },
  { id:'doble_solo',    name:'Doble Lucy',            sub:'Solo la burger',             emoji:'🍔', group:'burger', price:15999, active:true },
  { id:'doble_combo',   name:'Doble Lucy',            sub:'Combo (+ papas + gaseosa)',  emoji:'🍔', group:'burger', price:19999, active:true },
  { id:'doble_promo',   name:'Combo para Dos',        sub:'2 Dobles Lucy completas',    emoji:'👫', group:'promo',  price:35999, active:true },
  { id:'capresa_solo',  name:'Capresa',               sub:'Solo la burger',             emoji:'🌿', group:'burger', price:9999,  active:true },
  { id:'capresa_combo', name:'Capresa',               sub:'Combo (+ papas + gaseosa)',  emoji:'🌿', group:'burger', price:14999, active:true },
  { id:'capresa_promo', name:'Combo Amigos Capresa',  sub:'3 Capresa completas',        emoji:'👥', group:'promo',  price:39999, active:true },
  { id:'argenta_solo',  name:'Argenta',               sub:'Solo la burger',             emoji:'🥩', group:'burger', price:11999, active:true },
  { id:'argenta_combo', name:'Argenta',               sub:'Combo (+ papas + gaseosa)',  emoji:'🥩', group:'burger', price:16999, active:true },
  { id:'argenta_promo', name:'Promo Argenta x3+1',    sub:'3 combos + Juicy de regalo', emoji:'🎁', group:'promo',  price:49999, active:true },
  { id:'pollo_solo',    name:'Pollo Tzatziki',        sub:'Solo la burger',             emoji:'🐔', group:'burger', price:11999, active:true },
  { id:'pollo_combo',   name:'Pollo Tzatziki',        sub:'Combo (+ papas + gaseosa)',  emoji:'🐔', group:'burger', price:16999, active:true },
  { id:'pollo_promo',   name:'Promo Pollo x3+1',      sub:'3 combos + Juicy de regalo', emoji:'🎁', group:'promo',  price:49999, active:true },
  { id:'coca_zero',     name:'Coca-Cola Zero',        sub:'Gaseosa · Lata',             emoji:'🥤', group:'extra',  price:3000,  active:true },
  { id:'coca',          name:'Coca-Cola',             sub:'Gaseosa · Lata',             emoji:'🥤', group:'extra',  price:3000,  active:true },
  { id:'sprite_zero',   name:'Sprite Zero',           sub:'Gaseosa · Lata',             emoji:'🥤', group:'extra',  price:3000,  active:true },
  { id:'sprite',        name:'Sprite',                sub:'Gaseosa · Lata',             emoji:'🥤', group:'extra',  price:3000,  active:true },
  { id:'papas',         name:'Papas Adicionales',     sub:'Ración adicional',           emoji:'🍟', group:'extra',  price:4900,  active:true },
  { id:'panceta',       name:'Panceta Adicional',     sub:'Ración adicional',           emoji:'🥓', group:'extra',  price:2399,  active:true },
];

const DEFAULT_STORE = {
  manualOverride: 'auto',
  schedule:       DEFAULT_SCHEDULE,
  report_emails:  ['eduardocanelo@gmail.com'],
  report_name:    'The JuicySpot',
  deliveryZone:   'CABA',
};

function nowStr() {
  return new Date().toLocaleString('es-AR', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hour12: false
  });
}

function parseDateTime(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s*(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5], +m[6]).getTime();
}

// ── Helpers internos ──────────────────────────────────
const configDoc = (id) => fs.collection('config').doc(id);

// ── Catálogo ──────────────────────────────────────────
async function getCatalog() {
  const doc = await configDoc('catalog').get();
  if (doc.exists && Array.isArray(doc.data().items)) return doc.data().items;
  return DEFAULT_CATALOG;
}

async function _saveCatalog(items) {
  await configDoc('catalog').set({ items });
  return items;
}

async function addCatalogItem(item) {
  const catalog = await getCatalog();
  const id = (item.name || 'producto')
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    + '_' + Date.now();
  const newItem = { id, name: '', sub: '', emoji: '🍔', group: 'extra', price: 0, active: true, ...item };
  catalog.push(newItem);
  return _saveCatalog(catalog);
}

async function updateCatalogItem(id, patch) {
  const catalog = await getCatalog();
  const idx = catalog.findIndex(p => p.id === id);
  if (idx === -1) return null;
  catalog[idx] = { ...catalog[idx], ...patch };
  await _saveCatalog(catalog);
  return catalog[idx];
}

async function deleteCatalogItem(id) {
  const catalog = await getCatalog();
  const idx = catalog.findIndex(p => p.id === id);
  if (idx === -1) return false;
  catalog.splice(idx, 1);
  await _saveCatalog(catalog);
  return true;
}

// ── Precios (compat) ──────────────────────────────────
async function getPrices() {
  const catalog = await getCatalog();
  const prices = {};
  catalog.forEach(p => { prices[p.id] = p.price; });
  return prices;
}

// ── Config de tienda ──────────────────────────────────
async function getStoreConfig() {
  const doc = await configDoc('store').get();
  if (!doc.exists) return { ...DEFAULT_STORE };
  return { ...DEFAULT_STORE, ...doc.data() };
}

async function updateStoreConfig(patch) {
  const current = await getStoreConfig();
  const updated = { ...current, ...patch };
  await configDoc('store').set(updated);
  return updated;
}

// ── Usuarios ──────────────────────────────────────────
async function getUser(uid) {
  const doc = await fs.collection('users').doc(uid).get();
  return doc.exists ? doc.data() : null;
}

async function upsertUser(uid, email, displayName) {
  const ref = fs.collection('users').doc(uid);
  const doc = await ref.get();
  if (doc.exists) {
    await ref.update({ email, displayName });
  } else {
    await ref.set({ uid, email, displayName, approved: false, createdAt: new Date().toISOString() });
  }
  return (await ref.get()).data();
}

async function approveUser(uid, approved) {
  const ref = fs.collection('users').doc(uid);
  const doc = await ref.get();
  if (!doc.exists) return null;
  await ref.update({ approved });
  return (await ref.get()).data();
}

async function getPendingUsers() {
  const snap = await fs.collection('users').where('approved', '==', false).get();
  return snap.docs.map(d => d.data());
}

async function getAllUsers() {
  const snap = await fs.collection('users').get();
  return snap.docs.map(d => d.data());
}

// ── Pedidos ───────────────────────────────────────────
async function createOrder(data) {
  const counterRef = configDoc('counter');
  let orderId;
  await fs.runTransaction(async (t) => {
    const counterDoc = await t.get(counterRef);
    orderId = counterDoc.exists ? (counterDoc.data().nextId || 1) : 1;
    t.set(counterRef, { nextId: orderId + 1 });
  });

  const now = nowStr();
  const order = {
    id:             orderId,
    order_num:      data.order_num,
    client_name:    data.client_name,
    client_phone:   data.client_phone,
    client_address: data.client_address || '',
    items_json:     data.items_json,
    total:          data.total,
    payment_method: data.payment_method || 'mp',
    status:         'recibido',
    paid_at:        null,
    mp_payment_id:  null,
    whatsapp_msg:   data.whatsapp_msg || '',
    created_at:     data._created_at || now,
    updated_at:     now,
    cancel_reason:  null,
    cancel_notes:   null,
    cancelled_at:   null,
  };
  await fs.collection('orders').doc(String(orderId)).set(order);
  return order;
}

async function getOrders() {
  const snap = await fs.collection('orders').orderBy('id', 'desc').get();
  return snap.docs.map(d => d.data());
}

async function resetOrders() {
  const snap = await fs.collection('orders').get();
  const batch = fs.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
  await configDoc('counter').set({ nextId: 1 });
}

async function updateStatus(id, status, _paidAt, _mpPaymentId, cancelData) {
  const ref = fs.collection('orders').doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) return null;

  const update = { status, updated_at: _paidAt || nowStr() };

  if (status === 'pago_confirmado') {
    update.paid_at       = _paidAt || nowStr();
    update.mp_payment_id = _mpPaymentId || null;
  }
  if (status === 'cancelado' && cancelData) {
    update.cancel_reason = cancelData.cancel_reason || null;
    update.cancel_notes  = cancelData.cancel_notes  || null;
    update.cancelled_at  = nowStr();
  }

  await ref.update(update);
  return (await ref.get()).data();
}

// ── Métricas ──────────────────────────────────────────
function parseDate(str) {
  const parts = str.split(',')[0].split('/');
  return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

async function getMetrics(from, to) {
  const allOrders = await getOrders();
  const orders = allOrders.filter(o => {
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
  const topProducts = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 10);

  const deliveredOrders = orders.filter(o => o.status === 'entregado');
  let avgDeliveryMinutes = null;
  if (deliveredOrders.length) {
    const totalMs = deliveredOrders.reduce((sum, o) => {
      const created   = parseDateTime(o.created_at);
      const delivered = parseDateTime(o.updated_at);
      return (created && delivered) ? sum + (delivered - created) : sum;
    }, 0);
    avgDeliveryMinutes = Math.round(totalMs / deliveredOrders.length / 60000);
  }

  const mpOrders  = orders.filter(o => o.paid_at);
  const mpRevenue = mpOrders.reduce((s, o) => s + o.total, 0);
  const mpCount   = mpOrders.length;

  const NOT_SHIPPED = new Set(['recibido', 'pago_confirmado', 'en_preparacion']);
  const pendingShipments = orders
    .filter(o => o.paid_at && NOT_SHIPPED.has(o.status))
    .map(o => ({
      id: o.id, order_num: o.order_num, client_name: o.client_name,
      total: o.total, status: o.status, paid_at: o.paid_at,
      mp_payment_id: o.mp_payment_id || null
    }))
    .sort((a, b) => b.id - a.id);

  return { total, totalRevenue, avgTicket, completed, byStatus, byDay, topProducts,
           avgDeliveryMinutes, mpRevenue, mpCount, pendingShipments };
}

// ── Turnos ────────────────────────────────────────────
async function getShifts() {
  const snap = await fs.collection('shifts').orderBy('id', 'desc').get();
  return snap.docs.map(d => d.data());
}

async function saveShift(shiftData) {
  const snap = await fs.collection('shifts').orderBy('id', 'desc').limit(1).get();
  const maxId = snap.empty ? 0 : (snap.docs[0].data().id || 0);
  const id    = maxId + 1;
  const shift = { id, closed_at: nowStr(), ...shiftData };
  await fs.collection('shifts').doc(String(id)).set(shift);
  return shift;
}

module.exports = {
  createOrder, getOrders, resetOrders, updateStatus, getMetrics,
  getUser, upsertUser, approveUser, getPendingUsers, getAllUsers,
  getStoreConfig, updateStoreConfig,
  getCatalog, addCatalogItem, updateCatalogItem, deleteCatalogItem,
  getPrices,
  getShifts, saveShift,
  parseDateTime,
};
