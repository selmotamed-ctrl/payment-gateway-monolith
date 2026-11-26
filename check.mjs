import { chromium } from 'playwright';
const browser = await chromium.launch({ executablePath: '/home/selmotamed/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome' });
const page = await browser.newPage(); page.on('pageerror',e=>console.log('PAGEERROR',e.stack));
await page.goto('http://127.0.0.1:6123/',{waitUntil:'networkidle'}); await page.waitForTimeout(800);
console.log('HTML', await page.locator('#app').innerHTML());
await browser.close();
