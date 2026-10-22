# Log

- 2026-10-21 — v0.1.0 created. Decisions: static site on Vercel (GitHub connected, auto-deploy) (phone + computer); Gemini (free tier) because it hears audio directly (can judge pronunciation, not just a transcript) and has TTS; Hebrew-letter transliteration everywhere since owner doesn't read Arabic; tap-to-start/tap-to-stop recording; correction mode is a setting (owner undecided: after each sentence vs. summary at end).
- 2026-10-21 — v0.1.1: TTS model reads any instruction text aloud (user heard 'speak slowly…'). Now send ONLY the Arabic text; slow mode = Arabic comma between words. Play buttons toggle to stop (⏹).
- 2026-10-22 — v0.1.2: free-tier gemini-3.8-flash returned 503 'high demand' ~90% of the time. Added withFallback(): on 429/5xx/network try next model in TEXT_MODELS/TTS_MODELS (last-good model goes first), one more round after 2.5s; 404 models skipped. Retry card in chat keeps the recording.
- 2026-10-22 — v0.1.3: Gemini TTS audio ends with ~0.5 s static burst. speechEnd() trims trailing 20 ms windows that are silent (<4% peak RMS) or noisy (zero-crossing rate >0.3), max 1.2 s, keeps 60 ms tail; plus 10 ms fade-in / 80 ms fade-out.
