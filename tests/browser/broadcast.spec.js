import { test, expect } from '@playwright/test';
import WebSocket from 'ws';

test('real SFU: waiting, source audio, 10 viewers, late join, capacity, authorization, stop and resume', async ({ browser }) => {
  const presenterContext = await browser.newContext();
  const presenter = await presenterContext.newPage();
  // Synthetic display + source audio, not a microphone. Real picker testing is Windows-only.
  await presenter.addInitScript(() => {
    const OriginalWS = window.WebSocket;
    window.testSockets = [];
    window.WebSocket = class extends OriginalWS {
      constructor(...args) { super(...args); window.testSockets.push(this); }
    };
    window.captureRequests = 0;
    const OriginalPC = window.RTCPeerConnection;
    window.testPeers = [];
    window.RTCPeerConnection = class extends OriginalPC {
      constructor(...args) { super(...args); window.testPeers.push(this); }
    };
    navigator.mediaDevices.getUserMedia = () => { throw new Error('Microphone/camera capture must never be requested'); };
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.captureRequests++;
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext('2d');
      setInterval(() => { ctx.fillStyle = '#234567'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.font = '40px sans-serif'; ctx.fillText(String(Date.now()), 20, 180); }, 33);
      const stream = canvas.captureStream(30);
      if (!window.silentCapture) {
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination); oscillator.start();
        stream.addTrack(destination.stream.getAudioTracks()[0]);
      }
      window.testCapture = stream;
      return stream;
    };
  });
  await presenter.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(presenter.locator('#status')).toHaveText('Ready to share.');
  const url = await presenter.locator('#url').inputValue();
  const id = url.split('/').pop();
  const viewers = [];
  const newViewer = async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    viewers.push({ context, page });
    return page;
  };
  const first = await newViewer();
  await expect(first.locator('#status')).toHaveText('Waiting for the presenter…');
  await expect(first.locator('#toggle')).toBeHidden();
  await presenter.locator('#toggle').click();
  await expect(presenter.locator('#status')).toHaveText('Live · source audio');
  await expect(first.locator('#status')).toHaveText('Live · audio muted');
  await expect.poll(() => first.locator('video').evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
  await first.locator('#listen').click();
  await expect(first.locator('#status')).toHaveText('Live');
  await expect(first.locator('#listen')).toBeHidden();
  for (let i = 1; i < 10; i++) await newViewer();
  for (const { page } of viewers) {
    await expect(page.locator('#status')).toContainText('Live');
    await expect.poll(() => page.locator('video').evaluate(v => v.readyState)).toBeGreaterThanOrEqual(2);
  }
  expect(await presenter.evaluate(() => window.testPeers.filter(pc => pc.connectionState !== 'closed' && pc.getSenders().some(sender => sender.track?.readyState === 'live')).length)).toBe(1);
  const overflow = await newViewer();
  await expect(overflow.locator('#status')).toContainText('Broadcast is full');
  // URL alone does not grant publisher access or owner control.
  const denied = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:8787/ws/${id}`, { origin: 'http://localhost:8787' });
    ws.on('open', () => ws.send(JSON.stringify({ owner: id })));
    ws.on('message', data => { resolve(JSON.parse(data)); ws.close(); });
    ws.on('error', reject);
  });
  expect(denied.type).toBe('unauthorized');
  await viewers[1].context.close();
  await expect(overflow.locator('#status')).toContainText('Live', { timeout: 15000 });
  // Drop the control transport while capture remains available; it must republish.
  await presenter.evaluate(() => window.testSockets.find(ws => ws.url.includes('/ws/')).close());
  await expect.poll(() => presenter.evaluate(() => window.testSockets.filter(ws => ws.url.includes('/ws/')).length)).toBeGreaterThan(1);
  await expect(presenter.locator('#status')).toHaveText('Live · source audio', { timeout: 15000 });
  expect(await presenter.evaluate(() => window.captureRequests)).toBe(1);
  await expect(first.locator('#status')).toContainText('Live');
  await presenter.locator('#toggle').click();
  await expect(first.locator('#status')).toHaveText('Broadcast ended.');
  await expect(presenter.locator('#toggle')).toBeEnabled();
  await presenter.evaluate(() => { window.silentCapture = true; });
  await presenter.locator('#toggle').click();
  await expect(first.locator('#status')).toHaveText('Live · no source audio', { timeout: 15000 });
  expect(await presenter.locator('#url').inputValue()).toBe(url);
  // Browser capture-control stop fires ended; programmatic track.stop() alone does not.
  await presenter.evaluate(() => {
    const track = window.testCapture.getVideoTracks()[0];
    track.stop(); track.dispatchEvent(new Event('ended'));
  });
  await expect(first.locator('#status')).toHaveText('Broadcast ended.');
  for (const { context } of viewers) await context.close();
  await presenterContext.close();
});
