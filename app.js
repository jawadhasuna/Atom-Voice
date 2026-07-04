// ============================================================
// Gemini Live API — Continuous Voice Chat (Browser)
// ============================================================
// Handles: mic capture -> 16kHz PCM -> WebSocket -> Gemini Live
//          Gemini audio replies -> playback queue -> speakers
//          Server-side interruption -> clears playback + pulses UI
// ============================================================

const MODEL_NAME = "gemini-3.1-flash-live-preview";

// ---- DOM references ----
const orb = document.getElementById("orb");
const hint = document.getElementById("hint");
const statusEl = document.getElementById("status");
const controls = document.getElementById("controls");
const muteBtn = document.getElementById("muteBtn");
const endBtn = document.getElementById("endBtn");
const errorBanner = document.getElementById("errorBanner");
const orbInner = document.querySelector(".orb-inner");

// ---- State ----
// No key is typed in by the user or stored in localStorage. Each call, we
// fetch the real Gemini API key from our own /api/key endpoint (which reads
// it from Vercel's environment variables) and connect with it directly.
let apiKey = null;
let ws = null;
let audioContext = null;
let micStream = null;
let micSourceNode = null;
let micProcessorNode = null;
let isCallActive = false;
let isMuted = false;
let setupReady = false; // becomes true once Gemini confirms setupComplete

// Playback state
let playbackContext = null;
let nextPlayTime = 0;
const RECEIVE_SAMPLE_RATE = 24000;
const SEND_SAMPLE_RATE = 16000;
let activeSources = []; // track scheduled audio sources so we can cancel them on interrupt
let talkingTimeout = null;

// Audio analysis (drives the orb's real-time reactive scale/glow)
let micAnalyser = null;
let playbackAnalyser = null;
let reactivityFrame = null;
let currentOrbMode = "idle"; // "idle" | "connecting" | "listening" | "talking"

