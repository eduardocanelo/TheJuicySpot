const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: process.env.BASE_URL || 'https://juicy-spot.com',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    headless: false, // true para correr sin ventana
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  reporter: [['html', { open: 'never' }], ['list']],
});
