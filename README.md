# jimeng-dreamina-downloader

一键下载即梦AI图片/视频。自动拦截API响应获取无水印原图，支持图片/视频详情页和列表页。

## 功能特性

- 🚀 **一键下载**：自动拦截API响应，获取无水印原图
- 📄 **页面兼容**：支持详情页和列表页
- ⚡ **批量下载**：自动批量下载多个资源
- 🔍 **智能识别**：自动识别并提取最高质量资源

## 安装方法

### 1. 安装浏览器扩展

首先安装 Tampermonkey 浏览器扩展：

- **Chrome/Edge**: [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- **Firefox**: [Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/)
- **Safari**: [Tampermonkey](https://apps.apple.com/us/app/tampermonkey/id1482490089)

### 2. 安装用户脚本

1. 点击 [这里](https://github.com/hysong7/jimeng-dreamina-downloader/raw/main/jimeng-dreamina-downloader.user.js) 下载脚本文件
2. 或者复制脚本内容，手动在 Tampermonkey 中创建新脚本
3. 脚本会自动匹配 `https://jimeng.jianying.com/*` 和 `https://dreamina.capcut.com/*` 域名

## 使用方法

### 基本使用

1. **访问网站**：打开 [即梦AI](https://jimeng.jianying.com/) 或 [Dreamina](https://dreamina.capcut.com/)
2. **浏览内容**：进入图片或视频的详情页，或在列表页查看内容
3. **自动拦截**：脚本会自动拦截API响应，提取无水印资源
4. **下载资源**：
   - 在详情页：页面会自动添加下载按钮
   - 在列表页：脚本会扫描并显示可下载资源
   - 点击下载按钮即可开始下载

### 高级功能

- **批量下载**：脚本会自动批量下载页面上的所有可用资源
- **质量选择**：自动选择最高质量的资源（优先2048x2048、1920x1920等）
- **调试模式**：在浏览器控制台查看 `[下⭮]` 开头的日志信息

## 支持的网站

- [即梦AI (jimeng.jianying.com)](https://jimeng.jianying.com/)
- [Dreamina (dreamina.capcut.com)](https://dreamina.capcut.com/)

## 注意事项

- ⚠️ 请遵守网站的Terms of Service，仅用于个人学习和研究
- 🔒 脚本需要网络权限来下载资源，请确保浏览器允许
- 🐛 如果遇到问题，请检查浏览器控制台的错误信息
- 📱 目前仅支持桌面浏览器，不支持移动端


## 贡献

欢迎提交 Issue 和 Pull Request！

## 许可证

MIT License
