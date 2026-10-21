# arabic-practice — Claude notes

Spoken Palestinian (Jerusalem) Arabic conversation partner for a Hebrew-speaking beginner.
Owner cannot read Arabic script → UI shows Hebrew-letter transliteration + Hebrew translation only.

- Static site, no build. `index.html` + `style.css` + `prompts.js` (persona, level, scenarios, JSON schemas) + `app.js` (logic).
- Hosted on GitHub Pages: https://itamsh.github.io/arabic-practice/
- Version: `APP_VERSION` in `app.js`; every bump gets a line in README "גרסאות".
- Knowledge base: `knowledge/index.md` — read before re-investigating; append to `knowledge/log.md`.
