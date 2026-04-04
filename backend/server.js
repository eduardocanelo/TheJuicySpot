const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
require('dotenv').config();

// ── Mercado Pago ──────────────────────────────────────────
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// ── Firebase Admin ────────────────────────────────────────
const admin = require('firebase-admin');
let _fbCredential;
if (process.env.FIREBASE_PROJECT_ID) {
  const rawKey = process.env.FIREBASE_PRIVATE_KEY || '';
  const pk = rawKey.indexOf('\\n') !== -1 ? rawKey.split('\\n').join('\n') : rawKey;
  _fbCredential = admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  pk
  });
} else {
  _fbCredential = admin.credential.cert(require('./firebase-service-account.json'));
}
admin.initializeApp({ credential: _fbCredential });

const db = require('./db');

const app             = express();
app.set('trust proxy', 1); // Railway + Cloudflare proxy
const PORT            = process.env.PORT         || 3000;
const SUPER_ADMIN     = process.env.SUPER_ADMIN  || 'eduardocanelo@gmail.com';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:3000';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';

// ── Security headers ─────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,        // admin panel usa CDN inline
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }  // necesario para Firebase signInWithPopup
}));

// ── CORS ─────────────────────────────────────────────────
const corsOptions = {
  origin: (origin, cb) => {
    // Permitir peticiones sin origin (apps móviles, Postman en dev, webhooks de MP)
    if (!origin) return cb(null, true);
    const allowed = FRONTEND_ORIGIN.split(',').map(o => o.trim());
    if (allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    cb(new Error('CORS no permitido'));
  },
  credentials: true
};
app.use(cors(corsOptions));

// ── Body limits ───────────────────────────────────────────
// Webhook de MP necesita el raw body para verificar firma
app.use('/api/webhooks/mercadopago', express.raw({ type: 'application/json', limit: '100kb' }));
app.use(express.json({ limit: '50kb' }));

// ── Static ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..')));
app.use('/admin', express.static(path.join(__dirname, '../admin')));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../index.html'));
});

// API responses never cached by Cloudflare
app.use('/api/', (req, res, next) => { res.setHeader('Cache-Control','no-store'); next(); });

// ── Rate limiting ─────────────────────────────────────────
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,  // 10 minutos
  max: 10,                    // máx 10 pedidos por IP en 10 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados pedidos, intentá de nuevo en unos minutos.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutos
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso, intentá más tarde.' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 minuto
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes.' }
});

app.use('/api/', apiLimiter);
app.use('/api/orders', orderLimiter);
app.use('/api/firebase-login', authLimiter);

// ── SSE clients ──────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(c => c.res.write(msg));
}

// ── Auth: verifica Firebase ID token ────────────────────
async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const user    = db.getUser(decoded.uid);
    if (!user || !user.approved) return res.status(403).json({ error: 'Acceso pendiente de aprobación' });
    req.firebaseUser = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

async function requireSuperAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.email !== SUPER_ADMIN) return res.status(403).json({ error: 'Sin permisos' });
    req.firebaseUser = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ── Input validation helpers ─────────────────────────────
function sanitizeString(val, maxLen = 200) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function isValidPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

// Recalcula el total desde los precios del servidor (no confiar en el cliente)
function calcOrderTotal(items) {
  const prices = db.getPrices();
  return items.reduce((sum, item) => {
    const price = prices[item.key];
    const qty   = typeof item.qty === 'number' && item.qty > 0 ? Math.floor(item.qty) : 0;
    if (typeof price !== 'number' || !qty) return sum;
    return sum + price * qty;
  }, 0);
}

// ── Helpers ──────────────────────────────────────────────
function normalizePhone(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (d.startsWith('549')) return d;
  if (d.startsWith('54'))  return d;
  if (d.startsWith('0'))   return '54' + d.slice(1);
  if (d.length <= 10)      return '549' + d;
  return d;
}

// ════════════════════════════════════════════════════════
//  RUTAS DE AUTENTICACIÓN
// ════════════════════════════════════════════════════════

app.post('/api/firebase-login', async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Token requerido' });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const { uid, email, name } = decoded;

    const isSuperAdmin = email === SUPER_ADMIN;
    let user = db.getUser(uid);

    if (!user) {
      db.upsertUser(uid, email, name || email.split('@')[0]);
      user = db.getUser(uid);
      if (isSuperAdmin) db.approveUser(uid, true);
      user = db.getUser(uid);
    }

    if (!user.approved && isSuperAdmin) {
      db.approveUser(uid, true);
      user = db.getUser(uid);
    }

    if (!user.approved) {
      return res.json({ ok: false, pending: true, email, displayName: user.displayName });
    }

    res.json({ ok: true, isSuperAdmin, displayName: user.displayName, email });
  } catch {
    // No exponer el código de error interno
    res.status(401).json({ error: 'Token de Firebase inválido' });
  }
});

