# TagSidebar Chrome 扩展说明

本文档旨在帮助你快速了解 TagSidebar 项目的整体设计与实现，并提供从零开发 Chrome 扩展的完整流程指引。内容主要分为两部分：Chrome 扩展制作流程与 TagSidebar 的功能说明。

## 一、Chrome 扩展（Manifest V3）制作流程

### 1. 准备阶段

1. **了解 Manifest 版本**：自 2023 年起，Chrome 推广 Manifest V3（简称 MV3）。与 MV2 相比，MV3 引入 Service Worker 替代持久化的后台页面，权限模型也更为严格。
2. **规划目录结构**：常见结构如下：
   ```
   my-extension/
   ├── manifest.json        # 配置文件（必需）
   ├── background.js        # 后台脚本（可选）
   ├── sidepanel.html/.js   # 侧边栏或页面 UI（可选）
   ├── icons/               # 图标资源
   └── README.md            # 文档
   ```
3. **准备素材**：包含图标（通常 16、32、48、128 像素）、文案、UI 草图等。

### 2. 编写 `manifest.json`

Manifest 是扩展的入口说明文件，重点字段如下：

- `manifest_version`: 必须为 `3`。
- `name`、`version`、`description`: 扩展元信息。
- `action`: 定义工具栏按钮的行为与图标。
- `background`: 指定后台 Service Worker。
- `permissions` 与 `host_permissions`: 描述所需的 API 权限（如 `tabs`、`storage`、`sidePanel` 等）。
- `side_panel`: 指定侧边栏入口页面（如 `TagSidebar.html`）。

完成 manifest 后，可使用 `chrome://extensions` 的「加载已解压的扩展程序」进行开发调试。

### 3. 实现核心脚本

1. **后台脚本（`background.js`）**：
   - 在 MV3 下以 Service Worker 运行。
   - 适用于初始化配置、监听浏览器事件、统一处理权限操作。
2. **页面脚本（例如 Side Panel、Popup 或 Options 页面）**：
   - HTML + JavaScript + CSS 构成扩展的可视化界面。
   - 通过 Chrome 提供的 API（`chrome.tabs`、`chrome.windows` 等）与浏览器交互。

### 4. 调试与测试

1. **加载扩展**：浏览器地址栏输入 `chrome://extensions/`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择项目文件夹。
2. **查看日志**：
   - Side Panel / Popup 内的日志：使用开发者工具 Console。
   - Service Worker 日志：在 `chrome://extensions/` 中点击「Service Worker」链接查看。
3. **常见调试技巧**：
   - 使用 `chrome.storage` 持久化配置，便于跨会话测试。
   - 封装事件监听与清理逻辑，避免重复注册导致的意外行为。

### 5. 发布流程（简述）

1. 注册 Chrome Web Store 开发者账号。
2. 使用 `chrome://extensions/` 的「打包扩展程序」生成 `.crx` 与 `.pem`，或直接上传压缩包到开发者后台。
3. 填写商店信息、截图与隐私合规说明，提交审核。

## 二、TagSidebar 插件功能详解

TagSidebar 是一个基于 Chrome Side Panel 的标签页管理扩展，目标是提供更高效的标签页浏览、批量操作与全局缩放控制。以下内容结合 `TagSidebar.js` 与 `background.js` 中的核心实现，按模块说明其主要能力。

### 1. 基础布局

- **工具栏（顶部）**：对应 `TagSidebar.js` 中的 DOM 解构（`toggle-fullscreen-btn`、`set-zoom-btn`）。

  ```javascript
  const [toggleFullscreenBtn, setZoomBtn, tabsContainer, contextMenu, toast] = [
    document.getElementById("toggle-fullscreen-btn"),
    document.getElementById("set-zoom-btn"),
    document.getElementById("tabs-container"),
    document.getElementById("custom-context-menu"),
    document.getElementById("toast-notice"),
  ];

  if (toggleFullscreenBtn) {
    addListener(toggleFullscreenBtn, "click", async () => {
      const currentWindow = await chrome.windows.getCurrent();
      const nextState =
        currentWindow.state === "fullscreen" ? "maximized" : "fullscreen";
      chrome.windows.update(currentWindow.id, { state: nextState });
    });
  }
  ```

  - 「切换全屏」：使用 `chrome.windows.update` 在全屏与最大化之间切换。
  - 「设置全局缩放」：`setZoomBtn` 触发 `promptAndApplyZoom` 并在成功后调用 `applyZoomToAllTabs`。

