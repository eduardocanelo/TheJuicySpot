// tests/site.spec.js — Pruebas del sitio principal (cliente)
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
});

// ── Carga general ────────────────────────────────────
test('la página carga y muestra el título', async ({ page }) => {
  await expect(page).toHaveTitle(/JuicySpot|Juicy Spot/i);
  // Logo o nav visible
  await expect(page.locator('.nav-logo, .hero-logo').first()).toBeVisible();
});

test('muestra el estado de la tienda (banner o botón)', async ({ page }) => {
  await page.waitForTimeout(2000);
  // Si está cerrado muestra el banner; si está abierto el botón de pedido está activo
  const banner  = page.locator('#closedBanner');
  const sendBtn = page.locator('#sendOrderBtn');
  const bannerVisible = await banner.isVisible().catch(() => false);
  const btnVisible    = await sendBtn.isVisible().catch(() => false);
  expect(bannerVisible || btnVisible).toBe(true);
});

test('el catálogo de burgers es visible', async ({ page }) => {
  await expect(page.locator('text=Juicy Lucy').first()).toBeVisible();
  await expect(page.locator('text=Doble Lucy').first()).toBeVisible();
});

// ── Carrito ──────────────────────────────────────────
test('el carrito abre y cierra', async ({ page }) => {
  const drawer = page.locator('#cartDrawer');
  await page.locator('#cartFloat').click();
  await expect(drawer).toHaveCSS('right', '0px');
  await page.locator('#cartOverlay').click();
  await expect(drawer).not.toHaveCSS('right', '0px');
});

test('agregar un producto al carrito actualiza el contador', async ({ page }) => {
  // Abrir carrito y ir a tab Agregar
  await page.locator('#cartFloat').click();
  await page.locator('#tabAgregar').click();
  await page.waitForTimeout(300);
  // Agregar primer producto de la lista quick
  await page.locator('#quickBurgers button').first().click();
  // Badge del float muestra 1
  await expect(page.locator('#cartCount')).toContainText('1', { timeout: 3000 });
});

test('el total del carrito se calcula correctamente', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.locator('#tabAgregar').click();
  await page.waitForTimeout(300);
  await page.locator('#quickBurgers button').first().click();
  await page.locator('#quickBurgers button').first().click();
  // Ir a tab Pedido para ver el total
  await page.locator('#tabPedido').click();
  await page.waitForTimeout(200);
  const total = page.locator('#cartTotal');
  await expect(total).toBeVisible();
  const text = await total.textContent();
  expect(text).toMatch(/\$/);
  expect(text).not.toBe('$0');
});

// ── Formulario de pedido ─────────────────────────────
// Llama sendOrder() directamente via evaluate para saltear el estado abierto/cerrado
test('muestra error si el carrito está vacío al enviar', async ({ page }) => {
  const dialog = page.waitForEvent('dialog');
  await page.evaluate(() => sendOrder());
  const d = await dialog;
  expect(d.message()).toMatch(/vacío|carrito/i);
  await d.dismiss();
});

test('muestra error si falta el nombre al enviar', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.locator('#tabAgregar').click();
  await page.waitForTimeout(300);
  await page.locator('#quickBurgers button').first().click();
  const dialog = page.waitForEvent('dialog');
  await page.evaluate(() => sendOrder());
  const d = await dialog;
  expect(d.message()).toMatch(/nombre/i);
  await d.dismiss();
});

test('muestra error si no se elige forma de pago', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.locator('#tabAgregar').click();
  await page.waitForTimeout(300);
  await page.locator('#quickBurgers button').first().click();
  await page.locator('#clientName').fill('Test Usuario');
  await page.locator('#clientAddress').fill('Av. Corrientes 1234');
  const dialog = page.waitForEvent('dialog');
  await page.evaluate(() => sendOrder());
  const d = await dialog;
  expect(d.message()).toMatch(/pago|método/i);
  await d.dismiss();
});

test('los botones de pago MP y Transferencia son seleccionables', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.locator('#tabPedido').click();
  await page.waitForTimeout(200);
  await page.locator('#payOptMP').click();
  await expect(page.locator('#payOptMP')).toBeVisible();
  await page.locator('#payOptTransfer').click();
  await expect(page.locator('#payOptTransfer')).toBeVisible();
});

// ── Precios desde API ─────────────────────────────────
test('los precios se cargan desde la API y se muestran', async ({ page }) => {
  await page.waitForTimeout(2000);
  const priceEl = page.locator('[data-price-key="lucy_solo"]').first();
  await expect(priceEl).toBeVisible();
  const text = await priceEl.textContent();
  expect(text).toMatch(/\$/);
  expect(text).not.toBe('$0');
});

// ── Navegación ────────────────────────────────────────
test('el botón WhatsApp del footer abre el carrito', async ({ page }) => {
  const waBtn = page.locator('a.wa, .soc.wa').first();
  if (await waBtn.count() > 0) {
    await waBtn.click();
    await page.waitForTimeout(400);
    await expect(page.locator('#cartDrawer')).toHaveCSS('right', '0px');
  }
});
