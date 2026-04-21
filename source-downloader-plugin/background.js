// 前端源码采集器 - Background Service Worker
// 负责 ZIP 打包、文件下载、Source Map 解析

// 导入 JSZip（需要正确配置在 manifest 中或通过 importScripts）
// 由于 Service Worker 限制，我们需要在 Service Worker 中使用 importScripts
// 但 Manifest V3 的 Service Worker 不能直接操作 DOM，需要使用 offscreen document
// 这里我们采用简化方案：通过 content script 使用 JSZip，然后传递数据回来

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadAsZip') {
    handleDownloadZip(request, sender).then(sendResponse).catch(error => {
      sendResponse({ success: false, error: error.message });
    });
    return true; // 异步响应
  }
});

/**
 * 处理 ZIP 下载请求
 */
async function handleDownloadZip(request, sender) {
  const { urls, resources, options, tabTitle } = request;

  try {
    // 获取当前活动标签页（因为从 popup 发送的消息 sender.tab 为 undefined）
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab) {
      throw new Error('无法获取当前活动标签页');
    }

    // 构建要下载的文件列表
    const filesToDownload = [];

    for (const url of urls) {
      const resource = findResource(url, resources);
      if (resource) {
        filesToDownload.push(resource);
      }
    }

    // 发送消息给 content script，让它使用 JSZip 打包
    const zipBlob = await createZipInContentScript(activeTab.id, filesToDownload, options);

    if (!zipBlob) {
      throw new Error('创建 ZIP 文件失败');
    }

    // 生成文件名
    const domain = new URL(activeTab.url).hostname;
    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `source_${domain}_${timestamp}.zip`;

    // 转换为 base64 以便下载
    const base64Data = await blobToBase64(zipBlob);

    // 触发下载
    await chrome.downloads.download({
      url: base64Data,
      filename: filename,
      saveAs: true
    });

    return { success: true, filename };

  } catch (error) {
    console.error('[Source Downloader] 下载失败:', error);
    return { success: false, error: error.message };
  }
}

/**
 * 在 Content Script 中创建 ZIP 文件
 */
async function createZipInContentScript(tabId, files, options) {
  return new Promise((resolve, reject) => {
    // 增加超时时间到 5 分钟，因为下载多个文件可能需要较长时间
    const timeout = setTimeout(() => {
      reject(new Error('创建 ZIP 超时（5分钟），可能是网络速度慢或文件太多'));
    }, 300000);

    chrome.tabs.sendMessage(tabId, {
      action: 'createZip',
      files: files,
      options: options
    }, (response) => {
      clearTimeout(timeout);

      if (chrome.runtime.lastError) {
        reject(new Error('Content Script 错误: ' + chrome.runtime.lastError.message));
      } else if (response && response.success) {
        // response.data 是 base64 编码的 ZIP 数据
        const byteString = atob(response.data);
        const byteArray = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
          byteArray[i] = byteString.charCodeAt(i);
        }
        resolve(new Blob([byteArray], { type: 'application/zip' }));
      } else {
        reject(new Error(response?.error || '创建 ZIP 失败'));
      }
    });
  });
}

/**
 * 查找资源详情
 */
function findResource(url, resources) {
  // 在各类资源中查找
  for (const type of ['javascript', 'css']) {
    const found = resources[type]?.find(r => r.url === url);
    if (found) return { ...found, originalType: type };
  }

  // 在 Vue 组件中查找
  const vueComp = resources.vueComponents?.find(
    r => r.path === url || r.name === url
  );
  if (vueComp) return { ...vueComp, originalType: 'vue', hasContent: true };

  // 在 Source Map 文件中查找
  for (const sm of resources.sourceMap || []) {
    if (sm.data?.files) {
      const file = sm.data.files.find(f => f.path === url);
      if (file) return {
        url: url,
        name: file.path.split('/').pop(),
        path: file.path,
        content: file.content,
        originalType: 'vue',
        hasContent: true,
        fromSourceMap: true
      };
    }
  }

  // 如果没找到，返回基础信息
  return {
    url: url,
    name: url.split('/').pop() || 'unknown',
    originalType: 'unknown'
  };
}

/**
 * Blob 转 Base64
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ============ Content Script ZIP 创建 ============
// 这段代码会注入到 content.js 中处理 createZip 消息

const contentScriptZipHandler = `
// ZIP 创建处理器
if (typeof JSZip !== 'undefined') {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'createZip') {
      createZipPackage(request.files, request.options)
        .then(zipData => {
          sendResponse({ success: true, data: zipData });
        })
        .catch(error => {
          sendResponse({ success: false, error: error.message });
        });
      return true;
    }
  });
}

async function createZipPackage(files, options) {
  const zip = new JSZip();

  // 按类型组织文件夹
  const folders = {
    js: zip.folder('javascript'),
    css: zip.folder('css'),
    vue: zip.folder('components'),
    sourcemap: zip.folder('sourcemaps'),
    other: zip.folder('other')
  };

  for (const file of files) {
    try {
      let content;
      let filePath;

      // 如果已经有内容（来自 source map）
      if (file.hasContent && file.content) {
        content = file.content;
        filePath = file.path || file.name;
      } else {
        // 否则从网络下载
        const response = await fetch(file.url);
        if (!response.ok) continue;
        content = await response.text();
        filePath = extractFilePath(file.url, options.keepStructure);
      }

      // 格式化代码（简化版，仅做基本的缩进处理）
      if (options.beautify && file.originalType === 'javascript') {
        content = simpleBeautify(content);
      }

      // 确定文件夹
      let folder = folders.other;
      if (file.originalType === 'javascript') folder = folders.js;
      else if (file.originalType === 'css') folder = folders.css;
      else if (file.originalType === 'vue') folder = folders.vue;

      // 添加文件到 ZIP
      folder.file(filePath, content);

    } catch (error) {
      console.error('[Source Downloader] 处理文件失败:', file.url, error);
    }
  }

  // 生成 ZIP 文件
  const zipBlob = await zip.generateAsync({
    type: 'base64',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  return zipBlob;
}

function extractFilePath(url, keepStructure) {
  try {
    const urlObj = new URL(url);
    let path = urlObj.pathname;

    // 移除开头的斜杠
    if (path.startsWith('/')) {
      path = path.slice(1);
    }

    // 如果没有路径，使用文件名
    if (!path || path === '') {
      path = urlObj.hostname + '.html';
    }

    // 如果不保持目录结构，只保留文件名
    if (!keepStructure) {
      const parts = path.split('/');
      path = parts[parts.length - 1] || 'index.html';
    }

    return path;
  } catch {
    const parts = url.split('/');
    return parts[parts.length - 1] || 'unknown';
  }
}

function simpleBeautify(code) {
  // 简单的格式化：统一缩进
  const lines = code.split('\\n');
  let indent = 0;
  const result = [];

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // 减少缩进（行首是闭合符号）
    if (/^[})\\]]/.test(line)) {
      indent = Math.max(0, indent - 1);
    }

    result.push('  '.repeat(indent) + line);

    // 增加缩进（行尾是开符号）
    if (/[{(\\[]$/.test(line) || /{$/.test(line)) {
      indent++;
    }
  }

  return result.join('\\n');
}
`;

console.log('[前端源码采集器] Background Service Worker 已加载');
