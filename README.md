# AICheatCode

A free, self-hosted browser extension that batch-submits prompts to **Google Flow** and auto-downloads the generated images and videos.

**No login. Runs locally. Sends no data to any third party.**

---

## ✨ Features

- **Multiple modes**: Text-to-Image, Text-to-Video, Frame-to-Video, Ingredients, Image-to-Image
- **Auto-upload for Frame-to-Video & Ingredients**: pick reference images in the side panel — the extension injects them into Flow and drives the generation automatically (no manual upload needed)
- **Bilingual UI**: toggle between Chinese and English from the top-right; your choice is remembered
- **Batch queue**: one prompt per line; import from `.txt` / `.csv`
- **Retries, random delay, per-project folders, auto-rename** — all configurable
- **Free distribution**: load unpacked in developer mode — no $5 Web Store fee required

---

## 📦 Install (free, ~30 seconds)

1. Download `AICheatCode-vX.Y.Z.zip` from the [Releases](../../releases) page and unzip it to a **permanent location** (don't move or delete it later, or the extension will break).
2. Open `chrome://extensions` in your browser (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder (it must contain `manifest.json`).
5. Open and sign in to [Google Flow](https://labs.google/fx), click the extension icon, open the side panel, choose a mode, paste your prompts, and hit **Run ▶**.

---

## ❓ FAQ

**Why does Chrome warn about a "debugger" permission at load time?**
This is normal. The extension uses the Chrome DevTools Protocol to auto-upload images and dispatch trusted clicks inside Flow. As an unpacked extension loaded by you, it does not send any data anywhere.

**Does generating videos cost money?**
The extension itself is free. But **Google Flow charges your own Flow credits** for video/image generation (tied to your Google account — completely independent of this extension). If you run out of credits, video generation will fail; image-only modes are cheaper.

**"Service Worker inactive" / "Cannot reach background"?**
Go to `chrome://extensions`, find AICheatCode, and click the 🔄 reload button.

**How do I update?**
Download the new zip, replace the contents of the old folder, then click 🔄 reload on the extension's card.

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
