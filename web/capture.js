export const captureOptions = {
  video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  audio: true,
  systemAudio: 'exclude',
  windowAudio: 'window',
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
};

export function stopCapture(stream) {
  for (const track of stream?.getTracks() || []) track.stop();
}
