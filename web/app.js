import { Room, RoomEvent, Track, ConnectionState } from 'livekit-client';
import { captureOptions, stopCapture } from './capture.js';

const video = document.querySelector('#video');
const toggle = document.querySelector('#toggle');
const status = document.querySelector('#status');
const listen = document.querySelector('#listen');
const viewer = location.pathname.startsWith('/watch/');
let credentials, socket, room, capture, generation, mediaGeneration;
let connecting = false, requesting = false, pendingStop = false, terminal = false;
let serverEnded = false, retryAt = 0, attempt = 0;
let remote = new MediaStream();
const say = text => { status.textContent = text; };
const send = value => { if (socket?.readyState === WebSocket.OPEN) { socket.send(JSON.stringify(value)); return true; } return false; };

function save() {
  localStorage.setItem('screen-share-owner', JSON.stringify({ ...credentials, pendingStop }));
}
async function dropMedia() {
  const previous = room;
  room = undefined;
  mediaGeneration = undefined;
  if (previous) await previous.disconnect(false); // preserve browser capture for reconnect
  if (viewer) { remote = new MediaStream(); video.srcObject = null; listen.hidden = true; }
}
function mediaStatus() {
  if (viewer) {
    if (!remote.getVideoTracks().length) { say(serverEnded ? 'Broadcast ended.' : 'Waiting for the presenter…'); return; }
    const audio = remote.getAudioTracks().length > 0;
    say(audio ? (video.muted ? 'Live · audio muted' : 'Live') : 'Live · no source audio');
    listen.hidden = !video.paused && (!audio || !video.muted);
  } else if (capture) say(capture.getAudioTracks().length ? 'Live · source audio' : 'Live · no source audio');
}
async function connectMedia(message) {
  requesting = false;
  if (connecting || terminal || pendingStop || (viewer && (serverEnded || message.generation !== generation)) || (!viewer && !capture)) return;
  if (room && mediaGeneration === message.generation && room.state !== ConnectionState.Disconnected) return;
  connecting = true;
  const currentAttempt = ++attempt;
  try {
    await dropMedia();
    const next = new Room({ adaptiveStream: true, dynacast: true, stopLocalTrackOnUnpublish: false });
    room = next;
    mediaGeneration = message.generation;
    next.on(RoomEvent.Reconnecting, () => say('Connection interrupted · reconnecting…'));
    next.on(RoomEvent.Reconnected, mediaStatus);
    next.on(RoomEvent.Disconnected, () => {
      if (room === next) {
        room = undefined;
        requesting = false;
        if (viewer) { remote = new MediaStream(); video.srcObject = null; }
        say(serverEnded ? 'Broadcast ended.' : 'Connection interrupted · reconnecting…');
      }
    });
    next.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (!viewer || room !== next || participant.identity !== 'presenter') return;
      // SDK attachment is required for adaptive-stream visibility/size tracking.
      const muted = video.muted;
      track.attach(video);
      video.muted = muted;
      remote = video.srcObject;
      // Hint only; browser congestion control and actual display measurements remain authoritative.
      if (track.receiver && 'playoutDelayHint' in track.receiver) track.receiver.playoutDelayHint = 0;
      video.play().catch(error => {
        if (room === next && error.name === 'NotAllowedError') { listen.hidden = false; say('Press Play to watch.'); }
      });
      mediaStatus();
    });
    next.on(RoomEvent.TrackUnsubscribed, track => {
      if (room !== next) return;
      track.detach(video);
      remote.removeTrack(track.mediaStreamTrack);
      mediaStatus();
    });
    next.on(RoomEvent.TrackMuted, () => say('Source paused · waiting…'));
    next.on(RoomEvent.TrackUnmuted, mediaStatus);
    say('Connecting to broadcast…');
    await next.connect(message.url, message.token, { autoSubscribe: viewer });
    if (attempt !== currentAttempt || room !== next || pendingStop || (viewer && (serverEnded || message.generation !== generation)) || (!viewer && !capture)) { await next.disconnect(false); return; }
    if (!viewer) {
      const track = capture.getVideoTracks()[0];
      track.contentHint = 'motion';
      await next.localParticipant.publishTrack(track, {
        source: Track.Source.ScreenShare, videoCodec: 'vp8', simulcast: true,
        degradationPreference: 'maintain-framerate',
        screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 30 },
      });
      for (const audio of capture.getAudioTracks()) {
        if (pendingStop || attempt !== currentAttempt) break;
        await next.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio, dtx: false });
      }
    }
    mediaStatus();
  } catch (error) {
    console.error(error);
    if (attempt === currentAttempt) {
      await dropMedia();
      say('Connection error · retrying…');
      retryAt = Date.now() + 3000;
    }
  } finally { connecting = false; }
}
function requestMedia() {
  if (terminal || connecting || requesting || room || Date.now() < retryAt || generation === undefined) return;
  if (pendingStop) { send({ type: 'stop' }); return; }
  if ((viewer && !serverEnded) || (!viewer && capture)) {
    requesting = send({ type: viewer ? 'connect' : 'start' });
  }
}
function openSocket() {
  if (terminal) return;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/${credentials.id}`);
  socket.onopen = () => {
    send(viewer ? {} : { owner: credentials.owner });
    requesting = false;
  };
  socket.onmessage = async event => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case 'state': {
        serverEnded = message.ended;
        if (serverEnded) requesting = false;
        generation = message.generation;
        if (viewer && (serverEnded || (room && mediaGeneration !== generation))) await dropMedia();
        if (pendingStop) send({ type: 'stop' });
        else requestMedia();
        if (viewer && serverEnded) say('Broadcast ended.');
        else if (!viewer && !capture && !pendingStop) say(serverEnded ? 'Broadcast ended · Play to resume at the same URL.' : 'Ready to share.');
        break;
      }
      case 'media': await connectMedia(message); break;
      case 'stopped':
        pendingStop = false; save(); toggle.disabled = false; say('Broadcast ended · Play to resume at the same URL.'); break;
      case 'capacity': say(message.message); retryAt = Date.now() + 5000; break;
      case 'unavailable': terminal = true; say('Broadcast unavailable.'); break;
      case 'unauthorized': terminal = true; say('Presenter credential is invalid. Restore your saved browser profile.'); break;
      case 'error': requesting = false; retryAt = Date.now() + 3000; say(message.message); break;
    }
  };
  socket.onclose = () => {
    ++attempt;
    requesting = false;
    // The control lease also owns the media slot. Do not keep stale media running.
    void dropMedia();
    if (!terminal) {
      if (Date.now() >= retryAt) say('Connection interrupted · reconnecting…');
      setTimeout(openSocket, Math.max(2000, retryAt - Date.now()));
    }
  };
  socket.onerror = () => say('Connection error · retrying…');
}
async function stop() {
  ++attempt;
  pendingStop = true;
  save(); // retry an explicit stop after network loss or a page reload
  stopCapture(capture);
  capture = undefined;
  video.srcObject = null;
  toggle.textContent = 'Play';
  toggle.disabled = true;
  await dropMedia();
  say('Stopping…');
  send({ type: 'stop' });
}
toggle.onclick = async () => {
  if (capture) { await stop(); return; }
  toggle.disabled = true;
  try {
    // Must run directly in the click gesture, before any network await.
    capture = await navigator.mediaDevices.getDisplayMedia(captureOptions);
    capture.getVideoTracks()[0].addEventListener('ended', () => { void stop(); }, { once: true });
    video.srcObject = capture;
    video.muted = true;
    toggle.textContent = 'Stop';
    say('Connecting…');
    requestMedia();
  } catch (error) {
    stopCapture(capture); capture = undefined;
    say(error.name === 'NotAllowedError' ? 'Sharing cancelled. Press Play to choose a source.' : `Capture unavailable: ${error.message}`);
  } finally { toggle.disabled = false; }
};
listen.onclick = async () => {
  video.muted = false;
  try { await video.play(); listen.hidden = true; mediaStatus(); }
  catch { say('Playback blocked. Use the video Play control.'); }
};
video.onvolumechange = () => { if (viewer) mediaStatus(); };
video.onplaying = () => { if (viewer) mediaStatus(); };
document.querySelector('#copy').onclick = async () => {
  const input = document.querySelector('#url');
  try { await navigator.clipboard.writeText(input.value); say('Watch link copied.'); }
  catch { input.select(); say('Copy the selected watch URL.'); }
};
async function init() {
  if (viewer) {
    credentials = { id: location.pathname.split('/')[2] };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentials.id)) { say('Broadcast unavailable.'); return; }
    video.controls = true;
    video.srcObject = null;
  } else {
    const saved = localStorage.getItem('screen-share-owner');
    if (saved) credentials = JSON.parse(saved);
    else {
      const response = await fetch('/api/broadcasts', { method: 'POST' });
      if (!response.ok) throw new Error('Could not create broadcast. Reload to retry.');
      credentials = await response.json();
      save();
    }
    pendingStop = credentials.pendingStop || false;
    document.querySelector('#share').hidden = false;
    document.querySelector('#url').value = `${location.origin}/watch/${credentials.id}`;
    toggle.hidden = false;
    toggle.disabled = pendingStop;
    say('Ready to share.');
  }
  openSocket();
  setInterval(() => { send({ type: 'ping' }); requestMedia(); }, 10000);
}
init().catch(error => say(error.message));