// ============================================================
// Fetch the API key from our backend
// ============================================================
async function fetchApiKey() {
  if (apiKey) return apiKey; // reuse for the session, no need to re-fetch every call
  const response = await fetch("/api/key");
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Key request failed (${response.status})`);
  }
  const data = await response.json();
  apiKey = data.apiKey;
  return apiKey;
}

// ============================================================
// UI helpers
// ============================================================
function setStatus(text, live = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("live", live);
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.classList.add("visible");
}

function clearError() {
  errorBanner.textContent = "";
  errorBanner.classList.remove("visible");
}

function setOrbState(state) {
  // state: "idle" | "connecting" | "listening" | "talking"
  currentOrbMode = state;
  orb.classList.remove("listening", "talking", "connecting");
  if (state !== "idle") orb.classList.add(state);
}

// ============================================================
// Real-time reactive animation: scales/glows the orb based on
// actual audio volume (your voice while listening, Gemini's
// voice while talking) instead of a generic canned pulse.
// ============================================================
function getVolumeLevel(analyser) {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteTimeDomainData(data);
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) {
    const normalized = (data[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / data.length);
  return Math.min(1, rms * 4); // amplify quiet mic signals so motion reads clearly
}

function reactivityLoop(timestamp) {
  let level = 0;
  if (currentOrbMode === "talking") {
    level = getVolumeLevel(playbackAnalyser);
  } else if (currentOrbMode === "listening" && !isMuted) {
    level = getVolumeLevel(micAnalyser);
  }
  // smooth toward the target level instead of jumping, for a calmer motion
  const prev = parseFloat(orb.style.getPropertyValue("--level")) || 0;
  const smoothed = prev + (level - prev) * 0.35;
  orb.style.setProperty("--level", smoothed.toFixed(3));

  // Blob flow speeds up with real volume — louder = faster-moving liquid
  if (orbInner) {
    const duration = 11 - smoothed * 7; // 11s idle drift down to ~4s at full volume
    orbInner.style.animationDuration = `${duration.toFixed(2)}s`;
    const blurAmount = 16 - smoothed * 6; // sharpens slightly as it gets more energetic
    orbInner.style.filter = `blur(${blurAmount.toFixed(1)}px) saturate(1.4) contrast(1.25)`;
  }

  reactivityFrame = requestAnimationFrame(reactivityLoop);
}

function startReactivityLoop() {
  if (!reactivityFrame) reactivityLoop();
}

function stopReactivityLoop() {
  if (reactivityFrame) {
    cancelAnimationFrame(reactivityFrame);
    reactivityFrame = null;
  }
  orb.style.setProperty("--level", 0);
}

// Run continuously from page load so the liquid noise drifts gently
// even before a call starts, not just while connected.
startReactivityLoop();

// ============================================================
// Audio utility: downsample Float32 mic audio to 16-bit PCM at 16kHz
// ============================================================
function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true); // little-endian
  }
  return buffer;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate === inputSampleRate) return buffer;
  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0,
      count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / (count || 1);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ============================================================
// Mic capture -> stream to Gemini
// ============================================================
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === "suspended") await audioContext.resume();
  micSourceNode = audioContext.createMediaStreamSource(micStream);

  micAnalyser = audioContext.createAnalyser();
  micAnalyser.fftSize = 256;
  micSourceNode.connect(micAnalyser);

  // ScriptProcessorNode is deprecated but has the widest browser support
  // for this kind of raw-sample access without extra build tooling.
  const bufferSize = 4096;
  micProcessorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

  micProcessorNode.onaudioprocess = (event) => {
    if (!isCallActive || isMuted || !setupReady) return;
    const input = event.inputBuffer.getChannelData(0);
    const downsampled = downsampleBuffer(input, audioContext.sampleRate, SEND_SAMPLE_RATE);
    const pcm = floatTo16BitPCM(downsampled);
    const b64 = arrayBufferToBase64(pcm);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: b64,
              mimeType: `audio/pcm;rate=${SEND_SAMPLE_RATE}`,
            },
          },
        })
      );
    }
  };

  micSourceNode.connect(micProcessorNode);
  // ScriptProcessorNode only fires onaudioprocess while connected to a
  // destination, but we never want the raw mic signal actually audible —
  // that would echo the user's own voice (and can feedback-loop on speakers).
  // Route it through a zero-gain node instead of audioContext.destination.
  const muteNode = audioContext.createGain();
  muteNode.gain.value = 0;
  micProcessorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);
}

function stopMic() {
  if (micProcessorNode) micProcessorNode.disconnect();
  if (micSourceNode) micSourceNode.disconnect();
  if (micStream) micStream.getTracks().forEach((track) => track.stop());
  if (audioContext) audioContext.close();
  micProcessorNode = null;
  micSourceNode = null;
  micStream = null;
  audioContext = null;
  micAnalyser = null;
}

// ============================================================
// Playback of Gemini's audio replies
// ============================================================
function ensurePlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: RECEIVE_SAMPLE_RATE,
    });
    nextPlayTime = playbackContext.currentTime;
    playbackAnalyser = playbackContext.createAnalyser();
    playbackAnalyser.fftSize = 256;
    playbackAnalyser.connect(playbackContext.destination);
  }
  if (playbackContext.state === "suspended") playbackContext.resume();
}

function playAudioChunk(base64Data) {
  ensurePlaybackContext();

  const arrayBuffer = base64ToArrayBuffer(base64Data);
  const int16 = new Int16Array(arrayBuffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const audioBuffer = playbackContext.createBuffer(1, float32.length, RECEIVE_SAMPLE_RATE);
  audioBuffer.copyToChannel(float32, 0);

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackAnalyser);

  const startTime = Math.max(nextPlayTime, playbackContext.currentTime);
  source.start(startTime);
  nextPlayTime = startTime + audioBuffer.duration;

  activeSources.push(source);
  source.onended = () => {
    activeSources = activeSources.filter((s) => s !== source);
  };

  // Reflect "talking" in the UI while audio is scheduled/playing
  setOrbState("talking");
  clearTimeout(talkingTimeout);
  const msRemaining = (nextPlayTime - playbackContext.currentTime) * 1000;
  talkingTimeout = setTimeout(() => {
    if (isCallActive) setOrbState("listening");
  }, Math.max(msRemaining, 150));
}

function clearPlaybackQueue() {
  // Called when the server reports an interruption (user started talking)
  activeSources.forEach((source) => {
    try {
      source.stop();
    } catch (e) {
      /* already stopped */
    }
  });
  activeSources = [];
  if (playbackContext) {
    nextPlayTime = playbackContext.currentTime;
  }
  clearTimeout(talkingTimeout);
  setOrbState("listening");
}

// ============================================================
// WebSocket connection to Gemini Live
// ============================================================
function connectWebSocket() {
  setupReady = false;
  // Plain API key in the query param — same as before, except the key now
  // comes from our own /api/key endpoint instead of a user-typed value.
  // This does still expose the key to anyone with devtools open during a
  // call; restrict the key to your domain in Google AI Studio to limit
  // what a copied key could be used for elsewhere.
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    const setupMessage = {
      setup: {
        model: `models/${MODEL_NAME}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
        },
        systemInstruction: {
          parts: [
            {
              text: "You are a friendly, casual conversational partner. Keep replies short and natural, like a real phone call.",
            },
          ],
        },
      },
    };
    ws.send(JSON.stringify(setupMessage));
    clearError();
    setStatus("connect");
    hint.textContent = "Setup";
  };

  ws.onmessage = async (event) => {
    let data = event.data;
    if (data instanceof Blob) {
      data = await data.text();
    }
    const response = JSON.parse(data);

    if (response.setupComplete) {
      setupReady = true;
      setStatus("live", true);
      setOrbState("listening");
      hint.textContent = "Atom Listens";
      return;
    }

    if (response.serverContent) {
      const serverContent = response.serverContent;

      if (serverContent.interrupted) {
        clearPlaybackQueue();
        return;
      }

      if (serverContent.modelTurn && serverContent.modelTurn.parts) {
        for (const part of serverContent.modelTurn.parts) {
          if (part.inlineData && part.inlineData.data) {
            playAudioChunk(part.inlineData.data);
          }
        }
      }
    }
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    setStatus("connection error");
    showError("Connection error — check console for details. Your session token may have expired.");
  };

  ws.onclose = (event) => {
    setStatus("offline");
    setOrbState("idle");
    // Most auth/model errors surface here as a close code + reason,
    // since Gemini's server closes the socket instead of erroring it.
    if (isCallActive) {
      const reason = event.reason || `code ${event.code}`;
      const looksLikeBadKey = /api key|permission|unauthenticated|invalid/i.test(reason);
      if (looksLikeBadKey) {
        apiKey = null; // force a re-fetch from /api/key on the next attempt
        showError(`Disconnected: ${reason}. Tap the circle to try again.`);
      } else {
        showError(`Disconnected: ${reason}. Try tapping the circle again to start a fresh session.`);
      }
      isCallActive = false;
      stopMic();
      controls.classList.remove("visible");
    }
  };
}

