
const { chromium } = require('/home/user/node_modules/playwright-core');
const fs = require('fs');
const SITE = 'https://dhvani.sites.tab.bot/';
const OUT = '/home/user/work/dhvani/test/shots/';
const PW = JSON.parse(fs.readFileSync('/home/user/work/dhvani/private/secrets.json')).app_password;
const exe = require('fs').readdirSync(process.env.HOME + '/.cache/ms-playwright').filter(d => d.startsWith('chromium-'))[0];
(async () => {
  const browser = await chromium.launch({ executablePath: `${process.env.HOME}/.cache/ms-playwright/${exe}/chrome-linux64/chrome`,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=/home/user/work/dhvani/test/fakemic.wav%noloop', '--autoplay-policy=no-user-gesture-required'] });
  const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['microphone'], acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
  const page = await ctx.newPage();
  page.on('pageerror', e => log('PAGEERROR', e.message));
  page.on('console', m => { if (m.type() === 'error') log('console', m.text()); });
  await page.goto(SITE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#login:not([hidden])', { timeout: 20000 });
  await page.screenshot({ path: OUT + 'm01-login.png' });
  await page.fill('#pw', 'wrong'); await page.click('#loginForm button'); await page.waitForTimeout(1500);
  log('wrong pw msg:', await page.textContent('#loginErr'));
  await page.fill('#pw', PW); await page.click('#loginForm button');
  await page.waitForSelector('#app:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: OUT + 'm02-speak-empty.png' });
  // record a voice with the fake mic
  await page.click('[data-tab=voices]');
  await page.click('#recBtn'); log('recording…'); await page.waitForTimeout(9500);
  await page.screenshot({ path: OUT + 'm03-recording.png' });
  await page.click('#recBtn'); await page.waitForTimeout(1500);
  log('ref info:', await page.textContent('#refInfo'));
  await page.fill('#vname', 'Test (browser mic)');
  await page.check('#consent');
  await page.screenshot({ path: OUT + 'm04-voice-ready.png', fullPage: true });
  let t = Date.now(); await page.click('#saveVoice');
  await page.waitForSelector('#tab-speak:not([hidden])', { timeout: 120000 });
  log('voice saved in', (Date.now() - t) / 1000, 's; err:', await page.textContent('#voiceErr'));
  await page.fill('#text', 'Namaste dosto! Ye awaaz Dhvani AI ne banayi hai. Aaj ka din bahut accha hai.');
  await page.selectOption('#lang', 'hi');
  await page.screenshot({ path: OUT + 'm05-speak-filled.png', fullPage: true });
  t = Date.now(); await page.click('#genBtn');
  await page.waitForTimeout(3000); await page.screenshot({ path: OUT + 'm06-generating.png' });
  await page.waitForSelector('#result:not([hidden])', { timeout: 180000 });
  log('generated in', (Date.now() - t) / 1000, 's:', await page.textContent('#resultInfo'));
  await page.screenshot({ path: OUT + 'm07-result.png', fullPage: true });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#dlBtn')]);
  await dl.saveAs('/home/user/work/dhvani/test/web-download.mp3'); log('download saved', dl.suggestedFilename());
  await page.click('[data-tab=history]'); await page.waitForTimeout(2500);
  await page.screenshot({ path: OUT + 'm08-history.png', fullPage: true });
  await page.click('[data-tab=voices]'); await page.waitForTimeout(1000);
  await page.screenshot({ path: OUT + 'm09-voices.png', fullPage: true });
  // offline state (simulated: the site answers server-unreachable)
  await page.route('**/api/**', r => r.fulfill({ status: 503, contentType: 'application/json', body: '{"offline":true,"error":"server unreachable"}' }));
  await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('#offline:not([hidden])', { timeout: 20000 });
  await page.screenshot({ path: OUT + 'm10-offline.png' });
  await page.unroute('**/api/**');
  // desktop
  const d = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const dp = await d.newPage(); await dp.goto(SITE, { waitUntil: 'load' }); await dp.waitForTimeout(1500);
  await dp.screenshot({ path: OUT + 'd01-login.png' });
  const dl2 = await d.newPage(); await dl2.goto(SITE + 'download', { waitUntil: 'load' }); await dl2.waitForTimeout(800);
  await dl2.screenshot({ path: OUT + 'd02-download.png' });
  await browser.close(); log('done');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
