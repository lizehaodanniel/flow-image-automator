"""通过 GitHub API 创建 Release 并上传 zip 资产。

token 仅从 macOS 钥匙串即时读取，绝不打印或落盘。
用法：python3 scripts/make_release.py
"""
import subprocess, json, sys, urllib.request, urllib.error

REPO = "lizehaodanniel/flow-image-automator"
ZIP = "/Users/daniel/workbuddy-ai/skill/AICheatCode-v1.3.15.zip"
TAG = "v1.3.15"
NAME = "AICheatCode v1.3.15"

# 从 macOS 钥匙串读取 token（不打印）
try:
    token = subprocess.check_output(
        ["security", "find-internet-password", "-s", "github.com", "-w"],
        stderr=subprocess.DEVNULL,
    ).decode().strip()
except Exception:
    token = ""
if not token:
    print("ERROR: 无法从钥匙串读取 GitHub token（请先在本机登录过 GitHub）")
    sys.exit(1)

API = "https://api.github.com"
HEADERS = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
}

body = (
    "A free, self-hosted Chrome MV3 extension that batch-submits prompts to Google Flow "
    "and auto-downloads the generated images / videos.\n\n"
    "Features\n"
    "- Multiple modes: Text-to-Image / Text-to-Video / Frame-to-Video / Ingredients / Image-to-Image\n"
    "- Auto-uploads reference images for Frame-to-Video & Ingredients (no manual upload)\n"
    "- Bilingual UI (Chinese / English), choice is remembered\n"
    "- Batch queue, retries, random delay, per-project folders, auto-rename\n"
    "- No login, runs locally, no data leaves your machine\n\n"
    "Install: unzip -> open chrome://extensions (or edge://extensions / brave://extensions) "
    "-> enable Developer mode -> click \"Load unpacked\" -> select the unzipped folder.\n\n"
    "See the README for the full guide and FAQ."
)

# 1) 创建 Release
data = json.dumps({
    "tag_name": TAG, "name": NAME, "body": body,
    "draft": False, "prerelease": False,
}).encode()
req = urllib.request.Request(
    f"{API}/repos/{REPO}/releases", data=data, headers=HEADERS, method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        rel = json.load(r)
except urllib.error.HTTPError as e:
    detail = e.read().decode()[:600]
    print("创建 Release 失败:", e.code, detail)
    sys.exit(1)

upload_url = rel["upload_url"].split("{")[0]
print("Release 页:", rel["html_url"])

# 2) 上传 zip 资产
with open(ZIP, "rb") as f:
    asset_data = f.read()
req2 = urllib.request.Request(
    f"{upload_url}?name=AICheatCode-v1.3.15.zip",
    data=asset_data,
    headers={**HEADERS, "Content-Type": "application/zip"},
    method="POST",
)
try:
    with urllib.request.urlopen(req2, timeout=60) as r2:
        asset = json.load(r2)
except urllib.error.HTTPError as e:
    print("上传 zip 失败:", e.code, e.read().decode()[:400])
    sys.exit(1)

print("✅ zip 下载链接（可直接贴官网）:")
print(asset["browser_download_url"])
print("仓库主页: https://github.com/" + REPO)
