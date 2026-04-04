const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto    = require('crypto');
require('dotenv').config();

// ── Resend (email) ────────────────────────────────────────
const { Resend } = require('resend');
const resend     = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const RESEND_FROM = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

// ── Mercado Pago ──────────────────────────────────────────
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// ── Firebase Admin ────────────────────────────────────────
const admin = require('./firebase');

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
// index.html: nunca cacheado (siempre la versión más nueva)
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../index.html'));
});
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});
app.get('/admin/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, '../admin/index.html'));
});
app.use(express.static(path.join(__dirname, '..'), { index: false }));
app.use('/admin', express.static(path.join(__dirname, '../admin'), { index: false }));

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
    const user    = await db.getUser(decoded.uid);
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
async function calcOrderTotal(items) {
  const prices = await db.getPrices();
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
    let user = await db.getUser(uid);

    if (!user) {
      await db.upsertUser(uid, email, name || email.split('@')[0]);
      user = await db.getUser(uid);
      if (isSuperAdmin) await db.approveUser(uid, true);
      user = await db.getUser(uid);
    }

    if (!user.approved && isSuperAdmin) {
      await db.approveUser(uid, true);
      user = await db.getUser(uid);
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

app.get('/api/store/status', async (req, res) => {
  const config = await db.getStoreConfig();
  res.json({ open: isStoreOpen(config), config });
});

app.patch('/api/store/config', requireAuth, async (req, res) => {
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
  const updated = await db.updateStoreConfig(patch);
  broadcast('store_update', { open: isStoreOpen(updated), config: updated });
  res.json(updated);
});

// ════════════════════════════════════════════════════════
//  GESTIÓN DE USUARIOS (solo super admin)
// ════════════════════════════════════════════════════════

app.get('/api/users', requireSuperAdmin, async (req, res) => {
  res.json(await db.getAllUsers());
});

app.post('/api/users/:uid/approve', requireSuperAdmin, async (req, res) => {
  const user = await db.approveUser(req.params.uid, true);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(user);
});

app.post('/api/users/:uid/reject', requireSuperAdmin, async (req, res) => {
  const user = await db.approveUser(req.params.uid, false);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json(user);
});

// ════════════════════════════════════════════════════════
//  TURNOS
// ════════════════════════════════════════════════════════

async function buildShiftReport(shiftDate, shiftFrom, shiftTo) {
  const allOrders = await db.getOrders();
  const [y, m, d] = shiftDate.split('-');
  const datePrefix = `${d}/${m}/${y}`;
  const shiftOrders = allOrders.filter(o => o.created_at && o.created_at.startsWith(datePrefix));

  const total         = shiftOrders.length;
  const delivered     = shiftOrders.filter(o => o.status === 'entregado').length;
  const cancelled     = shiftOrders.filter(o => o.status === 'cancelado').length;
  const totalRevenue  = shiftOrders.reduce((s, o) => s + (o.total || 0), 0);
  const avgTicket     = total ? Math.round(totalRevenue / total) : 0;

  const mpOrders       = shiftOrders.filter(o => o.payment_method === 'mp');
  const transferOrders = shiftOrders.filter(o => o.payment_method === 'transfer');

  const cancelReasons = {};
  shiftOrders.filter(o => o.status === 'cancelado').forEach(o => {
    const r = o.cancel_reason || 'otro';
    cancelReasons[r] = (cancelReasons[r] || 0) + 1;
  });

  const productMap = {};
  shiftOrders.forEach(o => {
    let items; try { items = JSON.parse(o.items_json); } catch { return; }
    items.forEach(item => {
      const key = item.id || item.name;
      if (!productMap[key]) productMap[key] = { name: item.name, sub: item.sub || '', emoji: item.emoji || '🍔', qty: 0, revenue: 0 };
      productMap[key].qty     += item.qty;
      productMap[key].revenue += (item.unitPrice || 0) * item.qty;
    });
  });
  const topProducts = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 5);

  const deliveredWithTimes = shiftOrders.filter(o => o.status === 'entregado' && o.paid_at && o.updated_at);
  let avgDeliveryMinutes = null;
  if (deliveredWithTimes.length) {
    const totalMs = deliveredWithTimes.reduce((sum, o) => {
      const paid = db.parseDateTime(o.paid_at); const upd = db.parseDateTime(o.updated_at);
      return (paid && upd) ? sum + (upd - paid) : sum;
    }, 0);
    avgDeliveryMinutes = Math.round(totalMs / deliveredWithTimes.length / 60000);
  }

  return {
    date: shiftDate, from: shiftFrom, to: shiftTo,
    total, delivered, cancelled, totalRevenue, avgTicket,
    mpCount: mpOrders.length, mpRevenue: mpOrders.reduce((s, o) => s + o.total, 0),
    transferCount: transferOrders.length, transferRevenue: transferOrders.reduce((s, o) => s + o.total, 0),
    cancelReasons, topProducts, avgDeliveryMinutes,
    orders: shiftOrders.map(o => ({
      order_num: o.order_num, client_name: o.client_name,
      total: o.total, status: o.status,
      payment_method: o.payment_method, created_at: o.created_at
    }))
  };
}

const CANCEL_LABELS = {
  cliente_no_atendio: 'Cliente no atendió', pedido_duplicado: 'Pedido duplicado',
  pedido_erroneo: 'Error en el pedido',    fuera_de_zona: 'Fuera de zona',
  sin_stock: 'Sin stock', otro: 'Otro',
};

function fmtARS(n) { return '$' + Number(n).toLocaleString('es-AR'); }

function buildEmailHtml(r, localName) {
  const dayNames = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const [yr, mo, dy] = r.date.split('-');
  const dow = dayNames[new Date(r.date + 'T12:00:00').getDay()];
  const dateLabel = `${dow} ${dy}/${mo}/${yr}`;

  const cancelRows = Object.entries(r.cancelReasons)
    .map(([k, v]) => `<tr><td style="padding:4px 8px;color:#aaa">${CANCEL_LABELS[k]||k}</td><td style="padding:4px 8px;text-align:right">${v}</td></tr>`).join('');

  const productRows = r.topProducts
    .map((p, i) => `<tr><td style="padding:5px 8px">${i+1}. ${p.emoji} ${p.name}</td><td style="padding:5px 8px;text-align:right">${p.qty}u</td><td style="padding:5px 8px;text-align:right;color:#D4920A">${fmtARS(p.revenue)}</td></tr>`).join('');

  const orderRows = r.orders
    .map(o => {
      const statusLabel = { recibido:'Recibido', pago_confirmado:'Pago', en_preparacion:'En prep.', en_camino:'En camino', entregado:'Entregado', cancelado:'Cancelado' }[o.status] || o.status;
      const statusColor = o.status === 'entregado' ? '#3A9E5F' : o.status === 'cancelado' ? '#C0392B' : '#888';
      return `<tr><td style="padding:4px 8px;color:#888">${o.order_num}</td><td style="padding:4px 8px">${o.client_name}</td><td style="padding:4px 8px;text-align:right;color:#D4920A">${fmtARS(o.total)}</td><td style="padding:4px 8px;color:${statusColor}">${statusLabel}</td><td style="padding:4px 8px;color:#aaa">${o.payment_method==='mp'?'MP':'Transfer'}</td></tr>`;
    }).join('');

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0e0a04;font-family:Arial,sans-serif;color:#f5f0e6">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#111;border-radius:10px;overflow:hidden">
  <tr><td style="background:#1a1200;padding:24px 28px;border-bottom:2px solid #D4920A">
    <div style="font-size:22px;font-weight:700;color:#D4920A;letter-spacing:2px">${localName}</div>
    <div style="font-size:13px;color:rgba(245,240,230,.5);margin-top:4px">Cierre de turno · ${dateLabel} · ${r.from}–${r.to}</div>
  </td></tr>
  <tr><td style="padding:24px 28px">
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px">
      <tr>
        <td style="background:#1a1a1a;border-radius:8px;padding:16px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:700;color:#f5f0e6">${r.total}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase">Pedidos</div>
        </td>
        <td style="width:8px"></td>
        <td style="background:#1a1a1a;border-radius:8px;padding:16px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:700;color:#D4920A">${fmtARS(r.totalRevenue)}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase">Ingresos</div>
        </td>
        <td style="width:8px"></td>
        <td style="background:#1a1a1a;border-radius:8px;padding:16px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:700;color:#3A9E5F">${r.delivered}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase">Entregados</div>
        </td>
        <td style="width:8px"></td>
        <td style="background:#1a1a1a;border-radius:8px;padding:16px;text-align:center;width:25%">
          <div style="font-size:28px;font-weight:700;color:#f5f0e6">${r.avgDeliveryMinutes !== null ? r.avgDeliveryMinutes + ' min' : '—'}</div>
          <div style="font-size:11px;color:#888;text-transform:uppercase">T. promedio</div>
        </td>
      </tr>
    </table>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background:#1a1a1a;border-radius:8px">
      <tr><td colspan="3" style="padding:12px 16px 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#D4920A">Métodos de pago</td></tr>
      <tr><td style="padding:6px 16px">🔵 Mercado Pago</td><td style="padding:6px 16px;text-align:right;color:#888">${r.mpCount} pedidos</td><td style="padding:6px 16px;text-align:right;color:#D4920A">${fmtARS(r.mpRevenue)}</td></tr>
      <tr><td style="padding:6px 16px 12px">🏦 Transferencia</td><td style="padding:6px 16px 12px;text-align:right;color:#888">${r.transferCount} pedidos</td><td style="padding:6px 16px 12px;text-align:right;color:#D4920A">${fmtARS(r.transferRevenue)}</td></tr>
    </table>

    ${r.topProducts.length ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background:#1a1a1a;border-radius:8px">
      <tr><td colspan="3" style="padding:12px 16px 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#D4920A">Top productos</td></tr>
      ${productRows}
    </table>` : ''}

    ${r.cancelled > 0 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;background:#1a1a1a;border-radius:8px">
      <tr><td colspan="2" style="padding:12px 16px 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#C0392B">Cancelados (${r.cancelled})</td></tr>
      ${cancelRows}
    </table>` : ''}

    ${r.orders.length ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:8px">
      <tr><td colspan="5" style="padding:12px 16px 6px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#888">Detalle de pedidos</td></tr>
      ${orderRows}
    </table>` : ''}
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid rgba(255,255,255,.07);text-align:center;font-size:11px;color:rgba(245,240,230,.3)">
    Reporte generado automáticamente por JuicySpot Admin
  </td></tr>
</table>
</td></tr></table></body></html>`;
}


app.post('/api/shifts/close', requireAuth, async (req, res) => {
  const { shift_date, shift_from, shift_to } = req.body;
  if (!shift_date || !shift_from || !shift_to) return res.status(400).json({ error: 'Faltan datos del turno' });

  const config    = await db.getStoreConfig();
  const report    = await buildShiftReport(shift_date, shift_from, shift_to);
  const localName = config.report_name   || 'The JuicySpot';
  const emails    = config.report_emails || [];

  const results = { emails: [] };

  if (resend && emails.length) {
    try {
      await resend.emails.send({
        from:    RESEND_FROM,
        to:      emails,
        subject: `${localName} — Cierre de turno ${shift_date.split('-').reverse().join('/')}`,
        html:    buildEmailHtml(report, localName),
      });
      results.emails = emails;
    } catch (e) {
      console.error('Error enviando email:', e.message);
      results.email_error = e.message;
    }
  }

  const shift = await db.saveShift({ ...report, report_sent_to: { emails } });
  broadcast('shift_closed', { shiftId: shift.id });
  res.json({ ok: true, shiftId: shift.id, results });
});

app.get('/api/shifts', requireSuperAdmin, async (req, res) => {
  res.json(await db.getShifts());
});

app.post('/api/shifts/test-email', requireSuperAdmin, async (req, res) => {
  if (!resend) return res.status(503).json({ error: 'RESEND_API_KEY no configurado' });
  const config    = await db.getStoreConfig();
  const emails    = config.report_emails || [];
  const localName = config.report_name  || 'The JuicySpot';
  if (!emails.length) return res.status(400).json({ error: 'No hay emails configurados' });
  try {
    await resend.emails.send({
      from:    RESEND_FROM,
      to:      emails,
      subject: `${localName} — Email de prueba ✅`,
      html:    `<div style="font-family:Arial,sans-serif;background:#0e0a04;color:#f5f0e6;padding:32px;border-radius:10px;max-width:480px">
        <div style="font-size:20px;font-weight:700;color:#D4920A;margin-bottom:12px">${localName}</div>
        <p style="color:#aaa">Este es un email de prueba del sistema de reportes de cierre de turno.</p>
        <p style="color:#aaa">Si recibiste este mensaje, la configuración de Resend está funcionando correctamente.</p>
        <p style="color:#555;font-size:12px;margin-top:24px">Enviado desde JuicySpot Admin · ${new Date().toLocaleString('es-AR')}</p>
      </div>`,
    });
    res.json({ ok: true, sent_to: emails });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/shifts/test-full', requireSuperAdmin, async (req, res) => {
  const config    = await db.getStoreConfig();
  const localName = config.report_name   || 'The JuicySpot';
  const emails    = config.report_emails || [];

  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  const fakeDate = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;

  const fakeReport = {
    date: fakeDate, from: '18:00', to: '23:00',
    total: 14, delivered: 12, cancelled: 2,
    totalRevenue: 189986, avgTicket: 15832,
    mpCount: 8, mpRevenue: 111992,
    transferCount: 4, transferRevenue: 63996,
    cancelReasons: { cliente_no_atendio: 1, pedido_erroneo: 1 },
    avgDeliveryMinutes: 22,
    topProducts: [
      { emoji:'🍔', name:'Doble Lucy',          sub:'Combo',                    qty:9, revenue:179991 },
      { emoji:'🧀', name:'Juicy Lucy',           sub:'Solo la burger',           qty:7, revenue:55993  },
      { emoji:'🌿', name:'Capresa',              sub:'Combo',                    qty:5, revenue:74995  },
      { emoji:'🎉', name:'Combo Familiar Lucy',  sub:'4 Juicy Lucy completas',   qty:3, revenue:149997 },
      { emoji:'🍟', name:'Papas Adicionales',    sub:'Ración adicional',         qty:6, revenue:29400  },
    ],
    orders: [
      { order_num:'#0041', client_name:'García Juan',      total:19999, status:'entregado', payment_method:'mp'       },
      { order_num:'#0042', client_name:'López Ana',        total:13999, status:'entregado', payment_method:'transfer' },
      { order_num:'#0043', client_name:'Martínez Pedro',   total:7999,  status:'entregado', payment_method:'mp'       },
      { order_num:'#0044', client_name:'Rodríguez María',  total:19999, status:'entregado', payment_method:'transfer' },
      { order_num:'#0045', client_name:'Fernández Luis',   total:15999, status:'entregado', payment_method:'mp'       },
      { order_num:'#0046', client_name:'González Carmen',  total:13999, status:'cancelado', payment_method:'transfer' },
      { order_num:'#0047', client_name:'Díaz Roberto',     total:11999, status:'entregado', payment_method:'mp'       },
      { order_num:'#0048', client_name:'Torres Silvia',    total:19999, status:'entregado', payment_method:'mp'       },
      { order_num:'#0049', client_name:'Ramírez Diego',    total:7999,  status:'entregado', payment_method:'transfer' },
      { order_num:'#0050', client_name:'Morales Paula',    total:15999, status:'entregado', payment_method:'mp'       },
      { order_num:'#0051', client_name:'Jiménez Andrés',   total:13999, status:'cancelado', payment_method:'mp'       },
      { order_num:'#0052', client_name:'Reyes Natalia',    total:19999, status:'entregado', payment_method:'transfer' },
      { order_num:'#0053', client_name:'Cruz Sebastián',   total:7999,  status:'entregado', payment_method:'mp'       },
      { order_num:'#0054', client_name:'Vargas Valentina', total:15999, status:'entregado', payment_method:'mp'       },
    ]
  };

  const results = { emails: [] };

  if (resend && emails.length) {
    try {
      await resend.emails.send({
        from:    RESEND_FROM,
        to:      emails,
        subject: `[PRUEBA] ${localName} — Cierre de turno ${fakeDate.split('-').reverse().join('/')}`,
        html:    buildEmailHtml(fakeReport, localName),
      });
      results.emails = emails;
    } catch (e) {
      results.email_error = e.message;
    }
  } else if (!resend) {
    results.email_error = 'RESEND_API_KEY no configurado';
  }

  res.json({ ok: true, results });
});

app.get('/api/shifts/:id', requireSuperAdmin, async (req, res) => {
  const shifts = await db.getShifts();
  const shift = shifts.find(s => s.id === parseInt(req.params.id));
  if (!shift) return res.status(404).json({ error: 'Turno no encontrado' });
  res.json(shift);
});

// ════════════════════════════════════════════════════════
//  PEDIDOS
// ════════════════════════════════════════════════════════

app.post('/api/orders', orderLimiter, async (req, res) => {
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
  const total = await calcOrderTotal(items);
  if (total <= 0) return res.status(400).json({ error: 'Ningún item tiene precio válido' });

  try {
    const order = await db.createOrder({
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

app.get('/api/orders', requireAuth, async (req, res) => {
  res.json(await db.getOrders());
});

app.patch('/api/orders/:id/status', requireAuth, async (req, res) => {
  const VALID = ['recibido','pago_confirmado','en_preparacion','en_camino','entregado','cancelado'];
  const { status, cancel_reason, cancel_notes } = req.body;
  if (!VALID.includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  if (status === 'cancelado' && !cancel_reason) return res.status(400).json({ error: 'Motivo de cancelación requerido' });
  const order = await db.updateStatus(parseInt(req.params.id), status, null, null, { cancel_reason, cancel_notes });
  if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
  broadcast('status_update', order);
  res.json(order);
});

app.get('/api/metrics', requireAuth, async (req, res) => {
  const { from, to } = req.query;
  res.json(await db.getMetrics(from, to));
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

// Público: catálogo completo (solo activos)
app.get('/api/catalog', async (req, res) => {
  const catalog = await db.getCatalog();
  res.json(catalog.filter(p => p.active !== false));
});

// Admin: catálogo completo incluyendo inactivos
app.get('/api/catalog/all', requireAuth, async (req, res) => {
  res.json(await db.getCatalog());
});

// Admin: agregar producto
app.post('/api/catalog', requireAuth, async (req, res) => {
  const { name, sub, emoji, group, price, active } = req.body;
  if (!name || typeof price !== 'number' || price < 0)
    return res.status(400).json({ error: 'name y price (número >= 0) requeridos' });
  const catalog = await db.addCatalogItem({
    name: String(name).slice(0, 80),
    sub:   String(sub  || '').slice(0, 120),
    emoji: String(emoji || '🍔').slice(0, 8),
    group: ['burger','promo','extra','especial'].includes(group) ? group : 'extra',
    price: Math.round(price),
    active: active !== false,
  });
  broadcast('catalog_update', (await db.getCatalog()).filter(p => p.active !== false));
  res.json(catalog);
});

// Admin: editar producto
app.put('/api/catalog/:id', requireAuth, async (req, res) => {
  const patch = {};
  const { name, sub, emoji, group, price, active } = req.body;
  if (name  !== undefined) patch.name  = String(name).slice(0, 80);
  if (sub   !== undefined) patch.sub   = String(sub).slice(0, 120);
  if (emoji !== undefined) patch.emoji = String(emoji).slice(0, 8);
  if (group !== undefined && ['burger','promo','extra','especial'].includes(group)) patch.group = group;
  if (typeof price === 'number' && price >= 0) patch.price = Math.round(price);
  if (active !== undefined) patch.active = !!active;
  const item = await db.updateCatalogItem(req.params.id, patch);
  if (!item) return res.status(404).json({ error: 'Producto no encontrado' });
  broadcast('catalog_update', (await db.getCatalog()).filter(p => p.active !== false));
  res.json(item);
});

// Admin: eliminar producto
app.delete('/api/catalog/:id', requireAuth, async (req, res) => {
  const ok = await db.deleteCatalogItem(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Producto no encontrado' });
  broadcast('catalog_update', (await db.getCatalog()).filter(p => p.active !== false));
  res.json({ ok: true });
});

// Compat: precios como mapa plano
app.get('/api/prices', async (req, res) => {
  res.json(await db.getPrices());
});

app.delete('/api/orders/all', requireAuth, async (req, res) => {
  await db.resetOrders();
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════
//  MERCADO PAGO
// ════════════════════════════════════════════════════════

app.post('/api/orders/:id/payment', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID inválido' });
  const order = (await db.getOrders()).find(o => o.id === id);
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
    const detail = e?.cause?.message || e?.message || String(e);
    console.error('[MP preference error]', detail);
    res.status(500).json({ error: 'Error al crear preferencia de pago', detail });
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
    const order   = (await db.getOrders()).find(o => o.id === orderId);
    if (!order || order.status !== 'recibido') return;

    const updated = await db.updateStatus(orderId, 'pago_confirmado', null, String(paymentData.id));
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
