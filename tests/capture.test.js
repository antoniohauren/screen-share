import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureOptions, stopCapture } from '../web/capture.js';

test('source-only capture targets 1080p30 and excludes system audio', () => {
  assert.equal(captureOptions.audio, true);
  assert.equal(captureOptions.video.height.ideal, 1080);
  assert.equal(captureOptions.video.frameRate.max, 30);
  assert.equal(captureOptions.systemAudio, 'exclude');
  assert.equal(captureOptions.windowAudio, 'window');
});
test('silent and source-audio captures both clean up every track', () => {
  for (const count of [1, 2]) {
    let stopped = 0;
    stopCapture({ getTracks: () => Array.from({ length: count }, () => ({ stop: () => stopped++ })) });
    assert.equal(stopped, count);
  }
  stopCapture(undefined);
});
