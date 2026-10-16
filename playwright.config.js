import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
const temporary = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
const mediaIP = process.env.MEDIA_IP || Object.values(networkInterfaces()).flat().find(address => address.family === 'IPv4' && !address.internal)?.address || '127.0.0.1';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 120000,
  workers: 1,
  use: { baseURL: 'http://localhost:8787', headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH },
  },
  webServer: [
    {
      command: `${process.env.LIVEKIT_BIN || 'livekit-server'} --dev --bind 0.0.0.0 --node-ip ${mediaIP} --keys 'devkey: devsecret-for-local-development-only'`,
      stderr: 'ignore',
      url: 'http://127.0.0.1:7880',
      reuseExistingServer: false,
    },
    {
      command: 'target/debug/screen-share',
      url: 'http://localhost:8787/health',
      env: { LIVEKIT_API_SECRET: 'devsecret-for-local-development-only', DATABASE_PATH: `${temporary}/screen-share-e2e-${process.pid}.db` },
      reuseExistingServer: false,
    },
  ],
});
