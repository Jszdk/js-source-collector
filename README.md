# 前端源码采集器

浏览器插件，用于下载网页的前端源码（JS、Vue、CSS 等），支持 Source Map 还原，方便进行代码审计。

## 功能特点

- **自动资源发现**：扫描页面加载的所有 JavaScript、CSS、Vue 文件
- **Source Map 还原**：自动解析 Source Map，还原原始 TypeScript/Vue 源码
- **Vue 组件提取**：支持从 Source Map 中提取 Vue 单文件组件
- **批量打包下载**：选中资源后一键打包为 ZIP 文件
- **保持目录结构**：下载时保持原始文件目录层级

## 安装方法

### 开发模式安装

1. 打开 Chrome/Edge 浏览器，进入扩展管理页面
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`

2. 开启"开发者模式"

3. 点击"加载已解压的扩展程序"

4. 选择 `source-downloader-plugin` 文件夹

5. 插件安装成功，工具栏会出现插件图标

## 使用方法

1. 打开任意网页（特别是 Vue/React 开发的前端页面）

2. 点击工具栏上的插件图标

3. 点击"扫描"按钮开始分析页面资源

4. 等待扫描完成，查看发现的资源列表

5. 选择需要下载的文件（可按类型筛选）

6. 点击"下载选中 (ZIP)"按钮

7. 解压下载的 ZIP 文件进行代码审计

## 文件结构

```
source-downloader-plugin/
├── manifest.json          # 插件配置
├── popup.html             # 弹窗界面
├── popup.js               # 弹窗逻辑
├── content.js             # 内容脚本（资源发现、ZIP打包）
├── background.js          # 后台脚本（下载管理）
├── lib/
│   └── jszip.min.js       # JSZip 压缩库
└── README.md              # 使用说明
```

## 文件分类说明

下载的 ZIP 文件包含以下目录：

- `javascript/` - JavaScript 文件 (.js)
- `css/` - 样式表文件 (.css)
- `components/` - Vue 组件文件 (.vue)
- `other/` - 其他类型文件

## 技术实现

### 资源发现

- 使用 `Performance API` 获取浏览器加载的所有资源
- 扫描 DOM 中的 `<script>` 和 `<link>` 标签
- 拦截 `fetch/XMLHttpRequest` 捕获动态加载的资源

### Source Map 处理

- 检测 JS 文件末尾的 `sourceMappingURL` 注释
- 自动下载并解析 `.map` 文件
- 提取 `sourcesContent` 中的原始源码
- 识别 Vue 文件并分类保存

### ZIP 打包

- 使用 JSZip 库在前端完成打包
- 支持 DEFLATE 压缩
- 保持原始文件路径结构

## 注意事项

1. **跨域限制**：部分资源可能因 CORS 限制无法下载，会显示下载失败
2. **Source Map**：只有开发环境部署的网站通常包含 Source Map
3. **大文件处理**：大量资源下载可能需要较长时间，请耐心等待
4. **浏览器兼容性**：仅支持 Manifest V3 的现代浏览器（Chrome 88+/Edge 88+）

## 适用场景

- 前端代码安全审计
- 学习他人代码实现
- 备份重要前端资源
- 分析网站技术栈

## 免责声明

本工具仅供学习和安全研究使用，请遵守相关法律法规，不要用于非法用途。

## 更新计划

- [ ] 添加代码美化（prettify）功能
- [ ] 集成 Vue DevTools 直接提取组件
- [ ] 支持 Webpack 代码分割分析
- [ ] 添加资源差异对比功能
