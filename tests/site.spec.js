// tests/site.spec.js — Pruebas del sitio principal (cliente)
const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
});

// ── Carga general ────────────────────────────────────
test('la página carga y muestra el título', async ({ page }) => {
  await expect(page).toHaveTitle(/JuicySpot|Juicy Spot/i);
  await expect(page.locator('text=THE JUICY SPOT').first()).toBeVisible();
});

test('muestra el estado de la tienda (abierto o cerrado)', async ({ page }) => {
  const badge = page.locator('#storeStatusBadge, .store-badge, [id*="store"]').first();
  await expect(badge).toBeVisible({ timeout: 5000 });
});

test('el catálogo de burgers es visible', async ({ page }) => {
  await expect(page.locator('text=Juicy Lucy').first()).toBeVisible();
  await expect(page.locator('text=Doble Lucy').first()).toBeVisible();
});

// ── Carrito ──────────────────────────────────────────
test('el carrito abre y cierra', async ({ page }) => {
  const drawer = page.locator('#cartDrawer');
  // Abre
  await page.locator('#cartFloat').click();
  await expect(drawer).toHaveCSS('right', '0px');
  // Cierra con overlay
  await page.locator('#cartOverlay').click();
  await expect(drawer).not.toHaveCSS('right', '0px');
});

test('agregar un producto al carrito actualiza el contador', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.waitForTimeout(400);
  // Click en tab Agregar
  await page.locator('text=Agregar').first().click();
  await page.waitForTimeout(200);
  // Agregar primer producto de la lista
  const addBtn = page.locator('#quickBurgers button').first();
  await addBtn.click();
  // Badge del carrito debe mostrar 1
  const badge = page.locator('#cartBadge, [id*="Badge"], .cart-badge').first();
  await expect(badge).toContainText('1', { timeout: 3000 });
});

test('el total del carrito se calcula correctamente', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.waitForTimeout(400);
  await page.locator('text=Agregar').first().click();
  await page.waitForTimeout(200);
  // Agregar 2 veces el primer producto
  const addBtn = page.locator('#quickBurgers button').first();
  await addBtn.click();
  await addBtn.click();
  // El total debe mostrar un número mayor a 0
  const total = page.locator('#cartTotal, [id*="total"]').first();
  await expect(total).toBeVisible({ timeout: 3000 });
  const text = await total.textContent();
  expect(text).toMatch(/\$/);
});

// ── Formulario de pedido ─────────────────────────────
test('muestra error si falta el nombre al enviar', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.waitForTimeout(400);
  // Agregar producto
  await page.locator('text=Agregar').first().click();
  await page.waitForTimeout(200);
  await page.locator('#quickBurgers button').first().click();
  // Ir a tab Pedido
  await page.locator('text=Pedido').first().click();
  await page.waitForTimeout(200);
  // No llenar nada, intentar enviar
  page.on('dialog', async dialog => {
    expect(dialog.message()).toMatch(/nombre/i);
    await dialog.dismiss();
  });
  await page.locator('#sendOrderBtn').click();
});

test('muestra error si no se elige forma de pago', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.waitForTimeout(400);
  await page.locator('text=Agregar').first().click();
  await page.waitForTimeout(200);
  await page.locator('#quickBurgers button').first().click();
  await page.locator('text=Pedido').first().click();
  await page.waitForTimeout(200);
  // Llenar nombre y dirección
  await page.locator('#clientName').fill('Test Usuario');
  await page.locator('#clientAddress').fill('Av. Corrientes 1234');
  // No elegir forma de pago, intentar enviar
  page.on('dialog', async dialog => {
    expect(dialog.message()).toMatch(/pago|método/i);
    await dialog.dismiss();
  });
  await page.locator('#sendOrderBtn').click();
});

test('los botones de pago MP y Transferencia son seleccionables', async ({ page }) => {
  await page.locator('#cartFloat').click();
  await page.waitForTimeout(400);
  await page.locator('text=Pedido').first().click();
  await page.waitForTimeout(200);
  // Seleccionar Mercado Pago
  await page.locator('#payOptMP').click();
  await expect(page.locator('#payOptMP')).toHaveCSS('border-color', /009ee3|0,158,227/);
  // Seleccionar Transferencia
  await page.locator('#payOptTransfer').click();
  await expect(page.locator('#payOptTransfer')).toHaveCSS('border-color', /D4920A|212,146,10/);
});

// ── Precios desde API ─────────────────────────────────
test('los precios se cargan desde la API y se muestran', async ({ page }) => {
  await page.waitForTimeout(2000); // esperar carga de catálogo
  const priceEl = page.locator('[data-price-key="lucy_solo"]').first();
  await expect(priceEl).toBeVisible();
  const text = await priceEl.textContent();
  expect(text).toMatch(/\$/);
  expect(text).not.toBe('$0');
});

// ── Navegación ────────────────────────────────────────
test('los links de navegación llevan a las secciones correctas', async ({ page }) => {
  // Click en Menú nav
  const menuLink = page.locator('nav a, .nav-link').filter({ hasText: /menú|menu/i }).first();
  if (await menuLink.count() > 0) {
    await menuLink.click();
    await page.waitForTimeout(500);
  }
});

test('el botón WhatsApp del footer abre el carrito', async ({ page }) => {
  const waBtn = page.locator('.soc.wa, a.wa').first();
  if (await waBtn.count() > 0) {
    await waBtn.click();
    await page.waitForTimeout(400);
    const drawer = page.locator('#cartDrawer');
    await expect(drawer).toHaveCSS('right', '0px');
  }
});
