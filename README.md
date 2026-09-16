# AICheatCode

A free, self-hosted browser extension that batch-submits prompts to **Google Flow** and auto-downloads the generated images and videos.

**No login. Runs locally. Sends no data to any third party.**

**Latest release: v1.5.22** · [**⬇ Download**](../../releases/latest) · Works in Chrome / Edge / Brave · You need your own Google Flow account (generation uses your own Flow credits).

---

## ✨ Features

- **Multiple modes**: Text-to-Image, Text-to-Video, Frame-to-Video, Ingredients, Image-to-Image
- **Auto-upload for Frame-to-Video & Ingredients**: pick reference images in the side panel — the extension injects them into Flow and drives the generation automatically (no manual upload needed)
- **Character Reference (face lock)**: pick one portrait in the side panel and enable "character lock" — the extension switches to Image-to-Image and uses that image as the base for every prompt, so the same person stays visually consistent across the whole batch. The reference is persisted, so it stays active next time you open the extension.
- **Bilingual UI**: toggle between Chinese and English from the top-right; your choice is remembered
- **Batch queue**: one prompt per line; import from `.txt` / `.csv`
- **Retries, random delay, per-project folders, auto-rename** — all configurable
- **Free distribution**: load unpacked in developer mode — no $5 Web Store fee required

---

## 📦 Install (free, ~30 seconds)

1. **Download** — either grab the newest `AICheatCode-vX.Y.Z.zip` from the [**Releases** page](../../releases), or use the green **Code ▸ Download ZIP** button at the top of this repo page (same files either way). Unzip it to a **permanent location** (don't move or delete it later, or the extension will break).
2. Open `chrome://extensions` in your browser (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder (it must contain `manifest.json`).
5. Open and sign in to [Google Flow](https://labs.google/fx), click the extension icon, open the side panel, choose a mode, paste your prompts, and hit **Run ▶**.

---

## 🎭 Character Reference (keep one person consistent)

Want every generated image to show the **same person**? Use the character reference:

1. In the side panel, scroll to **角色参考图 / Character reference**.
2. Tick **启用角色固定 / Enable character lock**.
3. Click **选择参考图 / Select reference…** and choose a clear, front-facing photo of the person (a full or half body shot with even lighting works best).
4. Paste your prompts — one scene/pose per line. **Do not** describe the person in the prompt; just describe the scene, action, outfit change, background, camera, etc. The reference image supplies the face/identity.
5. Hit **Run ▶**. The extension automatically switches to Image-to-Image. For **every line** it starts a fresh project and re-injects your reference as the base image — so each output is derived directly from your reference (never from a previous output), which keeps the character consistent across the whole batch and avoids the "drift" you get when images are chained together.

> The reference image is stored locally in the extension and stays enabled after you close and reopen the browser. Use a reasonably sized image (under ~2 MB) so it persists reliably.

---

## ❓ FAQ

**Does the extension request a "debugger" permission?**
Yes — and it is genuinely required. Since **v1.5.0** the extension drives Flow through Chrome's DevTools Protocol (`chrome.debugger`). Flow's editor is ProseMirror, and it silently rejects synthetic DOM events (`.click()` / `execCommand` / `KeyboardEvent`): the text lands in the DOM but never reaches Flow's internal state, so the Generate button stays grey and nothing happens. CDP sends hardware-level input that Flow cannot tell apart from a real user.

Two side effects you should expect, **both harmless**:

- A yellow **"AICheatCode is debugging this browser"** bar appears at the top of the page while a batch is running. It goes away when the run ends.
- Chrome may show an **"Errors"** badge on the extension's card in `chrome://extensions`. This is a known false positive caused by the `debugger` session — the extension keeps working normally. Safe to ignore.

CDP is used **only** to type into and click on the Flow page you already have open. Nothing is sent anywhere.

**Does generating videos cost money?**
The extension itself is free. But **Google Flow charges your own Flow credits** for video/image generation (tied to your Google account — completely independent of this extension). If you run out of credits, video generation will fail; image-only modes are cheaper.

**"Service Worker inactive" / "Cannot reach background"?**
Go to `chrome://extensions`, find AICheatCode, and click the 🔄 reload button.

**How do I update?**
Download the new zip, replace the contents of the old folder, then click 🔄 reload on the extension's card.

---

## 📝 Changelog

**v1.5.22** — fixed two batch-run bugs that showed up on long runs:
- **Duplicate outputs.** The "prompt written successfully" check used a loose substring match, so when the previous prompt had not been fully cleared and the new one got appended after it, the check still passed and the *previous* prompt was submitted a second time. All five write-verification points (plus the check before submit) now require an exact full-text match, tolerant only of whitespace / quote / punctuation differences. A run that would previously produce silent duplicates now reports the mismatch instead.
- **Generated, but not downloaded.** When the "generation started" signal was not detected, the run aborted early even though Flow had in fact started and the image was already rendered on the page — so it never reached the download step. It now keeps waiting for the result instead of giving up.
- **The same image downloaded twice.** The result collector no longer scans the instant after clicking (it used to catch the *previous* item's re-rendered blob URL and download that image again), and it now de-duplicates the grid thumbnail against the large preview of the same output.

**v1.5.0** — returned to CDP hardware-level input (see FAQ above). **v1.3.25** and earlier drove Flow with synthetic DOM events, which no longer works on the current Flow editor.

---

## 🛠 Build / regenerate icons

```bash
# Regenerate icons (requires Pillow)
python3 scripts/build_icons.py

# Build a new distribution zip (auto-named from the version in manifest.json)
python3 scripts/package.py
```

---

## ⚠️ Disclaimer

This project is not affiliated with or endorsed by Google. Google Flow's features, pricing, and DOM structure can change at any time. If the auto-upload breaks because Flow changed its upload widget, use the **🔍 Copy page diagnostic** button in the side panel to grab the page structure and share it with the author.
