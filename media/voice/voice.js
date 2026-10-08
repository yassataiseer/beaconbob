// BeaconBob companion voice page. Runs in the user's browser (editor webviews cannot use the
// microphone) and is driven by the extension over a local WebSocket. Audio goes over WebRTC
// directly between participants' pages; the extension only relays offers, answers and ICE
// candidates. No STUN/TURN servers: only LAN host candidates are used.
(() => {
  'use strict';

  // The editor may percent-encode the fragment when opening the browser; undo that first.
  let fragment = location.hash.slice(1);
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // Leave it as is.
  }
  const token = new URLSearchParams(fragment).get('token') || '';
  // Keep the token out of the address bar and history.
  history.replaceState(null, '', location.pathname);

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'),
    call: $('call'),
    idle: $('idle'),
    title: $('title'),
    participants: $('participants'),
    mute: $('mute'),
    leave: $('leave'),
    enableSound: $('enable-sound'),
  };

  const SPEAKING_RMS = 0.015;
  const SPEAKING_HOLD_MS = 400;
  const MAX_BITRATE = 32000;

  let ws = null;
  let inbox = Promise.resolve();
  let replaced = false;
  let selfId = null;
  let selfName = 'You';
  let title = null;
  let muted = false;
  let micStream = null;
  /** peerId -> display name, for everyone else in the call. */
  let participants = new Map();
  /** peerId -> { pc, audio, iceQueue, state, stream } */
  const peers = new Map();
  /** Signals that arrived before we knew the sender was in the call. */
  const early = [];
  let audioCtx = null;
  /** key ('self' or peerId) -> { analyser, buffer, lastLoud } */
  const meters = new Map();
  let speaking = new Set();

  // --- Editor connection ---------------------------------------------------------------------

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => setStatus('Connected to your editor.');
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      // One message at a time, in order: WebRTC setup steps must not interleave.
      inbox = inbox.then(() => handle(msg)).catch((err) => console.warn('message failed', err));
    };
    ws.onclose = () => {
      if (replaced) return;
      setStatus('Lost the connection to your editor. Retrying…', true);
      setTimeout(connect, 2000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'call':
        await onCall(msg);
        break;
      case 'signal':
        await onSignal(msg.from, msg.signal);
        break;
      case 'mute':
        muted = !!msg.muted;
        applyMute();
        render();
        break;
      case 'replaced':
        replaced = true;
        setStatus('BeaconBob voice was opened in another tab. You can close this one.', true);
        closeAll();
        releaseMic();
        break;
    }
  }

  // --- Call membership -----------------------------------------------------------------------

  async function onCall(msg) {
    selfId = msg.selfId;
    selfName = msg.selfName || 'You';
    title = msg.title;
    muted = !!msg.muted;
    participants = new Map(msg.participants.map((p) => [p.peerId, p.name]));

    if (!title) {
      closeAll();
      releaseMic();
      render();
      return;
    }
    if (!(await ensureMic())) {
      render();
      return;
    }
    for (const id of [...peers.keys()]) if (!participants.has(id)) closePeer(id);
    for (const id of participants.keys()) if (!peers.has(id)) createPeer(id);
    // Replay anything that raced ahead of this update.
    for (const pending of early.splice(0)) await onSignal(pending.from, pending.signal);
    render();
  }

  async function ensureMic() {
    if (micStream) return true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      applyMute();
      meter('self', micStream);
      send({ type: 'ready', mic: 'ok' });
      setStatus('Microphone on. Connected to your editor.');
      return true;
    } catch (err) {
      const denied = err && err.name === 'NotAllowedError';
      send({ type: 'ready', mic: denied ? 'denied' : 'error', message: String((err && err.message) || err) });
      setStatus(
        denied
          ? 'Microphone access was blocked. Allow it for this page (address bar) and reload.'
          : `Could not open the microphone: ${(err && err.message) || err}`,
        true,
      );
      return false;
    }
  }

  function releaseMic() {
    if (!micStream) return;
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
    meters.delete('self');
  }

  function applyMute() {
    if (micStream) for (const track of micStream.getAudioTracks()) track.enabled = !muted;
  }

  // --- WebRTC --------------------------------------------------------------------------------

  /** The peer with the lower id makes the offer, so two pages never offer at once. */
  const isOfferer = (id) => selfId < id;

  function createPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const audio = new Audio();
    audio.autoplay = true;
    const entry = { pc, audio, iceQueue: [], state: 'connecting', stream: null };
    peers.set(id, entry);

    for (const track of micStream.getAudioTracks()) pc.addTrack(track, micStream);
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ type: 'signal', to: id, signal: { type: 'ice', candidate: event.candidate.toJSON() } });
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      entry.stream = stream;
      audio.srcObject = stream;
      play(audio);
      meter(id, stream);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      entry.state = s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : 'connecting';
      reportConnections();
      render();
      if (s === 'failed' && isOfferer(id)) {
        // Start over after a moment; the other side recreates its end when the new offer lands.
        setTimeout(() => {
          if (peers.get(id) === entry && participants.has(id)) {
            closePeer(id);
            createPeer(id);
          }
        }, 2000);
      }
    };
    if (isOfferer(id)) void makeOffer(id, entry);
    reportConnections();
    return entry;
  }

  async function makeOffer(id, entry) {
    try {
      await entry.pc.setLocalDescription(await entry.pc.createOffer());
      send({ type: 'signal', to: id, signal: { type: 'offer', sdp: entry.pc.localDescription.sdp } });
      limitBitrate(entry.pc);
    } catch (err) {
      console.warn('offer failed', err);
    }
  }

  async function onSignal(from, signal) {
    if (!participants.has(from) || !micStream) {
      if (early.length < 64) early.push({ from, signal });
      return;
    }
    let entry = peers.get(from);
    try {
      if (signal.type === 'offer') {
        // A fresh offer for a connection we already set up means the offerer restarted.
        if (!entry || entry.pc.remoteDescription) {
          if (entry) closePeer(from);
          entry = createPeer(from);
        }
        await entry.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        send({ type: 'signal', to: from, signal: { type: 'answer', sdp: entry.pc.localDescription.sdp } });
        limitBitrate(entry.pc);
        await flushIce(entry);
      } else if (signal.type === 'answer') {
        if (entry && entry.pc.signalingState === 'have-local-offer') {
          await entry.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
          await flushIce(entry);
        }
      } else if (signal.type === 'ice') {
        if (!entry) return;
        // Candidates can arrive before the description they belong to; hold them until then.
        if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(signal.candidate);
        else entry.iceQueue.push(signal.candidate);
      }
    } catch (err) {
      console.warn('signal failed', signal.type, err);
    }
  }

  async function flushIce(entry) {
    while (entry.iceQueue.length > 0) {
      try {
        await entry.pc.addIceCandidate(entry.iceQueue.shift());
      } catch (err) {
        console.warn('ice failed', err);
      }
    }
  }

  /** Opus voice at 32 kbps, as in the design doc. */
  function limitBitrate(pc) {
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'audio') continue;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = MAX_BITRATE;
      sender.setParameters(params).catch(() => undefined);
    }
  }

  function closePeer(id) {
    const entry = peers.get(id);
    if (!entry) return;
    peers.delete(id);
    entry.pc.close();
    entry.audio.srcObject = null;
    meters.delete(id);
    reportConnections();
  }

  function closeAll() {
    for (const id of [...peers.keys()]) closePeer(id);
  }

  function reportConnections() {
    const states = {};
    for (const [id, entry] of peers) states[id] = entry.state;
    send({ type: 'connections', states });
  }

  // --- Sound and speaking indicators ---------------------------------------------------------

  function play(audio) {
    audio.play().catch(() => {
      els.enableSound.hidden = false;
    });
  }

  function context() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => undefined);
      if (audioCtx.state === 'suspended') els.enableSound.hidden = false;
    }
    return audioCtx;
  }

  function meter(key, stream) {
    try {
      const ctx = context();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      meters.set(key, { analyser, buffer: new Float32Array(analyser.fftSize), lastLoud: 0 });
    } catch (err) {
      console.warn('meter failed', err);
    }
  }

  setInterval(() => {
    const now = performance.now();
    const next = new Set();
    for (const [key, m] of meters) {
      m.analyser.getFloatTimeDomainData(m.buffer);
      let sum = 0;
      for (const v of m.buffer) sum += v * v;
      if (Math.sqrt(sum / m.buffer.length) > SPEAKING_RMS) m.lastLoud = now;
      const loud = now - m.lastLoud < SPEAKING_HOLD_MS;
      if (loud && !(key === 'self' && muted)) next.add(key);
    }
    const changed = next.size !== speaking.size || [...next].some((k) => !speaking.has(k));
    if (!changed) return;
    speaking = next;
    send({ type: 'speaking', peers: [...speaking] });
    render();
  }, 100);

  // --- UI ------------------------------------------------------------------------------------

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  function row(name, state, isSpeaking) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = `dot ${state}${isSpeaking ? ' speaking' : ''}`;
    const label = document.createElement('span');
    label.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'state';
    detail.textContent = state === 'connected' ? '' : state;
    li.append(dot, label, detail);
    return li;
  }

  function render() {
    const inCall = !!title;
    els.call.hidden = !inCall;
    els.idle.hidden = inCall;
    if (!inCall) return;
    els.title.textContent = title;
    document.title = `${title} · BeaconBob voice`;
    els.participants.replaceChildren(
      row(`${selfName} (you)${muted ? ' · muted' : ''}`, micStream ? 'connected' : 'connecting', speaking.has('self')),
      ...[...participants].map(([id, name]) => row(name, peers.get(id)?.state ?? 'connecting', speaking.has(id))),
    );
    els.mute.textContent = muted ? 'Unmute' : 'Mute';
    els.mute.classList.toggle('muted-on', muted);
  }

  els.mute.addEventListener('click', () => {
    muted = !muted;
    applyMute();
    send({ type: 'muted', muted });
    render();
  });
  els.leave.addEventListener('click', () => send({ type: 'leave' }));
  els.enableSound.addEventListener('click', () => {
    context();
    for (const entry of peers.values()) entry.audio.play().catch(() => undefined);
    els.enableSound.hidden = true;
  });

  // Read-only diagnostics, used by the automated audio test.
  window.__beaconbobVoice = {
    async stats() {
      const out = {};
      for (const [id, entry] of peers) {
        let bytesReceived = 0;
        (await entry.pc.getStats()).forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') bytesReceived += s.bytesReceived || 0;
        });
        out[id] = { state: entry.pc.connectionState, bytesReceived };
      }
      return out;
    },
    speaking: () => [...speaking],
    muted: () => muted,
  };

  if (!token) setStatus('Open this page from BeaconBob in your editor.', true);
  else connect();
})();