// ════════════════════════════════════════════════════════
//  ESTADO DEL LOCAL
// ════════════════════════════════════════════════════════

function isStoreOpen(config) {
  if (config.manualOverride === 'open')   return true;
  if (config.manualOverride === 'closed') return false;
  const now  = new Date();
  const day  = now.getDay();
  const time = now.getHours() * 100 + now.getMinutes();
  const slot = (config.schedule || []).find(s => s.day === day);
  if (!slot) return false;
  const from = parseInt(slot.from.replace(':', ''));
  const to   = parseInt(slot.to.replace(':', ''));
  return time >= from && time < to;
}

app.get('/api/store/status', (req, res) => {
  const config = db.getStoreConfig();
  res.json({ open: isStoreOpen(config), config });
});

app.patch('/api/store/config', requireAuth, (req, res) => {
  const { manualOverride, schedule } = req.body;
  const VALID_OVERRIDES = ['auto', 'open', 'closed'];
  const patch = {};
  if (manualOverride !== undefined) {
    if (!VALID_OVERRIDES.includes(manualOverride)) return res.status(400).json({ error: 'Override inválido' });
    patch.manualOverride = manualOverride;
  }
  if (schedule !== undefined) {
    if (!Array.isArray(schedule)) return res.status(400).json({ error: 'Schedule inválido' });
    patch.schedule = schedule;
  }
  const updated = db.updateStoreConfig(patch);
  broadcast('store_update', { open: isStoreOpen(updated), config: updated });
  res.json(updated);
});

// ════════════════════════════════════════════════════════
//  GESTIÓN DE USUARIOS (solo super admin)
// ════════════════════════════════════════════════════════

app.get('/api/users', requireSuperAdmin, (req, res) => {
  res.json(db.getAllUsers());
});

app.post('/api/users/:uid/approve', requireSuperAdmin, (req, res) => {
  const user = db.approveUser(req.params.uid, true);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(user);
});

app.post('/api/users/:uid/reject', requireSuperAdmin, (req, res) => {
  const user = db.approveUser(req.params.uid, false);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(user);
});

// ════════════════════════════════════════════════════════
//  PEDIDOS
// ════════════════════════════════════════════════════════

