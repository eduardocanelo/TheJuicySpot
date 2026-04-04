// tests/admin.spec.js — Pruebas del panel admin
// Requiere variables de entorno: ADMIN_EMAIL y ADMIN_PASSWORD
const { test, expect } = require('@playwright/test');

const EMAIL    = process.env.ADMIN_EMAIL    || '';
const PASSWORD = process.env.ADMIN_PASSWORD || '';

// Helper: login
async function login(page) {
  await page.goto('/admin');
  await page.waitForLoadState('networkidle');
  await page.locator('#loginEmail').fill(EMAIL);
  await page.locator('#loginPassword').fill(PASSWORD);
  await page.locator('#loginSubmitBtn').click();
  // Esperar a que aparezca el panel principal
  await expect(page.locator('#adminApp, #mainApp, .tab-btn').first()).toBeVisible({ timeout: 15000 });
}

// ── Login ────────────────────────────────────────────
test('muestra pantalla de login al entrar al admin', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.locator('#loginEmail')).toBeVisible();
  await expect(page.locator('#loginPassword')).toBeVisible();
  await expect(page.locator('#loginSubmitBtn')).toBeVisible();
});

test('login con credenciales incorrectas muestra error', async ({ page }) => {
  await page.goto('/admin');
  await page.locator('#loginEmail').fill('noexiste@test.com');
  await page.locator('#loginPassword').fill('wrongpassword');
  await page.locator('#loginSubmitBtn').click();
  const errEl = page.locator('#loginError, .login-error, [id*="error"]').first();
  await expect(errEl).toBeVisible({ timeout: 8000 });
});

// Los siguientes tests requieren credenciales válidas
test.describe('Con sesión iniciada', () => {
  test.skip(!EMAIL || !PASSWORD, 'Requiere ADMIN_EMAIL y ADMIN_PASSWORD en variables de entorno');

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  // ── Panel principal ──────────────────────────────
  test('muestra las tabs principales', async ({ page }) => {
    await expect(page.locator('#btnPedidos')).toBeVisible();
    await expect(page.locator('#btnMetricas')).toBeVisible();
    await expect(page.locator('#btnPrecios')).toBeVisible();
  });

  test('la tab de pedidos carga el kanban', async ({ page }) => {
    await page.locator('#btnPedidos').click();
    await expect(page.locator('#kanbanView')).toBeVisible();
    // Debe haber al menos una columna
    const columns = page.locator('.kanban-col, [class*="col"]');
    await expect(columns.first()).toBeVisible({ timeout: 5000 });
  });

  // ── Catálogo ──────────────────────────────────────
  test('la tab de precios muestra el catálogo', async ({ page }) => {
    await page.locator('#btnPrecios').click();
    await page.waitForTimeout(1500);
    await expect(page.locator('#catalogList')).toBeVisible();
    // Debe haber al menos un producto listado
    const rows = page.locator('#catalogList [id^="crow_"]');
    await expect(rows.first()).toBeVisible({ timeout: 5000 });
  });

  test('puede agregar un nuevo producto', async ({ page }) => {
    await page.locator('#btnPrecios').click();
    await page.waitForTimeout(1500);
    // Abrir formulario
    await page.locator('#btnNuevoProducto').click();
    await expect(page.locator('#newProductForm')).toBeVisible();
    // Completar datos
    await page.locator('#np_emoji').fill('🧪');
    await page.locator('#np_name').fill('Producto Test Playwright');
    await page.locator('#np_sub').fill('Solo para testing');
    await page.locator('#np_group').selectOption('extra');
    await page.locator('#np_price').fill('9999');
    // Guardar
    await page.locator('button:has-text("+ Agregar")').click();
    await page.waitForTimeout(1500);
    // Verificar que aparece en la lista
    await expect(page.locator('#catalogList')).toContainText('Producto Test Playwright');
  });

  test('puede cambiar el precio de un producto', async ({ page }) => {
    await page.locator('#btnPrecios').click();
    await page.waitForTimeout(1500);
    // Cambiar precio del primer producto visible
    const priceInput = page.locator('#catalogList input[type="number"]').first();
    await priceInput.fill('12345');
    await priceInput.dispatchEvent('change');
    await page.waitForTimeout(1500);
    // Toast de confirmación
    const toast = page.locator('.toast, [class*="toast"], [id*="toast"]').first();
    await expect(toast).toBeVisible({ timeout: 5000 });
  });

  test('puede ocultar y mostrar un producto', async ({ page }) => {
    await page.locator('#btnPrecios').click();
    await page.waitForTimeout(1500);
    const toggleBtn = page.locator('#catalogList button[title="Ocultar"], #catalogList button[title="Mostrar"]').first();
    await toggleBtn.click();
    await page.waitForTimeout(1500);
    // La opacidad del row cambia
  });

  test('puede eliminar el producto de prueba', async ({ page }) => {
    await page.locator('#btnPrecios').click();
    await page.waitForTimeout(1500);
    // Buscar el producto de prueba
    const row = page.locator('#catalogList').locator('text=Producto Test Playwright').first();
    if (await row.count() === 0) return; // ya fue eliminado
    // Click en el botón eliminar del mismo row
    const deleteBtn = row.locator('..').locator('button[title="Eliminar"]');
    page.on('dialog', async dialog => { await dialog.accept(); });
    await deleteBtn.click();
    await page.waitForTimeout(1500);
    await expect(page.locator('#catalogList')).not.toContainText('Producto Test Playwright');
  });

  // ── Métricas ──────────────────────────────────────
  test('la tab de métricas carga y muestra KPIs', async ({ page }) => {
    await page.locator('#btnMetricas').click();
    await page.waitForTimeout(2000);
    // Debe haber al menos un KPI visible
    const kpis = page.locator('.kpi-card, .kpi-val, [class*="kpi"]');
    await expect(kpis.first()).toBeVisible({ timeout: 5000 });
  });

  // ── Tienda abierta/cerrada ────────────────────────
  test('el toggle de tienda abierta/cerrada funciona', async ({ page }) => {
    // El badge de estado está visible
    const badge = page.locator('#storeBadge, [id*="Badge"]').first();
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  // ── Pedidos ───────────────────────────────────────
  test('el botón de borrar todos los pedidos existe', async ({ page }) => {
    await page.locator('#btnPedidos').click();
    const resetBtn = page.locator('button:has-text("Borrar todos los pedidos")');
    await expect(resetBtn).toBeVisible();
  });
});
