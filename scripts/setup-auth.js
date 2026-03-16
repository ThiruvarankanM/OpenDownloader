#!/usr/bin/env node
/**
 * One-time Google account setup for OpenDownloader.
 * Run this before starting the server for the first time.
 *
 * Usage: npm run setup:auth
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(__dirname, '..', '.browser-data', 'profile');

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

console.log('\n────────────────────────────────────────────────');
console.log('  OpenDownloader — Google Account Setup');
console.log('────────────────────────────────────────────────');
console.log('\n  A Chrome window will open.');
console.log('  1. Sign in to your Google account.');
console.log('  2. Once signed in, CLOSE the browser window.');
console.log('  3. Your session is saved — no sign-in ever again.\n');

let context;
try {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    viewport: { width: 1280, height: 720 },
  });
} catch (err) {
  console.error('\n  ERROR: Could not launch Chrome.');
  console.error('  Make sure Google Chrome is installed on your system.\n');
  process.exit(1);
}

const page = context.pages()[0] || await context.newPage();
await page.goto('https://accounts.google.com', { waitUntil: 'load' });

// Wait until the user closes the browser window
await context.waitForEvent('close').catch(() => {});

console.log('\n  Google account saved successfully!');
console.log('  You can now run: npm start\n');
process.exit(0);