// ============================================================
// Call controls
// ============================================================
async function startCall() {
  try {
    clearError();
    setStatus("connect");
    setOrbState("connecting");
    hint.textContent = "Getting ready";

    // Create/resume the playback context first, while we're still inside
    // the tap's user-gesture call stack — needed for iOS Safari, which can
    // otherwise leave an AudioContext "suspended" if it's first created
    // later inside an async WebSocket callback.
    ensurePlaybackContext();

    await fetchApiKey();

    isCallActive = true;
    connectWebSocket();
    await startMic();
    controls.classList.add("visible");
    hint.textContent = "Connecting";
    startReactivityLoop();
  } catch (err) {
    console.error(err);
    const message =
      err && err.message && err.message.includes("Key")
        ? `Couldn't start the session: ${err.message}`
        : "Couldn't access your microphone. Check browser permissions and try again.";
    showError(message);
    isCallActive = false;
    setOrbState("idle");
    setStatus("offline");
  }
}

function endCall() {
  isCallActive = false;
  setupReady = false;
  stopMic();
  clearPlaybackQueue();
  if (ws) {
    ws.close();
    ws = null;
  }
  controls.classList.remove("visible");
  setOrbState("idle");
  setStatus("offline");
  hint.textContent = "Tap to Talk";
  muteBtn.classList.remove("muted");
  muteBtn.querySelector("span").textContent = "Mute";
  isMuted = false;
}

orb.addEventListener("click", () => {
  if (isCallActive) return;
  startCall();
});

endBtn.addEventListener("click", endCall);

muteBtn.addEventListener("click", () => {
  isMuted = !isMuted;
  muteBtn.classList.toggle("muted", isMuted);
  muteBtn.querySelector("span").textContent = isMuted ? "Unmute" : "Mute";
});
