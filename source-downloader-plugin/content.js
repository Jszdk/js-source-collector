// 前端源码采集器 - Content Script
// 负责资源发现、Vue DevTools 集成、Source Map 处理

(function() {
  'use strict';

  // 存储发现的资源
  const discoveredResources = {
    javascript: [],
    css: [],
    sourceMap: [],
    vueComponents: [],
    others: []
  };

  // 存储动态捕获的资源
  const capturedResources = new Set();

  // ============ 资源发现 ============

  /**
   * 使用 Performance API 获取所有资源
   */
  function getPerformanceResources() {
    const entries = performance.getEntriesByType('resource');
    const resources = [];

    for (const entry of entries) {
      const url = entry.name;
      const type = classifyResource(url);

      if (type && !capturedResources.has(url)) {
        capturedResources.add(url);
        resources.push({
          url: url,
          type: type,
          initiatorType: entry.initiatorType,
          size: entry.transferSize || 0
        });
      }
    }

    return resources;
  }

  /**
   * 扫描 DOM 中的资源
   */
  function scanDOMResources() {
    const resources = [];

    // Script 标签
    document.querySelectorAll('script[src]').forEach(script => {
      const url = script.src;
      if (!capturedResources.has(url)) {
        capturedResources.add(url);
        resources.push({
          url: url,
          type: 'javascript',
          source: 'dom'
        });
      }
    });

    // CSS 链接
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach(link => {
      const url = link.href;
      if (!capturedResources.has(url)) {
        capturedResources.add(url);
        resources.push({
          url: url,
          type: 'css',
          source: 'dom'
        });
      }
    });

    // 预加载资源
    document.querySelectorAll('link[rel="preload"][href], link[rel="prefetch"][href], link[rel="modulepreload"][href]').forEach(link => {
      const url = link.href;
      if (!capturedResources.has(url)) {
        capturedResources.add(url);
        const type = classifyResource(url) || 'others';
        resources.push({
          url: url,
          type: type,
          source: 'preload'
        });
      }
    });

    return resources;
  }

  /**
   * 拦截 fetch 捕获动态资源
   */
  function interceptFetch() {
    const originalFetch = window.fetch;

    window.fetch = function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;

      if (url) {
        const type = classifyResource(url);
        if (type && !capturedResources.has(url)) {
          capturedResources.add(url);
          // 通过自定义事件通知 content script
          window.dispatchEvent(new CustomEvent('source-downloader:capture', {
            detail: { url, type, source: 'fetch' }
          }));
        }
      }

      return originalFetch.apply(this, args);
    };
  }

  /**
   * 拦截 XMLHttpRequest 捕获动态资源
   */
  function interceptXHR() {
    const originalOpen = XMLHttpRequest.prototype.open;

    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      const type = classifyResource(url);
      if (type && !capturedResources.has(url)) {
        capturedResources.add(url);
        window.dispatchEvent(new CustomEvent('source-downloader:capture', {
          detail: { url, type, source: 'xhr' }
        }));
      }

      return originalOpen.apply(this, [method, url, ...args]);
    };
  }

  /**
   * 分类资源类型
   */
  function classifyResource(url) {
    try {
      const urlObj = new URL(url, location.href);
      const pathname = urlObj.pathname.toLowerCase();

      if (pathname.endsWith('.js') || pathname.endsWith('.mjs') || pathname.endsWith('.cjs')) {
        return 'javascript';
      }
      if (pathname.endsWith('.css')) {
        return 'css';
      }
      if (pathname.endsWith('.map')) {
        return 'sourceMap';
      }
      if (pathname.endsWith('.vue')) {
        return 'vue';
      }

      // 根据 Content-Type 判断（如果是性能条目）
      return null;
    } catch (e) {
      return null;
    }
  }

  // ============ Source Map 处理 ============

  /**
   * 从 JS 内容中提取 Source Mapping URL
   */
  function extractSourceMapUrl(jsContent, baseUrl) {
    // 匹配末尾的 sourceMappingURL 注释
    const patterns = [
      /\/\/# sourceMappingURL=([^\s]+)/,
      /\/\/@ sourceMappingURL=([^\s]+)/
    ];

    for (const pattern of patterns) {
      const match = jsContent.match(pattern);
      if (match) {
        const mapUrl = match[1].trim();
        // 处理相对路径
        if (mapUrl.startsWith('http')) {
          return mapUrl;
        }
        return new URL(mapUrl, baseUrl).href;
      }
    }

    return null;
  }

  /**
   * 解析 Source Map 数据
   */
  async function parseSourceMap(mapUrl) {
    try {
      const response = await fetch(mapUrl);
      if (!response.ok) return null;

      const mapData = await response.json();

      // 提取原始文件信息
      const files = [];

      if (mapData.sources && mapData.sourcesContent) {
        for (let i = 0; i < mapData.sources.length; i++) {
          const sourcePath = mapData.sources[i];
          const content = mapData.sourcesContent[i];

          if (content) {
            files.push({
              path: sourcePath,
              content: content,
              isVue: sourcePath.endsWith('.vue')
            });
          }
        }
      }

      return {
        version: mapData.version,
        sources: mapData.sources || [],
        files: files,
        hasVueFiles: files.some(f => f.isVue)
      };
    } catch (e) {
      console.error('[Source Downloader] 解析 Source Map 失败:', e);
      return null;
    }
  }

  /**
   * 扫描页面中的 JS 文件并尝试获取 Source Map
   */
  async function scanSourceMaps() {
    const jsResources = discoveredResources.javascript;
    const sourceMaps = [];

    for (const js of jsResources.slice(0, 10)) { // 限制并发数量
      try {
        const response = await fetch(js.url);
        const content = await response.text();

        const mapUrl = extractSourceMapUrl(content, js.url);
        if (mapUrl && !capturedResources.has(mapUrl)) {
          capturedResources.add(mapUrl);

          const mapData = await parseSourceMap(mapUrl);
          if (mapData) {
            sourceMaps.push({
              jsUrl: js.url,
              mapUrl: mapUrl,
              data: mapData
            });

            // 将 Vue 文件添加到组件列表
            for (const file of mapData.files.filter(f => f.isVue)) {
              discoveredResources.vueComponents.push({
                name: file.path.split('/').pop(),
                path: file.path,
                content: file.content,
                source: 'sourcemap'
              });
            }
          }
        }
      } catch (e) {
        // 忽略跨域或加载失败的资源
      }
    }

    return sourceMaps;
  }

  // ============ Vue DevTools 集成 ============

  /**
   * 检测页面是否使用 Vue
   */
  function detectVue() {
    // 检测 Vue 2
    if (window.Vue) {
      return { version: 2, instance: window.Vue };
    }

    // 检测 Vue 3
    if (window.__VUE__) {
      return { version: 3, instance: window.__VUE__ };
    }

    // 检测 Vue DevTools Hook
    if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
      const hook = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
      if (hook.Vue) {
        return { version: hook.Vue.version?.startsWith('3') ? 3 : 2, instance: hook.Vue };
      }
    }

    return null;
  }

  /**
   * 从 Vue DevTools 获取组件树
   */
  function getVueComponents() {
    return new Promise((resolve) => {
      const vueInfo = detectVue();
      if (!vueInfo) {
        resolve([]);
        return;
      }

      const components = [];

      try {
        // 尝试通过 devtools hook 获取组件
        const hook = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;

        if (hook && hook.emit) {
          // 触发组件树扫描
          hook.emit('get-emoji');

          // 如果有 root 实例，尝试遍历
          if (vueInfo.version === 2 && vueInfo.instance.config?.devtools) {
            // Vue 2
          } else if (vueInfo.version === 3) {
            // Vue 3 - 通过 app 实例获取
          }
        }

        // 备用方案：从 DOM 中查找 Vue 组件
        document.querySelectorAll('[data-v-]').forEach(el => {
          const tagName = el.tagName.toLowerCase();
          if (tagName.includes('-') && !components.find(c => c.name === tagName)) {
            components.push({
              name: tagName,
              source: 'dom-detection',
              hasScoped: el.hasAttribute('data-v-')
            });
          }
        });

      } catch (e) {
        console.error('[Source Downloader] 获取 Vue 组件失败:', e);
      }

      resolve(components);
    });
  }

  // ============ 主流程 ============

  /**
   * 收集所有资源
   */
  async function collectAllResources() {
    // 清空之前的数据
    capturedResources.clear();
    discoveredResources.javascript = [];
    discoveredResources.css = [];
    discoveredResources.sourceMap = [];
    discoveredResources.vueComponents = [];
    discoveredResources.others = [];

    // 1. 获取 Performance API 资源
    const perfResources = getPerformanceResources();
    categorizeResources(perfResources);

    // 2. 扫描 DOM 资源
    const domResources = scanDOMResources();
    categorizeResources(domResources);

    // 3. 扫描 Source Maps（异步）
    const sourceMaps = await scanSourceMaps();
    discoveredResources.sourceMap = sourceMaps;

    // 4. 获取 Vue 组件
    const vueComponents = await getVueComponents();
    discoveredResources.vueComponents.push(...vueComponents);

    return discoveredResources;
  }

  /**
   * 将资源分类到对应数组
   */
  function categorizeResources(resources) {
    for (const res of resources) {
      if (discoveredResources[res.type]) {
        // 去重检查
        const exists = discoveredResources[res.type].some(
          existing => existing.url === res.url
        );
        if (!exists) {
          discoveredResources[res.type].push(res);
        }
      }
    }
  }

  /**
   * 下载资源内容
   */
  async function downloadResource(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('text') || contentType.includes('javascript') || contentType.includes('json')) {
        return {
          success: true,
          content: await response.text(),
          contentType: contentType
        };
      } else {
        return {
          success: true,
          content: await response.blob(),
          contentType: contentType
        };
      }
    } catch (e) {
      return {
        success: false,
        error: e.message
      };
    }
  }

  /**
   * 批量下载选中的资源
   */
  async function downloadSelectedResources(selectedUrls) {
    const results = [];

    for (const url of selectedUrls) {
      const data = await downloadResource(url);
      results.push({
        url: url,
        ...data
      });
    }

    return results;
  }

  // ============ 消息处理 ============

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      switch (request.action) {
        case 'scanResources':
          const resources = await collectAllResources();
          sendResponse({
            success: true,
            resources: resources,
            summary: {
              javascript: resources.javascript.length,
              css: resources.css.length,
              sourceMap: resources.sourceMap.length,
              vueComponents: resources.vueComponents.length
            }
          });
          break;

        case 'getSourceMapFiles':
          // 返回 Source Map 中解析出的文件
          const mapData = discoveredResources.sourceMap
            .filter(sm => sm.mapUrl === request.mapUrl)
            .map(sm => sm.data.files)[0];
          sendResponse({ files: mapData || [] });
          break;

        case 'downloadResources':
          const downloaded = await downloadSelectedResources(request.urls);
          sendResponse({
            success: true,
            files: downloaded.filter(d => d.success),
            failed: downloaded.filter(d => !d.success)
          });
          break;
      }
    })();
    return true;
  });

  // 监听动态资源捕获事件
  window.addEventListener('source-downloader:capture', (e) => {
    const { url, type } = e.detail;
    if (!discoveredResources[type].some(r => r.url === url)) {
      discoveredResources[type].push({
        url: url,
        type: type,
        source: 'dynamic'
      });
    }
  });

  // 注入拦截代码到页面上下文
  function injectInterceptors() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        // 拦截 fetch
        const originalFetch = window.fetch;
        window.fetch = function(...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
          if (url) {
            window.dispatchEvent(new CustomEvent('source-downloader:capture', {
              detail: { url, type: 'fetch', timestamp: Date.now() }
            }));
          }
          return originalFetch.apply(this, args);
        };

        // 拦截 XHR
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          window.dispatchEvent(new CustomEvent('source-downloader:capture', {
            detail: { url, type: 'xhr', timestamp: Date.now() }
          }));
          return originalOpen.apply(this, [method, url, ...args]);
        };
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // 页面加载完成后注入拦截器
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectInterceptors);
  } else {
    injectInterceptors();
  }

  // ============ ZIP 打包功能 ============

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    (async () => {
      if (request.action === 'createZip') {
        try {
          const zipData = await createZipPackage(request.files, request.options);
          sendResponse({ success: true, data: zipData });
        } catch (error) {
          console.error('[Source Downloader] 创建 ZIP 失败:', error);
          sendResponse({ success: false, error: error.message });
        }
      }
    })();
    return true;
  });

  async function createZipPackage(files, options) {
    // 检查 JSZip 是否可用
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip 库未加载，请刷新页面后重试');
    }

    const zip = new JSZip();

    // 按类型组织文件夹
    const folders = {
      js: zip.folder('javascript'),
      css: zip.folder('css'),
      vue: zip.folder('components'),
      other: zip.folder('other')
    };

    console.log('[Source Downloader] 开始创建 ZIP，文件数:', files.length);

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      console.log(`[Source Downloader] 处理文件 ${i+1}/${files.length}:`, file.name || file.url);

      try {
        let content;
        let filePath;

        // 如果已经有内容（来自 source map）
        if (file.content) {
          content = file.content;
          filePath = file.path || file.name;
          console.log('[Source Downloader] 使用已有内容:', filePath);
        } else {
          // 否则从网络下载（带超时）
          console.log('[Source Downloader] 下载文件:', file.url);
          content = await fetchWithTimeout(file.url, 10000); // 10秒超时
          filePath = extractFilePath(file.url, options?.keepStructure);
        }

        // 格式化代码
        if (options?.beautify && (file.type === 'javascript' || file.originalType === 'javascript')) {
          content = simpleBeautify(content);
        }

        // 确定文件夹
        let folder = folders.other;
        const fileType = file.originalType || file.type;
        if (fileType === 'javascript' || fileType === 'js') folder = folders.js;
        else if (fileType === 'css') folder = folders.css;
        else if (fileType === 'vue') folder = folders.vue;

        // 确保 filePath 有效
        if (!filePath || filePath === '' || filePath === '/') {
          filePath = `file_${i}.${fileType === 'javascript' ? 'js' : fileType === 'css' ? 'css' : 'txt'}`;
        }

        // 防止路径包含 .. 导致安全问题
        filePath = filePath.replace(/\.\.\/|\.\.\\/g, '');

        console.log('[Source Downloader] 添加到 ZIP:', filePath);

        // 添加文件到 ZIP
        folder.file(filePath, content);
        successCount++;

      } catch (error) {
        console.error('[Source Downloader] 处理文件失败:', file.url || file.name, error);
        failCount++;
        // 继续处理下一个文件，不中断
      }
    }

    console.log(`[Source Downloader] 处理完成: 成功 ${successCount}, 失败 ${failCount}`);

    if (successCount === 0) {
      throw new Error('没有成功下载任何文件，请检查网络连接或选择的资源');
    }

    // 生成 ZIP 文件
    console.log('[Source Downloader] 生成 ZIP...');
    const zipBase64 = await zip.generateAsync({
      type: 'base64',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    console.log('[Source Downloader] ZIP 生成完成，大小:', Math.round(zipBase64.length * 0.75 / 1024), 'KB');
    return zipBase64;
  }

  // 带超时的 fetch
  async function fetchWithTimeout(url, timeout) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error('下载超时');
      }
      throw error;
    }
  }

  function extractFilePath(url, keepStructure) {
    try {
      const urlObj = new URL(url, location.href);
      let path = urlObj.pathname;

      if (path.startsWith('/')) {
        path = path.slice(1);
      }

      if (!path || path === '') {
        return 'index.js';
      }

      if (!keepStructure) {
        const parts = path.split('/');
        return parts[parts.length - 1] || 'index.js';
      }

      return path;
    } catch {
      const parts = url.split('/');
      return parts[parts.length - 1] || 'unknown';
    }
  }

  function simpleBeautify(code) {
    const lines = code.split('\n');
    let indent = 0;
    const result = [];

    for (let line of lines) {
      line = line.trim();
      if (!line) continue;

      if (/^[})\]]/.test(line)) {
        indent = Math.max(0, indent - 1);
      }

      result.push('  '.repeat(indent) + line);

      if (/[{([\]]$/.test(line)) {
        indent++;
      }
    }

    return result.join('\n');
  }

  console.log('[前端源码采集器] Content Script 已加载');
})();
