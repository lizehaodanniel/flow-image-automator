"""打包 AICheatCode 为可分发 zip（仅含扩展运行所需文件，不含开发/预览文件）。

用法：python3 scripts/package.py
产出：../AICheatCode-vX.Y.Z.zip

注意：
- 不含 scripts/、story-prompts.txt、任何 _ 开头文件、扩展外的预览页
- 扩展目录里绝不能出现 _ 开头的文件，否则 Chrome 拒绝加载（已踩过坑）
"""
import os
import zipfile
import json

EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 读取版本号，自动命名
with open(os.path.join(EXT_DIR, "manifest.json"), encoding="utf-8") as f:
    version = json.load(f)["version"]

OUT = os.path.join(os.path.dirname(EXT_DIR), f"AICheatCode-v{version}.zip")

# 扩展根目录的必需文件
ROOT_FILES = [
    "manifest.json",
    "background.js",
    "content_script.js",
    "panel.html", "panel.css", "panel.js",
    "popup.html", "popup.css", "popup.js",
]
ICON_FILES = ["icon16.png", "icon32.png", "icon48.png", "icon128.png"]


def ensure(p):
    full = os.path.join(EXT_DIR, p)
    if not os.path.isfile(full):
        raise SystemExit(f"[打包失败] 缺少文件：{p}")
    return full


with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for f in ROOT_FILES:
        z.write(ensure(f), arcname=f)
    for ic in ICON_FILES:
        z.write(ensure(os.path.join("icons", ic)), arcname=os.path.join("icons", ic))

size = os.path.getsize(OUT)
print(f"✅ 已打包：{OUT}")
print(f"   版本：v{version}  大小：{size} 字节")
print(f"   内容：{len(ROOT_FILES)} 个根文件 + icons/（{len(ICON_FILES)} 张）")