app.post('/api/orders', orderLimiter, (req, res) => {
  const { order_num, client_name, client_phone, client_address, items, whatsapp_msg, payment_method } = req.body;

  const name    = sanitizeString(client_name, 100);
  const phone   = sanitizeString(client_phone, 20);
  const address = sanitizeString(client_address, 300);
  const waMsg   = sanitizeString(whatsapp_msg, 2000);
  const oNum    = sanitizeString(order_num, 20);
  const payMethod = ['mp','transfer'].includes(payment_method) ? payment_method : 'mp';

  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  if (phone && !isValidPhone(phone)) return res.status(400).json({ error: 'Teléfono inválido' });
  if (!Array.isArray(items) || !items.length || items.length > 50)
    return res.status(400).json({ error: 'Items inválidos' });

  // Total calculado por el servidor — no se acepta el del cliente
  const total = calcOrderTotal(items);
  if (total <= 0) return res.status(400).json({ error: 'Ningún item tiene precio válido' });

  try {
    const order = db.createOrder({
      order_num:      oNum || '#0001',
      client_name:    name,
      client_phone:   phone ? normalizePhone(phone) : '',
      client_address: address,
      items_json:     JSON.stringify(items),
      total,
      whatsapp_msg:   waMsg,
      payment_method: payMethod
    });
    broadcast('new_order', order);
    res.json({ ok: true, id: order.id, total });
  } catch (e) {
    console.error('Error al guardar pedido:', e.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.get('/api/orders', requireAuth, (req, res) => {
  res.json(db.getOrders());
});

app.patch('/api/orders/:id/status', requireAuth, (req, res) => {
  const VALID = ['recibido','pago_confirmado','en_preparacion','en_camino','entregado'];
  const { status } = req.body;
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  const order = db.updateStatus(parseInt(req.params.id), status);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  broadcast('status_update', order);
  res.json(order);
});

app.get('/api/metrics', requireAuth, (req, res) => {
  const { from, to } = req.query;
  res.json(db.getMetrics(from, to));
});

app.get('/api/orders/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  const client = { id: Date.now(), res };
  sseClients.add(client);
  const hb = setInterval(() => res.write(':ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(client); });
});

// ════════════════════════════════════════════════════════
//  PRECIOS
// ════════════════════════════════════════════════════════

// Público: el frontend carga los precios al arrancar
app.get('/api/prices', (req, res) => {
  res.json(db.getPrices());
});

// Protegido: operadores editan precios
app.put('/api/prices', requireAuth, (req, res) => {
  const patch = req.body;
  if (typeof patch !== 'object' || Array.isArray(patch))
    return res.status(400).json({ error: 'Body inválido' });
  const updated = db.updatePrices(patch);
  broadcast('prices_update', updated);
  res.json(updated);
});

// ════════════════════════════════════════════════════════
//  MERCADO PAGO
// ════════════════════════════════════════════════════════

app.post('/api/orders/:id/payment', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const order = db.getOrders().find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

  try {
    const preference = new Preference(mpClient);
    const result = await preference.create({ body: {
      external_reference: order.id.toString(),
      items: [{
        id:          order.id.toString(),
        title:       `Pedido ${order.order_num} – The JuicySpot`,
        quantity:    1,
        unit_price:  order.total,
        currency_id: 'ARS'
      }],
      payer: {
        name:  order.client_name,
        phone: { area_code: '54', number: order.client_phone }
      },
      back_urls: {
        success: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?pago=exitoso&pedido=${order.order_num}`,
        failure: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?pago=fallido&pedido=${order.order_num}`,
        pending: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?pago=pendiente&pedido=${order.order_num}`
      },
      auto_return: 'approved',
      notification_url: `${process.env.BACKEND_URL || 'http://localhost:3000'}/api/webhooks/mercadopago`,
      statement_descriptor: 'THE JUICYSPOT'
    }});

    res.json({ init_point: result.init_point, sandbox_init_point: result.sandbox_init_point });
  } catch (e) {
    console.error('[MP preference error]', e.message);
    res.status(500).json({ error: 'Error al crear preferencia de pago' });
  }
});

// Webhook de Mercado Pago — con verificación de firma HMAC
app.post('/api/webhooks/mercadopago', async (req, res) => {
  // Verificar firma si hay secret configurado
  if (MP_WEBHOOK_SECRET) {
    const xSignature  = req.headers['x-signature']  || '';
    const xRequestId  = req.headers['x-request-id'] || '';
    const dataId      = req.query['data.id']         || (req.body && JSON.parse(req.body).data && JSON.parse(req.body).data.id) || '';

    // Formato: "ts=<timestamp>,v1=<hash>"
    const parts = {};
    xSignature.split(',').forEach(part => {
      const [k, v] = part.split('=');
      if (k && v) parts[k.trim()] = v.trim();
    });

    if (parts.ts && parts.v1) {
      const manifest = `id:${dataId};request-id:${xRequestId};ts:${parts.ts};`;
      const expected = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))) {
        console.warn('[MP webhook] Firma inválida — rechazado');
        return res.sendStatus(400);
      }
    }
  }

  res.sendStatus(200); // responder rápido a MP

  let body;
  try {
    body = typeof req.body === 'string' || Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString())
      : req.body;
  } catch { return; }

  const { type, data } = body;
  if (type !== 'payment') return;

  try {
    const payment    = new Payment(mpClient);
    const paymentData = await payment.get({ id: data.id });
    if (paymentData.status !== 'approved') return;

    const orderId = parseInt(paymentData.external_reference);
    const order   = db.getOrders().find(o => o.id === orderId);
    if (!order || order.status !== 'recibido') return;

    const updated = db.updateStatus(orderId, 'pago_confirmado', null, String(paymentData.id));
    broadcast('status_update', updated);
    console.log(`✅ Pago aprobado → pedido ${order.order_num} → pago_confirmado (MP#${paymentData.id})`);
  } catch (e) {
    console.error('[MP webhook error]', e.message);
  }
});

// Public key para el frontend
app.get('/api/mp/public-key', (req, res) => {
  res.json({ publicKey: process.env.MP_PUBLIC_KEY });
});

// ── 404 handler ───────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// ── Error handler ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  if (err.message === 'CORS no permitido') return res.status(403).json({ error: 'CORS no permitido' });
  console.error('[Unhandled error]', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Arrancar ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ JuicySpot backend corriendo en http://localhost:${PORT}`);
  console.log(`📊 Panel admin en      http://localhost:${PORT}/admin`);
});
