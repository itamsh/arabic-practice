# Architecture

## Turn flow
1. Tap mic → `getUserMedia` → ScriptProcessor collects Float32 PCM (works on Chrome/Safari/Firefox; MediaRecorder formats differ per browser, so we avoid it).
2. Tap again → downsample to 16 kHz mono WAV → base64 → `generateContent` with text prompt (scenario + history) + `inlineData audio/wav`.
3. Response is JSON (`responseSchema` = `TURN_SCHEMA` in prompts.js): what was heard (translit), correction, reply (Arabic w/ tashkeel + translit + Hebrew), hint.
4. Reply Arabic (text ONLY — the TTS model reads instructions aloud) → TTS model (`responseModalities: AUDIO`) → raw PCM L16 24 kHz → AudioBuffer → played on the single shared AudioContext.
   Fallback: browser `speechSynthesis` Arabic voice (MSA-ish, worse).

## Gemini
- Called directly from the browser with the user's key in `x-goog-api-key` header (key in localStorage only).
- Model auto-pick on key save: `GET /v1beta/models`, first match from `TEXT_MODELS` / `TTS_MODELS` in app.js. Cached in localStorage `ap_models`; re-saving the key re-picks.
- As of 2026-10: `gemini-3.8-flash` and `gemini-3.8-flash-tts` are GA and have a free tier (per ai.google.dev pricing page). 2.5 family only for legacy users.
- `thinkingConfig`: `thinkingLevel: 'low'` for 3.x, `thinkingBudget: 0` for 2.5; dropped automatically if the API returns a 400 mentioning "think".

## Gotchas
- iPhone: AudioContext must be created/resumed inside a tap (done in `startScenario` and mic tap). TTS plays through that context so it isn't blocked after the async fetch.
- History is sent as text each turn (single-turn request), not multi-turn `contents` — simpler, and the model sees Arabic + Hebrew of each line.
- Free tier is often overloaded (503 'high demand'); `withFallback` in app.js rotates models. If it keeps failing, consider enabling billing on the key (paid tier gets priority) or reordering TEXT_MODELS.
