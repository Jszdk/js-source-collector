// 前端源码采集器 - Popup 脚本
// 负责用户交互、资源展示、下载触发

(function() {
  'use strict';

  // DOM 元素
  const elements = {
    scanBtn: document.getElementById('scanBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    statusIcon: document.getElementById('statusIcon'),
    statusText: document.getElementById('statusText'),
    statsGrid: document.getElementById('statsGrid'),
    optionsPanel: document.getElementById('optionsPanel'),
    resourceList: document.getElementById('resourceList'),
    listBody: document.getElementById('listBody'),
    selectAll: document.getElementById('selectAll'),
    selectedCount: document.getElementById('selectedCount'),
    totalCount: document.getElementById('totalCount'),
    loadingPanel: document.getElementById('loadingPanel'),
    loadingText: document.getElementById('loadingText'),
    emptyState: document.getElementById('emptyState'),
    progressPanel: document.getElementById('progressPanel'),
    progressFill: document.getElementById('progressFill'),
    progressText: document.getElementById('progressText'),
    actionButtons: document.getElementById('actionButtons'),
    jsCount: document.getElementById('jsCount'),
    cssCount: document.getElementById('cssCount'),
    vueCount: document.getElementById('vueCount'),
    mapCount: document.getElementById('mapCount')
  };

  // 状态数据
  let currentResources = {
    javascript: [],
    css: [],
    vueComponents: [],
    sourceMap: []
  };
  let selectedResources = new Set();
  let currentFilter = 'all';

  // ============ 初始化 ============

  function init() {
    bindEvents();
    loadSavedState();
  }

  function bindEvents() {
    elements.scanBtn.addEventListener('click', startScan);
    elements.refreshBtn.addEventListener('click', startScan);
    elements.downloadBtn.addEventListener('click', startDownload);
    elements.selectAll.addEventListener('change', toggleSelectAll);

    // 分类卡片点击
    document.querySelectorAll('.stat-card').forEach(card => {
      card.addEventListener('click', () => filterByType(card.dataset.type));
    });
  }

  async function loadSavedState() {
    const result = await chrome.storage.local.get('lastScan');
    if (result.lastScan) {
      // 可以恢复上次的扫描结果
    }
  }

  // ============ 扫描功能 ============

  async function startScan() {
    try {
      setScanningState(true);

      // 获取当前标签页
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) {
        throw new Error('无法获取当前页面');
      }

      elements.loadingText.textContent = '正在扫描页面资源...';

      // 发送扫描请求到 content script
      const response = await sendMessageToTab(tab.id, { action: 'scanResources' });

      if (response && response.success) {
        currentResources = response.resources;
        updateUI(response);
        showResults();

        // 保存扫描结果
        await chrome.storage.local.set({ lastScan: response });
      } else {
        throw new Error(response?.error || '扫描失败');
      }
    } catch (error) {
      console.error('扫描失败:', error);
      showError(error.message);
    } finally {
      setScanningState(false);
    }
  }

  function sendMessageToTab(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ error: chrome.runtime.lastError.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  // ============ UI 更新 ============

  function updateUI(response) {
    const { summary } = response;

    // 更新统计数字
    elements.jsCount.textContent = summary.javascript;
    elements.cssCount.textContent = summary.css;

    // Vue 组件数量（包括 source map 中的和 devtools 检测的）
    const vueCount = summary.vueComponents +
      (currentResources.sourceMap?.filter(sm => sm.data?.hasVueFiles).length || 0);
    elements.vueCount.textContent = vueCount;

    elements.mapCount.textContent = summary.sourceMap;

    // 更新状态
    const total = summary.javascript + summary.css + summary.vueComponents;
    elements.statusText.textContent = `发现 ${total} 个资源`;
    elements.statusIcon.textContent = '✅';
    elements.statusIcon.className = 'status-icon ready';

    // 渲染资源列表
    renderResourceList();
  }

  function renderResourceList() {
    elements.listBody.innerHTML = '';
    selectedResources.clear();

    const allResources = [];

    // 收集 JS 文件
    currentResources.javascript.forEach(item => {
      allResources.push({
        url: item.url,
        name: extractFileName(item.url),
        type: 'js',
        icon: '📜',
        typeLabel: 'JS'
      });
    });

    // 收集 CSS 文件
    currentResources.css.forEach(item => {
      allResources.push({
        url: item.url,
        name: extractFileName(item.url),
        type: 'css',
        icon: '🎨',
        typeLabel: 'CSS'
      });
    });

    // 收集 Vue 组件
    currentResources.vueComponents.forEach(item => {
      allResources.push({
        url: item.path || item.name,
        name: item.name,
        type: 'vue',
        icon: '💚',
        typeLabel: 'Vue',
        badge: item.source === 'sourcemap' ? 'sourcemap' :
               item.source === 'devtools' ? 'devtools' : null,
        content: item.content // sourcemap 中的内容
      });
    });

    // 收集 Source Map 中的文件
    currentResources.sourceMap.forEach(sm => {
      if (sm.data && sm.data.files) {
        sm.data.files.forEach(file => {
          if (!allResources.some(r => r.url === file.path)) {
            allResources.push({
              url: file.path,
              name: file.path.split('/').pop(),
              type: 'vue',
              icon: '💚',
              typeLabel: 'Vue',
              badge: 'sourcemap',
              content: file.content,
              isFromSourceMap: true
            });
          }
        });
      }
    });

    // 渲染列表
    allResources.forEach(resource => {
      const item = createResourceItem(resource);
      elements.listBody.appendChild(item);
    });

    elements.totalCount.textContent = allResources.length;
    updateSelectedCount();
  }

  function createResourceItem(resource) {
    const div = document.createElement('div');
    div.className = 'resource-item';
    div.dataset.url = resource.url;
    div.dataset.type = resource.type;

    if (resource.content) {
      div.dataset.content = 'true';
    }

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = resource.type !== 'css'; // 默认不选 CSS
    checkbox.addEventListener('change', () => {
      toggleResourceSelection(resource, checkbox.checked);
    });

    const icon = document.createElement('div');
    icon.className = `resource-icon ${resource.type}`;
    icon.textContent = resource.icon;

    const info = document.createElement('div');
    info.className = 'resource-info';

    const name = document.createElement('div');
    name.className = 'resource-name';
    name.textContent = resource.name;
    name.title = resource.name;

    const url = document.createElement('div');
    url.className = 'resource-url';
    url.textContent = resource.url;
    url.title = resource.url;

    info.appendChild(name);
    info.appendChild(url);

    div.appendChild(checkbox);
    div.appendChild(icon);
    div.appendChild(info);

    if (resource.badge) {
      const badge = document.createElement('span');
      badge.className = `resource-badge ${resource.badge}`;
      badge.textContent = resource.badge === 'sourcemap' ? 'Map' : 'Dev';
      div.appendChild(badge);
    }

    // 点击整行切换选择
    div.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
        toggleResourceSelection(resource, checkbox.checked);
      }
    });

    if (checkbox.checked) {
      selectedResources.add(resource.url);
    }

    return div;
  }

  function extractFileName(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const parts = pathname.split('/');
      return parts[parts.length - 1] || url;
    } catch {
      return url;
    }
  }

  // ============ 选择功能 ============

  function toggleResourceSelection(resource, selected) {
    if (selected) {
      selectedResources.add(resource.url);
    } else {
      selectedResources.delete(resource.url);
    }
    updateSelectedCount();
    updateSelectAllState();
    updateDownloadButton();
  }

  function toggleSelectAll() {
    const checked = elements.selectAll.checked;
    const checkboxes = elements.listBody.querySelectorAll('input[type="checkbox"]');

    checkboxes.forEach((cb, index) => {
      cb.checked = checked;
      const item = cb.closest('.resource-item');
      const url = item.dataset.url;

      if (checked) {
        selectedResources.add(url);
      } else {
        selectedResources.delete(url);
      }
    });

    updateSelectedCount();
    updateDownloadButton();
  }

  function updateSelectedCount() {
    elements.selectedCount.textContent = selectedResources.size;
  }

  function updateSelectAllState() {
    const total = elements.listBody.querySelectorAll('.resource-item').length;
    elements.selectAll.checked = selectedResources.size === total && total > 0;
    elements.selectAll.indeterminate =
      selectedResources.size > 0 && selectedResources.size < total;
  }

  function updateDownloadButton() {
    elements.downloadBtn.disabled = selectedResources.size === 0;
    elements.downloadBtn.innerHTML =
      `<span>📥</span> 下载 ${selectedResources.size} 个文件`;
  }

  // ============ 过滤功能 ============

  function filterByType(type) {
    currentFilter = currentFilter === type ? 'all' : type;

    // 更新卡片样式
    document.querySelectorAll('.stat-card').forEach(card => {
      card.classList.toggle('active', card.dataset.type === currentFilter);
    });

    // 过滤列表
    const items = elements.listBody.querySelectorAll('.resource-item');
    items.forEach(item => {
      const match = currentFilter === 'all' ||
        (currentFilter === 'javascript' && item.dataset.type === 'js') ||
        (currentFilter === 'vue' && item.dataset.type === 'vue') ||
        item.dataset.type === currentFilter;
      item.style.display = match ? '' : 'none';
    });

    // 更新全选状态
    const visibleItems = Array.from(items).filter(i => i.style.display !== 'none');
    const visibleChecked = visibleItems.filter(i =>
      selectedResources.has(i.dataset.url)
    ).length;
    elements.selectAll.checked = visibleChecked === visibleItems.length && visibleItems.length > 0;
  }

  // ============ 下载功能 ============

  async function startDownload() {
    if (selectedResources.size === 0) return;

    try {
      elements.progressPanel.classList.remove('hidden');
      elements.actionButtons.classList.add('hidden');
      elements.statusText.textContent = '正在打包文件...';

      const urls = Array.from(selectedResources);
      const options = {
        parseSourceMap: document.getElementById('optionSourceMap').checked,
        beautify: document.getElementById('optionBeautify').checked,
        keepStructure: document.getElementById('optionKeepStructure').checked
      };

      // 发送消息给 background 进行下载
      chrome.runtime.sendMessage({
        action: 'downloadAsZip',
        urls: urls,
        resources: currentResources,
        options: options,
        tabTitle: (await chrome.tabs.query({ active: true, currentWindow: true }))[0].title
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('下载错误:', chrome.runtime.lastError);
          elements.progressPanel.classList.add('hidden');
          elements.actionButtons.classList.remove('hidden');
          showError(chrome.runtime.lastError.message);
          return;
        }

        if (response && response.success) {
          elements.progressFill.style.width = '100%';
          elements.progressText.textContent = '下载完成！';
          elements.statusText.textContent = '下载成功';
          elements.statusIcon.textContent = '✅';

          setTimeout(() => {
            elements.progressPanel.classList.add('hidden');
            elements.actionButtons.classList.remove('hidden');
          }, 1500);
        } else {
          elements.progressPanel.classList.add('hidden');
          elements.actionButtons.classList.remove('hidden');
          showError(response?.error || '下载失败，请查看控制台日志');
        }
      });

    } catch (error) {
      console.error('下载失败:', error);
      showError(error.message);
      elements.progressPanel.classList.add('hidden');
      elements.actionButtons.classList.remove('hidden');
    }
  }

  // 更新下载进度
  function updateProgress(current, total, filename) {
    const percent = Math.round((current / total) * 100);
    elements.progressFill.style.width = `${percent}%`;
    elements.progressText.textContent =
      `正在下载 (${current}/${total}): ${filename}`;
  }

  // ============ 状态管理 ============

  function setScanningState(scanning) {
    elements.scanBtn.disabled = scanning;

    if (scanning) {
      elements.loadingPanel.classList.remove('hidden');
      elements.emptyState.classList.add('hidden');
      elements.resourceList.classList.add('hidden');
      elements.statsGrid.classList.add('hidden');
      elements.optionsPanel.classList.add('hidden');
      elements.actionButtons.classList.add('hidden');
      elements.statusIcon.className = 'status-icon scanning';
      elements.statusIcon.textContent = '🔍';
      elements.statusText.textContent = '正在扫描...';
    } else {
      elements.loadingPanel.classList.add('hidden');
    }
  }

  function showResults() {
    elements.emptyState.classList.add('hidden');
    elements.statsGrid.classList.remove('hidden');
    elements.optionsPanel.classList.remove('hidden');
    elements.resourceList.classList.remove('hidden');
    elements.actionButtons.classList.remove('hidden');

    updateDownloadButton();
    updateSelectAllState();
  }

  function showError(message) {
    elements.statusText.textContent = `错误: ${message}`;
    elements.statusIcon.textContent = '❌';
    elements.statusIcon.className = 'status-icon empty';
  }

  // ============ 启动 ============

  init();
})();
