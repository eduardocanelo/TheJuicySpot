/**
 * Genera los íconos PNG para la PWA a partir del logo existente.
 * Uso: node generate-icons.js
 */
const { chromium } = require('@playwright/test');
const path = require('path');
const fs   = require('fs');

const logoPath = path.resolve(__dirname, 'logo_final.png');
const logoB64  = fs.readFileSync(logoPath).toString('base64');

// SVG que envuelve el logo en un cuadrado oscuro con padding
function makeHtml(size) {
  const pad  = Math.round(size * 0.08);
  const inner = size - pad * 2;
  return `<!DOCTYPE html><html><head><style>
    * { margin:0;padding:0;box-sizing:border-box }
    body { width:${size}px;height:${size}px;background:#0e0a04;display:flex;align-items:center;justify-content:center }
    img  { width:${inner}px;height:${inner}px;object-fit:contain }
  </style></head><body>
    <img src="data:image/png;base64,${logoB64}">
  </body></html>`;
}

async function run() {
  const browser = await chromium.launch();
  const page    = await browser.newPage();

  for (const size of [192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(makeHtml(size), { waitUntil: 'load' });
    await page.screenshot({ path: path.join(__dirname, 'icons', `icon-${size}.png`) });
    console.log(`✅ icons/icon-${size}.png`);
  }

  // Apple touch icon (180x180)
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(makeHtml(180), { waitUntil: 'load' });
  await page.screenshot({ path: path.join(__dirname, 'icons', 'apple-touch-icon.png') });
  console.log('✅ icons/apple-touch-icon.png');

  await browser.close();
  console.log('Íconos generados en /icons/');
}

run().catch(e => { console.error(e); process.exit(1); });
