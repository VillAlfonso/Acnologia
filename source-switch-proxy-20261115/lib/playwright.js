import { chromium as baseChromium } from 'playwright';
import { addExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// One isolated plugin-enabled launcher shared by recording and playback.
export const chromium = addExtra(baseChromium);
chromium.use(StealthPlugin());