- **标签列表区域**：`loadTabs()` 查询当前窗口所有标签并用 `renderTab` 生成 HTML，包括 favicon/首字母、标题、复制、刷新、关闭按钮等。

  ```javascript
  async function loadTabs() {
    const { id: windowId } = await chrome.windows.getCurrent({
      populate: false,
    });
    cachedTabs = await chrome.tabs.query({ windowId });

    const markup = cachedTabs.length
      ? cachedTabs.map(renderTab).join("")
      : '<p class="empty-state">当前没有打开的标签页</p>';

    tabsContainer.innerHTML = `${markup}${renderNewTabRow()}`;
  }

  function renderTab(tab) {
    const title = describeTab(tab);
    const escapedTitle = escapeHtml(title);
    const isReloading = reloadingTabIds.has(tab.id);
    const reloadAttrs = isReloading ? ' disabled aria-busy="true"' : "";

    return `
        <div class="tab-item${
          tab.active ? " tab-item--active" : ""
        }" data-tab-id="${tab.id}" draggable="true">
           <div class="tab-icon${
             isReloading ? " tab-icon--loading" : ""
           }">${renderTabIcon(tab)}</div>
           <span class="tab-title${
             tab.mutedInfo?.muted ? " tab-title--muted" : ""
           }" title="${escapedTitle}">${escapedTitle}</span>
           <button class="tab-action-btn copy-tab-btn" type="button" title="复制地址">⧉</button>
           <button class="tab-action-btn reload-tab-btn"${reloadAttrs} type="button" title="刷新">↻</button>
           <button class="tab-action-btn close-tab-btn" type="button" title="关闭标签">&times;</button>
        </div>
     `;
  }
  ```

- **上下文菜单**：`handleTabContextMenu` 构建菜单项，`showContextMenu` 使用 `contextMenu.replaceChildren` 挂载按钮并绑定事件。

  ```javascript
  async function handleTabContextMenu(event) {
    const context = getTabContext(event);
    if (!context) return;

    event.preventDefault();
    hideContextMenu(true);

    const tab =
      findTab(context.id) ||
      (await chrome.tabs.get(context.id).catch(() => null));
    if (!tab) return;

    const tabsInWindow = cachedTabs.filter(
      (item) => item.windowId === tab.windowId
    );
    const menuItems = buildContextMenuItems(tab, tabsInWindow);
    if (!menuItems.length) return;

    showContextMenu(menuItems, { x: event.clientX, y: event.clientY });
  }

  function showContextMenu(items, position) {
    contextMenu.replaceChildren(...items.map(createMenuElement));
    contextMenu.style.display = "block";
    contextMenu.setAttribute("aria-hidden", "false");
    positionContextMenu(position.x, position.y);
  }
  ```

- **底部新建按钮**：`renderNewTabRow` 生成「新建标签页」按钮，点击后由 `createTabInCurrentWindow` 调用 `chrome.tabs.create`。

  ```javascript
  function renderNewTabRow() {
    return `
        <button class="new-tab-btn" type="button">
           <span class="new-tab-btn__icon">＋</span>
           <span>新建标签页</span>
        </button>
     `;
  }

  async function createTabInCurrentWindow() {
    const { id: windowId } = await chrome.windows.getCurrent({
      populate: false,
    });
    await chrome.tabs.create({ windowId });
  }
  ```

### 2. 标签项交互

- **单击激活**：`handleTabClick` 在无工具按钮命中时执行 `chrome.tabs.update(context.id, { active: true })` 并聚焦窗口。

  ```javascript
  async function handleTabClick(event) {
    const context = getTabContext(event);
    if (!context) return;

    const actionButton = event.target.closest(".tab-action-btn");
    const classList = actionButton?.classList;

    if (!classList) {
      const fallbackActive =
        currentActiveTabId ?? getActiveCachedTab()?.id ?? null;
      if (fallbackActive !== null && fallbackActive !== context.id) {
        lastActiveTabIdBeforeClick = fallbackActive;
      }

      await chrome.tabs.update(context.id, { active: true });
      const tab = await chrome.tabs.get(context.id);
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }

    // 复制/刷新/关闭分支
  }
  ```

- **双击关闭并恢复焦点**：

  ```javascript
  async function handleTabDoubleClick(event) {
    const context = getTabContext(event);
    if (!context) return;

    event.preventDefault();
    await chrome.tabs.remove(context.id);

    const restoreTabId =
      lastActiveTabIdBeforeClick && lastActiveTabIdBeforeClick !== context.id
        ? lastActiveTabIdBeforeClick
        : null;
    lastActiveTabIdBeforeClick = null;

    if (restoreTabId) {
      const tabToRestore = await chrome.tabs
        .get(restoreTabId)
        .catch(() => null);
      if (tabToRestore) {
        await chrome.tabs.update(restoreTabId, { active: true });
        await chrome.windows.update(tabToRestore.windowId, { focused: true });
      }
    }
  }
  ```

- **复制按钮**：

  ```javascript
  async function copyTabUrl(tabId) {
    const tab =
      findTab(tabId) || (await chrome.tabs.get(tabId).catch(() => null));
    const urlToCopy = tab?.url || tab?.pendingUrl;
    if (!urlToCopy) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(urlToCopy);
        showToast("链接已复制");
        return;
      }
    } catch (error) {
      console.warn("navigator.clipboard 失败", error);
    }

    const textarea = document.createElement("textarea");
    textarea.value = urlToCopy;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
    showToast("链接已复制");
  }
  ```

