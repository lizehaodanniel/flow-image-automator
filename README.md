# AICheatCode

免费、自托管的浏览器扩展，批量把提示词提交给 **Google Flow**，自动生成并下载图片 / 视频。
**无需登录、本地运行、不上传任何数据到第三方。**

> 这是 [VEO Automation](https://chrome.google.com/webstore) 类插件的免费自托管替代版，仅供个人 / 学习使用。

---

## ✨ 功能

- **多模式**：文生图 / 文生视频 / 图生视频 / 成分动画 / 图生图
- **图生视频 / 成分动画**：自动把你在「素材图片」里选的图上传到 Flow 并驱动生成（无需手动上传）
- **中英文界面**：右上角切换，选择自动记住
- **批量队列**：每行一条提示词，支持导入 `.txt` / `.csv`
- **重试 / 随机延迟 / 按项目建文件夹 / 自动重命名**，参数可调
- **零成本分发**：开发者模式加载即可，无需花 $5 上架商店

---

## 📦 安装（免费，30 秒搞定）

1. 到 [Releases](https://github.com/lizehaodanniel/flow-image-automator/releases) 下载 `AICheatCode-vX.Y.Z.zip` 并解压到一个**固定位置**。
2. 浏览器打开 `chrome://extensions`（Edge 用 `edge://extensions`、Brave 用 `brave://extensions`）。
3. 打开右上角 **开发者模式**。
4. 点 **「加载已解压的扩展程序」**，选择解压出来的文件夹（里面要有 `manifest.json`）。
5. 打开并登录 [Google Flow](https://labs.google/fx)，点扩展图标 → 打开侧边栏 → 选模式、粘提示词 → **运行 ▶**。

完整图文教程见下方「常见问题」与仓库的发行说明。

---

## ❓ 常见问题

**为什么加载时提示 debugger 权限警告？**
正常。扩展需要用 Chrome 调试接口去「自动上传图片、模拟点击」，才能全自动跑 Flow。本地加载的扩展不会把数据发给任何人。

**生成视频要花钱吗？**
扩展本身免费。但 Google Flow 生成视频/图片要消耗**你自己的 Flow 积分**（和 Google 账号绑定，与扩展无关）。积分不够时视频会失败，纯图片模式更省。

**提示「Service Worker 无效 / 连不上后台」？**
回扩展页，找到 AICheatCode，点 🔄 刷新一下即可。

**怎么更新？**
重新下载新 zip → 覆盖旧文件夹 → 回扩展页点 🔄 刷新。

---

## 🛠 自行构建 / 改图标

```bash
# 重新生成图标（需 Pillow）
python3 scripts/build_icons.py

# 重新打包发布 zip（自动按 manifest 版本号命名）
python3 scripts/package.py
```

---

## ⚠️ 免责声明

本项目与 Google 无官方关联。Google Flow 的功能、积分政策、URL 可能随时变化；
若上传控件结构变动导致自动上传失败，请用侧边栏「🔍 复制页面诊断」把页面结构反馈给作者。
