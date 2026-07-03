# Atom Voice — Gemini Live (Browser)

A continuous, interruptible voice conversation with Gemini's Live API,
running in the browser with a secure server-side token setup — safe to
deploy publicly.

## Architecture

- `index.html` / `style.css` / `app.js` — the frontend: circle UI, mic
  capture, WebSocket streaming, playback, liquid-glass visuals
- `api/get-token.js` — a serverless function that holds your **real** API
  key (via an environment variable) and mints a short-lived, single-use
  **ephemeral token** for the browser to use instead
- Your real key **never** reaches the browser. The browser only ever sees
  a token that expires in ~30 minutes and can only start one session.