- **刷新按钮**：
  ```javascript
  if (classList?.contains("reload-tab-btn")) {
    setTabLoadingState(context.id, true);
    try {
      await chrome.tabs.reload(context.id);
    } catch (error) {
      console.error("刷新标签页失败", error);
      setTabLoadingState(context.id, false);
    }
    return;
  }
  ```
- **关闭按钮**：`await chrome.tabs.remove(context.id);`
- **拖拽排序**：

  ```javascript
  async function handleTabDrop(event) {
    if (!Number.isFinite(draggedTabId)) return;
    event.preventDefault();

    const sourceTab = findTab(draggedTabId);
    const targetElement = event.target.closest(".tab-item");
    let targetIndex = cachedTabs.length;

    if (targetElement) {
      const targetId = Number(targetElement.dataset.tabId);
      if (Number.isFinite(targetId)) {
        const targetTab = findTab(targetId);
        if (targetTab) {
          const rect = targetElement.getBoundingClientRect();
          const before = event.clientY < rect.top + rect.height / 2;
          targetIndex = before ? targetTab.index : targetTab.index + 1;
        }
      }
    }

    if (targetIndex > sourceTab.index) targetIndex -= 1;
    await chrome.tabs.move(draggedTabId, { index: targetIndex });
    await loadTabs();
    resetDragState();
  }
  ```

### 3. 上下文菜单（右键）

菜单选项根据标签状态动态生成，涵盖：

- 新建标签页 / 在当前下方新建：调用 `chrome.tabs.create`，可指定插入位置。
- 重新加载、复制标签页：分别映射到 `chrome.tabs.reload` 与 `chrome.tabs.duplicate`。
- 固定 / 取消固定：`chrome.tabs.update(tab.id, { pinned: !tab.pinned })`。
- 静音 / 取消静音当前站点：使用 `chrome.tabs.update` 修改 `mutedInfo`。
- 移动到新窗口：`chrome.windows.create({ tabId: tab.id })`。
- 关闭当前标签、关闭其他标签、关闭上下方标签：调用 `chrome.tabs.remove` 批量关闭非固定标签。

### 4. 全局缩放管理

- 使用 `chrome.storage.sync`（回退 `chrome.storage.local`）存储目标缩放百分比，键名为 `globalZoomPercent`。
- `applyZoomToAllTabs` 遍历标签，调用 `chrome.tabs.setZoomSettings` 与 `chrome.tabs.setZoom`，并统计成功/跳过/失败列表。
- `isRestrictedUrl` 用于跳过 `chrome://`、`edge://` 等不支持缩放的协议。
- `chrome.tabs.onCreated`、`onUpdated`、`chrome.windows.onCreated` 等监听器在标签新建或加载完成时调用 `applyZoomToTab`，确保缩放保持一致。

### 5. 状态同步与事件监听

- `chrome.tabs` 与 `chrome.windows` 多个事件（`onCreated`、`onRemoved`、`onMoved`、`onActivated` 等）统一指向 `loadTabs`、`handleTabRemoved` 等函数，保持 UI 与真实状态同步。

  ```javascript
  [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onUpdated,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
    chrome.tabs.onReplaced,
    chrome.tabs.onActivated,
  ].forEach((eventTarget) => addChromeListener(eventTarget, loadTabs));

  addChromeListener(chrome.tabs.onRemoved, handleTabRemoved);
  addChromeListener(chrome.tabs.onUpdated, handleTabStatusChange);
  ```

- 所有 DOM/Chrome 事件通过 `addListener` 与 `addChromeListener` 注册到 `cleanupTasks`，在 `dispose` 中统一清理，避免重复绑定。
- `cachedTabs` 保存当前窗口标签信息，`findTab`、`getActiveCachedTab` 等辅助函数减少查询重复计算。

### 6. 代码结构亮点

- **模块化辅助函数**：`findTab`、`getActiveCachedTab`、`isRestrictedUrl`、`showToast`、`setDragOverElement` 等集中处理通用逻辑。

  ```javascript
  const findTab = (id) => cachedTabs.find((tab) => tab.id === id);
  const getActiveCachedTab = () => cachedTabs.find((tab) => tab.active);
  const isRestrictedUrl = (url) =>
    !url || restrictedProtocols.has(getUrlProtocol(url));

  const setDragOverElement = (element) => {
    if (dragOverElement === element) return;
    dragOverElement?.classList.remove("tab-item--drag-over");
    dragOverElement = element;
    dragOverElement?.classList.add("tab-item--drag-over");
  };

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("toast--visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("toast--visible");
      toastTimer = null;
    }, 1600);
  }
  ```

- **响应式 UI 提示**：`.tab-icon--loading`、`.copy-tab-btn--copied`、`.toast--visible`、`.tab-item--drag-over` 等样式结合状态类呈现动画反馈。
- **鲁棒性考虑**：所有 Chrome API 调用包裹在 `try/catch` 内，并通过 `console.error`/`console.warn` 输出，保持 Side Panel 稳定运行。

### 7. 进一步扩展的可能性

- 增加标签搜索、分组、批量固定等高级功能。
- 与 `chrome.sessions` API 集成，实现标签会话管理。
- 提供主题切换、国际化文案配置等个性化选项。
