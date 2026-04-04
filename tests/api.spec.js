// tests/api.spec.js — Pruebas de endpoints de la API
const { test, expect, request } = require('@playwright/test');

let api;

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({
    baseURL: process.env.BASE_URL || 'https://juicy-spot.com',
  });
});

test.afterAll(async () => {
  await api.dispose();
});

test('GET /api/catalog devuelve lista de productos', async () => {
  const res = await api.get('/api/catalog');
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
  expect(data.length).toBeGreaterThan(0);
  const first = data[0];
  expect(first).toHaveProperty('id');
  expect(first).toHaveProperty('name');
  expect(first).toHaveProperty('price');
  expect(first).toHaveProperty('group');
  expect(typeof first.price).toBe('number');
});

test('GET /api/catalog solo devuelve productos activos', async () => {
  const res = await api.get('/api/catalog');
  const data = await res.json();
  data.forEach(p => {
    expect(p.active).not.toBe(false);
  });
});

test('GET /api/prices devuelve mapa de precios', async () => {
  const res = await api.get('/api/prices');
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(typeof data).toBe('object');
  expect(data).toHaveProperty('lucy_solo');
  expect(typeof data.lucy_solo).toBe('number');
});

test('GET /api/store/status devuelve estado de la tienda', async () => {
  const res = await api.get('/api/store/status');
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data).toHaveProperty('isOpen');
  expect(typeof data.isOpen).toBe('boolean');
});

test('GET /api/orders requiere autenticación', async () => {
  const res = await api.get('/api/orders');
  expect([401, 403]).toContain(res.status());
});

test('POST /api/orders sin datos devuelve error de validación', async () => {
  const res = await api.post('/api/orders', { data: {} });
  expect(res.status()).toBe(400);
});

test('POST /api/orders con datos válidos crea el pedido', async () => {
  const res = await api.post('/api/orders', {
    data: {
      client_name:    'Test Playwright',
      client_phone:   '1134567890',
      client_address: 'Av. Corrientes 1234, CABA',
      items_json:     JSON.stringify([{ id:'lucy_solo', name:'Juicy Lucy', sub:'Solo la burger', emoji:'🧀', qty:1, unitPrice:7999, key:'lucy_solo', group:'burger' }]),
      total:          7999,
      payment_method: 'transfer',
      order_num:      '#TEST',
      whatsapp_msg:   'Test',
    }
  });
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(data.ok).toBe(true);
  expect(data).toHaveProperty('id');
});
