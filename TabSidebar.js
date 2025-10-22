// 侧边栏脚本入口：等到 DOM 完全构建后再执行，以确保节点可访问。
document.addEventListener("DOMContentLoaded", async () => {
  // 预先缓存常用的 DOM 元素，避免重复查询。
  const [toggleFullscreenBtn, setZoomBtn, tabsContainer, contextMenu, toast] = [
    document.getElementById("toggle-fullscreen-btn"),
    document.getElementById("set-zoom-btn"),
    document.getElementById("tabs-container"),
    document.getElementById("custom-context-menu"),
    document.getElementById("toast-notice"),
  ];

  if (!tabsContainer || !contextMenu) {
    // 如果关键元素不存在，直接退出，避免后续逻辑报错。
    console.warn("初始化侧边栏失败：缺少关键元素");
    return;
  }

  // escapeHtml：将动态文本转义为安全的 HTML，防止 XSS 或 DOM 结构破坏。
  const escapeHtml = (() => {
    const LOOKUP = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return (value = "") =>
      String(value).replace(/[&<>"']/g, (char) => LOOKUP[char] ?? char);
  })();

  // cleanupTasks：集中记录所有需要移除的监听器和资源，防止 Side Panel 关闭后泄漏。
  const cleanupTasks = [];

  // DOM 监听封装：注册时顺便把对应的移除操作加入 cleanupTasks。
  const addListener = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanupTasks.push(() => target.removeEventListener(type, handler, options));
  };
  // Chrome API 监听封装：与 addListener 一致，确保 Service Worker 卸载时释放。
  const addChromeListener = (eventTarget, handler) => {
    eventTarget.addListener(handler);
    cleanupTasks.push(() => eventTarget.removeListener(handler));
  };
  // dispose：在窗口关闭或脚本卸载时调用，清除所有 side panel 状态。
  const dispose = () => {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    while (cleanupTasks.length) {
      try {
        cleanupTasks.pop()?.();
      } catch (error) {
        console.error("清理监听器失败", error);
      }
    }
    hideContextMenu(true);
  };

  // 运行期状态：缓存标签列表、上下文菜单/缩放/拖拽等信息。
  let cachedTabs = [];
  let isContextMenuVisible = false;
  let contextMenuAnchor = null;
  let targetZoomPercent = null;
  const reloadingTabIds = new Set();
  let currentActiveTabId = null;
  let lastActiveTabIdBeforeClick = null;
  let draggedTabId = null;
  let dragOverElement = null;
  let toastTimer = null;

  addListener(window, "unload", dispose);

  // ------ 全局事件监听：用于隐藏菜单、响应键盘、维护聚焦状态 ------
  addListener(document, "click", (event) => {
    if (isContextMenuVisible && !contextMenu.contains(event.target)) {
      hideContextMenu();
    }
  });
  addListener(document, "keydown", (event) => {
    if (event.key === "Escape") hideContextMenu();
  });
  addListener(window, "blur", () => hideContextMenu());
  addListener(document, "contextmenu", (event) => {
    if (
      !event.target.closest(".tab-item") &&
      !contextMenu.contains(event.target)
    ) {
      hideContextMenu();
    }
  });
  addListener(contextMenu, "contextmenu", (event) => event.preventDefault());

  // 切换全屏按钮：在最大化与全屏之间来回切换，方便沉浸式浏览。
  if (toggleFullscreenBtn) {
    addListener(toggleFullscreenBtn, "click", async () => {
      const currentWindow = await chrome.windows.getCurrent();
      const nextState =
        currentWindow.state === "fullscreen" ? "maximized" : "fullscreen";
      chrome.windows.update(currentWindow.id, { state: nextState });
    });
  }

  // 缩放设置相关常量与工具：用于限制数值范围并过滤不支持的协议。
  const storageArea = chrome.storage?.sync ?? chrome.storage?.local;
  const ZOOM_STORAGE_KEY = "globalZoomPercent";
  const MIN_ZOOM_PERCENT = 10;
  const MAX_ZOOM_PERCENT = 500;
  const restrictedProtocols = new Set([
    "about:",
    "chrome:",
    "chrome-extension:",
    "edge:",
    "devtools:",
  ]);
  const clampZoom = (value) =>
    Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, value));
  const describeTab = (tab) =>
    tab?.title?.trim() || tab?.pendingUrl || tab?.url || "未命名标签页";
  const findTab = (id) => cachedTabs.find((tab) => tab.id === id);
  const getActiveCachedTab = () => cachedTabs.find((tab) => tab.active);
  const isRestrictedUrl = (url) =>
    !url || restrictedProtocols.has(getUrlProtocol(url));

  if (setZoomBtn) {
    addListener(setZoomBtn, "click", () => promptAndApplyZoom());
  }

  // 监听所有可能影响标签列表的事件，确保侧边栏状态实时同步。
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

  // 新建与更新的标签需要同步全局缩放，因此额外注册监听器。
  addChromeListener(chrome.tabs.onCreated, applyZoomToTab);
  addChromeListener(chrome.tabs.onUpdated, async (tabId, changeInfo, tab) => {
    if (
      Number.isFinite(targetZoomPercent) &&
      (changeInfo.status === "complete" || changeInfo.url)
    ) {
      const target = tab ?? (await chrome.tabs.get(tabId).catch(() => null));
      await applyZoomToTab(target);
    }
  });
  // 更新、移除事件同时驱动加载状态和缓存同步。
  addChromeListener(chrome.tabs.onUpdated, handleTabStatusChange);
  addChromeListener(chrome.tabs.onRemoved, handleTabRemoved);
  addChromeListener(chrome.windows.onCreated, async (window) => {
    if (!Number.isFinite(targetZoomPercent)) return;
    const tabs = await chrome.tabs.query({ windowId: window.id });
    await Promise.all(tabs.map(applyZoomToTab));
  });
  addChromeListener(chrome.tabs.onActivated, handleTabActivated);

  // 列表容器事件：转发右键菜单、点击、拖拽等交互。
  addListener(tabsContainer, "contextmenu", handleTabContextMenu);
  addListener(tabsContainer, "click", handleTabClick);
  addListener(tabsContainer, "dblclick", handleTabDoubleClick);
  addListener(tabsContainer, "dragstart", handleTabDragStart);
  addListener(tabsContainer, "dragover", handleTabDragOver);
  addListener(tabsContainer, "dragleave", handleTabDragLeave);
  addListener(tabsContainer, "drop", handleTabDrop);
  addListener(tabsContainer, "dragend", resetDragState);

  const passive = { passive: true };
  // 为了让自定义菜单在滚动/缩放时保持跟随，需要监听多个容器。
  const scrollTargets = [
    ...new Set([
      tabsContainer,
      document.scrollingElement,
      document.documentElement,
      document.body,
      window,
    ]),
  ].filter(Boolean);
  scrollTargets.forEach((target) => {
    addListener(target, "scroll", repositionContextMenuToAnchor, passive);
    addListener(target, "wheel", repositionContextMenuToAnchor, passive);
  });
  addListener(window, "resize", repositionContextMenuToAnchor);

  // 初始化顺序：读取缩放配置 -> 应用到所有标签 -> 渲染侧边栏。
  await loadTargetZoomFromStorage();
  await applyZoomToAllTabs();
  await loadTabs();

  // 根据事件源追溯到最近的 tab-item，返回其 DOM 与 tabId。
  function getTabContext(event) {
    const element = event.target.closest(".tab-item");
    if (!element) return null;
    const id = Number(element.dataset.tabId);
    return Number.isFinite(id) ? { element, id } : null;
  }

  // 查询当前窗口的全部标签，并刷新侧边栏列表
  async function loadTabs() {
    const { id: windowId } = await chrome.windows.getCurrent({
      populate: false,
    });
    cachedTabs = await chrome.tabs.query({ windowId });

    const existingTabIds = new Set(cachedTabs.map((tab) => tab.id));
    reloadingTabIds.forEach((id) => {
      if (!existingTabIds.has(id)) {
        reloadingTabIds.delete(id);
      }
    });

    if (isContextMenuVisible) hideContextMenu(true);

    if (currentActiveTabId === null) {
      const activeTab = getActiveCachedTab();
      if (activeTab) currentActiveTabId = activeTab.id;
    }

    const markup = cachedTabs.length
      ? cachedTabs.map(renderTab).join("")
      : '<p class="empty-state">当前没有打开的标签页</p>';

    tabsContainer.innerHTML = `${markup}${renderNewTabRow()}`;
  }

  // 生成单个标签节点的 HTML 片段，包含状态、图标与操作按钮。
  function renderTab(tab) {
    const title = describeTab(tab);
    const escapedTitle = escapeHtml(title);
    const icon = tab.favIconUrl
      ? `<img src="${escapeHtml(tab.favIconUrl)}" alt="${escapedTitle}" />`
      : escapeHtml((title[0] || "★").toUpperCase());
    const activeClass = tab.active ? " tab-item--active" : "";
    const mutedClass = tab.mutedInfo?.muted ? " tab-title--muted" : "";
    const isReloading = reloadingTabIds.has(tab.id);
    const iconClass = `tab-icon${isReloading ? " tab-icon--loading" : ""}`;
    const reloadAttrs = isReloading ? ' disabled aria-busy="true"' : "";

    return `
  <div class="tab-item${activeClass}" data-tab-id="${tab.id}" draggable="true">
        <div class="${iconClass}">${icon}</div>
        <span class="tab-title${mutedClass}" title="${escapedTitle}">${escapedTitle}</span>
        <button class="tab-action-btn copy-tab-btn" type="button" aria-label="复制标签页 ${escapedTitle} 的地址" title="复制地址">⧉</button>
        <button class="tab-action-btn reload-tab-btn"${reloadAttrs} type="button" aria-label="刷新标签页 ${escapedTitle}" title="刷新">↻</button>
        <button class="tab-action-btn close-tab-btn" type="button" aria-label="关闭标签页 ${escapedTitle}" title="关闭标签">&times;</button>
      </div>
    `;
  }

  // 渲染底部「新建标签页」按钮。
  function renderNewTabRow() {
    return `
      <button class="new-tab-btn" type="button">
        <span class="new-tab-btn__icon">＋</span>
        <span>新建标签页</span>
      </button>
    `;
  }

  // 根据加载状态更新图标动画与刷新按钮禁用样式。
  function setTabLoadingState(tabId, isLoading) {
    isLoading ? reloadingTabIds.add(tabId) : reloadingTabIds.delete(tabId);

    const tabElement = tabsContainer.querySelector(`[data-tab-id="${tabId}"]`);
    if (!tabElement) return;

    tabElement
      .querySelector(".tab-icon")
      ?.classList.toggle("tab-icon--loading", isLoading);

    const reloadButton = tabElement.querySelector(".reload-tab-btn");
    if (reloadButton) {
      reloadButton.disabled = isLoading;
      reloadButton.toggleAttribute("aria-busy", isLoading);
    }
  }

  // 自定义右键菜单入口：定位目标标签并根据其状态构造菜单。
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

    const rect = context.element.getBoundingClientRect();
    contextMenuAnchor = {
      element: context.element,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };

    showContextMenu(menuItems, { x: event.clientX, y: event.clientY });
  }

  // 刷新按钮的 loading 状态由 tabs.onUpdated 的 changeInfo 驱动。
  function handleTabStatusChange(tabId, changeInfo) {
    if (changeInfo.status === "loading") {
      setTabLoadingState(tabId, true);
    } else if (changeInfo.status === "complete") {
      setTabLoadingState(tabId, false);
    }
  }

  // 标签关闭时清理状态缓存，避免引用失效。
  function handleTabRemoved(tabId) {
    reloadingTabIds.delete(tabId);
    if (currentActiveTabId === tabId) currentActiveTabId = null;
    if (lastActiveTabIdBeforeClick === tabId) lastActiveTabIdBeforeClick = null;
  }

  // 主点击逻辑：区分按钮操作与激活标签行为。
  async function handleTabClick(event) {
    if (event.target.closest(".new-tab-btn")) {
      hideContextMenu();
      await createTabInCurrentWindow();
      return;
    }

    const context = getTabContext(event);
    if (!context) return;

    hideContextMenu();

    const actionButton = event.target.closest(".tab-action-btn");
    const classList = actionButton?.classList;

    if (event.detail === 1) {
      lastActiveTabIdBeforeClick = null;
    }

    if (classList?.contains("copy-tab-btn")) {
      event.preventDefault();
      event.stopPropagation();
      await copyTabUrl(context.id, actionButton);
      return;
    }

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

    if (classList?.contains("close-tab-btn")) {
      await chrome.tabs.remove(context.id);
      return;
    }

    const fallbackActiveTabId =
      currentActiveTabId ?? getActiveCachedTab()?.id ?? null;
    if (fallbackActiveTabId !== null && fallbackActiveTabId !== context.id) {
      lastActiveTabIdBeforeClick = fallbackActiveTabId;
    }

    await chrome.tabs.update(context.id, { active: true });
    const tab = await chrome.tabs.get(context.id);
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  // 双击关闭标签，并尽量恢复上一个活动标签以保持工作流。
  async function handleTabDoubleClick(event) {
    const context = getTabContext(event);
    if (!context) return;

    const actionButton = event.target.closest(".tab-action-btn");
    if (actionButton) return;

    event.preventDefault();
    hideContextMenu();

    try {
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
          await chrome.windows.update(tabToRestore.windowId, {
            focused: true,
          });
        }
      }
    } catch (error) {
      console.error("双击关闭标签页失败", error);
      lastActiveTabIdBeforeClick = null;
    }
  }

  // 开始拖拽时记录当前标签 ID，并设置拖拽效果。
  function handleTabDragStart(event) {
    const tabElement = event.target.closest(".tab-item");
    if (!tabElement) return;

    const tabId = Number(tabElement.dataset.tabId);
    if (!Number.isFinite(tabId)) return;

    draggedTabId = tabId;
    event.dataTransfer?.setData("text/plain", String(tabId));
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
    tabElement.classList.add("tab-item--dragging");
  }

  // 根据鼠标悬停的 tab 调整虚线高亮，辅助用户判断插入位置。
  const setDragOverElement = (element) => {
    if (dragOverElement === element) return;
    dragOverElement?.classList.remove("tab-item--drag-over");
    dragOverElement = element;
    dragOverElement?.classList.add("tab-item--drag-over");
  };

  // 拖拽经过时阻止默认行为，允许 drop 且更新视觉反馈。
  function handleTabDragOver(event) {
    if (!Number.isFinite(draggedTabId)) return;

    const tabElement = event.target.closest(".tab-item");
    if (!tabElement) {
      event.preventDefault();
      setDragOverElement(null);
      return;
    }

    const targetId = Number(tabElement.dataset.tabId);
    if (!Number.isFinite(targetId) || targetId === draggedTabId) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setDragOverElement(tabElement);
  }

  // 当拖拽元素离开列表或悬停到无效区域时清除高亮。
  function handleTabDragLeave(event) {
    const related = event.relatedTarget;
    if (!related || !tabsContainer.contains(related)) setDragOverElement(null);
  }

  // 计算拖拽释放的目标索引，并调用 chrome.tabs.move 调整顺序。
  async function handleTabDrop(event) {
    if (!Number.isFinite(draggedTabId)) return;
    event.preventDefault();

    const sourceTab = findTab(draggedTabId);
    if (!sourceTab) return resetDragState();

    const targetElement = event.target.closest(".tab-item");
    let targetIndex = cachedTabs.length;

    if (targetElement) {
      const targetId = Number(targetElement.dataset.tabId);
      if (targetId === draggedTabId) return resetDragState();

      if (Number.isFinite(targetId)) {
        const targetTab = findTab(targetId);
        if (targetTab) {
          const rect = targetElement.getBoundingClientRect();
          const before = event.clientY < rect.top + rect.height / 2;
          targetIndex = before ? targetTab.index : targetTab.index + 1;
        }
      }
    }

    if (!Number.isFinite(targetIndex)) return resetDragState();

    if (targetIndex > sourceTab.index) targetIndex -= 1;

    if (targetIndex !== sourceTab.index) {
      try {
        await chrome.tabs.move(draggedTabId, { index: targetIndex });
        await loadTabs();
      } catch (error) {
        console.error("拖拽排序失败", error);
      }
    }

    resetDragState();
  }

  // 统一清理拖拽相关的类名与状态变量。
  function resetDragState() {
    tabsContainer
      .querySelectorAll(".tab-item--dragging")
      .forEach((element) => element.classList.remove("tab-item--dragging"));
    setDragOverElement(null);
    draggedTabId = null;
  }

  // 展示临时提示信息（复制成功等），带自动隐藏计时器。
  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("toast--visible");
    toast.setAttribute("aria-hidden", "false");

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("toast--visible");
      toast.setAttribute("aria-hidden", "true");
      toastTimer = null;
    }, 1600);
  }

  // 支持按钮复制标签地址，包含 Clipboard API 与 textarea 回退方案。
  async function copyTabUrl(tabId, triggerButton) {
    const tab =
      findTab(tabId) || (await chrome.tabs.get(tabId).catch(() => null));
    const urlToCopy = tab?.url || tab?.pendingUrl;
    if (!urlToCopy) return;

    const applyCopiedState = () => {
      if (!triggerButton) return;
      triggerButton.classList.add("copy-tab-btn--copied");
      setTimeout(() => {
        triggerButton.classList.remove("copy-tab-btn--copied");
      }, 1200);
    };

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(urlToCopy);
        applyCopiedState();
        showToast("链接已复制");
        return;
      }
    } catch (error) {
      console.warn("navigator.clipboard.writeText 失败，尝试回退方案", error);
    }

    const textarea = document.createElement("textarea");
    textarea.value = urlToCopy;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand("copy");
      applyCopiedState();
      showToast("链接已复制");
    } catch (error) {
      console.error("复制标签页地址失败", error);
    } finally {
      document.body.removeChild(textarea);
    }
  }

  // 记录当前激活的标签，便于单击/双击逻辑引用。
  function handleTabActivated(activeInfo) {
    if (currentActiveTabId !== activeInfo.tabId) {
      currentActiveTabId = activeInfo.tabId;
    }
  }

  // 在当前窗口末尾创建新标签，保持 Side Panel 与浏览器同步。
  async function createTabInCurrentWindow() {
    const { id: windowId } = await chrome.windows.getCurrent({
      populate: false,
    });
    await chrome.tabs.create({ windowId });
  }

  const separator = () => ({ type: "separator" });
  const actionItem = (label, action, disabled = false) => ({
    label,
    action,
    disabled,
  });

  // 根据当前标签与同窗口其他标签生成菜单项数组。
  function buildContextMenuItems(tab, tabsInWindow) {
    const otherTabs = tabsInWindow.filter((item) => item.id !== tab.id);
    const available = (predicate) =>
      otherTabs.filter((item) => !item.pinned && predicate(item));
    const closeTabs = async (list) => {
      const ids = list.map((item) => item.id);
      if (ids.length) await chrome.tabs.remove(ids);
    };

    const tabsToRight = available((item) => item.index > tab.index);
    const tabsToLeft = available((item) => item.index < tab.index);
    const closableOthers = available(() => true);

    return [
      actionItem("新建标签页", () =>
        chrome.tabs.create({ windowId: tab.windowId })
      ),
      actionItem("在下侧新建标签页", () =>
        chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1 })
      ),
      separator(),
      actionItem("重新加载标签页", () => chrome.tabs.reload(tab.id)),
      actionItem("复制标签页", () => chrome.tabs.duplicate(tab.id)),
      separator(),
      actionItem(tab.pinned ? "取消固定标签页" : "固定标签页", () =>
        chrome.tabs.update(tab.id, { pinned: !tab.pinned })
      ),
      actionItem(tab.mutedInfo?.muted ? "取消静音此站点" : "静音此站点", () =>
        chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted })
      ),
      separator(),
      actionItem("移动到新窗口", () =>
        chrome.windows.create({ tabId: tab.id, focused: true })
      ),
      separator(),
      actionItem("关闭标签页", () => chrome.tabs.remove(tab.id)),
      actionItem(
        "关闭其他标签页",
        () => closeTabs(closableOthers),
        closableOthers.length === 0
      ),
      actionItem(
        "关闭下方全部标签页",
        () => closeTabs(tabsToRight),
        tabsToRight.length === 0
      ),
      actionItem(
        "关闭上方全部标签页",
        () => closeTabs(tabsToLeft),
        tabsToLeft.length === 0
      ),
    ];
  }

  // 渲染并展示自定义菜单，同时设置初始焦点。
  function showContextMenu(items, position) {
    contextMenu.replaceChildren(...items.map(createMenuElement));
    contextMenu.style.display = "block";
    contextMenu.setAttribute("aria-hidden", "false");

    positionContextMenu(position.x, position.y, {
      onPositioned: () => {
        const focusable = contextMenu.querySelector(
          ".context-menu__item:not([disabled])"
        );
        focusable?.focus();
      },
    });

    isContextMenuVisible = true;
  }

  // 将菜单数据映射为按钮或分隔符节点，并注入点击行为。
  function createMenuElement(item) {
    if (item.type === "separator") {
      const separatorNode = document.createElement("div");
      separatorNode.className = "context-menu__separator";
      return separatorNode;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu__item";
    button.textContent = item.label;
    button.setAttribute("role", "menuitem");

    if (item.disabled) {
      button.disabled = true;
      button.classList.add("context-menu__item--disabled");
    } else {
      button.addEventListener("click", async () => {
        hideContextMenu(true);
        try {
          await item.action();
        } catch (error) {
          console.error("执行菜单操作失败", error);
        }
      });
    }

    return button;
  }

  // 隐藏菜单并清空内容，可强制触发（例如标签被删除时）。
  function hideContextMenu(force = false) {
    if (!isContextMenuVisible && !force) return;

    contextMenu.style.display = "none";
    contextMenu.setAttribute("aria-hidden", "true");
    contextMenu.innerHTML = "";
    isContextMenuVisible = false;
    contextMenuAnchor = null;
  }

  // 控制菜单位置，自动防止超出窗口视口。
  function positionContextMenu(x, y, options = {}) {
    contextMenu.style.left = `${x}px`;
    contextMenu.style.top = `${y}px`;

    requestAnimationFrame(() => {
      if (contextMenu.style.display === "none") return;

      const rect = contextMenu.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - 8;
      const maxTop = window.innerHeight - rect.height - 8;
      contextMenu.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`;
      contextMenu.style.top = `${Math.max(8, Math.min(rect.top, maxTop))}px`;
      options.onPositioned?.();
    });
  }

  // 当滚动或窗口尺寸变化时，根据锚点重新定位菜单。
  function repositionContextMenuToAnchor() {
    if (!isContextMenuVisible || !contextMenuAnchor) return;
    const { element, offsetX, offsetY } = contextMenuAnchor;
    if (!element || !element.isConnected) {
      hideContextMenu(true);
      return;
    }
    const rect = element.getBoundingClientRect();
    positionContextMenu(rect.left + offsetX, rect.top + offsetY);
  }

  // 弹出对话框获取缩放值，并在校验后保存与应用。
  async function promptAndApplyZoom() {
    const rawInput = prompt(
      `请输入全局缩放百分比（${MIN_ZOOM_PERCENT}-${MAX_ZOOM_PERCENT}）`,
      String(targetZoomPercent ?? 100)
    );
    if (rawInput === null) return;

    const parsed = Number.parseFloat(rawInput.trim());
    if (!Number.isFinite(parsed)) {
      alert("请输入有效的数字");
      return;
    }

    const clampedPercent = clampZoom(parsed);
    targetZoomPercent = clampedPercent;

    try {
      await saveTargetZoomToStorage(clampedPercent);
      const result = await applyZoomToAllTabs();
      showZoomResult(parsed, clampedPercent, result);
    } catch (error) {
      console.error("设置缩放失败", error);
      alert("设置缩放失败，请稍后重试");
    }
  }

  // 将缩放结果整理为可读信息，通过 alert 告知用户。
  function showZoomResult(requestedPercent, appliedPercent, stats) {
    const lines = [
      `缩放已应用至 ${appliedPercent}%`,
      `成功：${stats.successCount} 个标签页`,
      `失败：${stats.failureDetails.length} 个标签页`,
    ];

    if (stats.skippedDetails.length) {
      lines.push(`跳过：${stats.skippedDetails.length} 个标签页（浏览器限制）`);
    }

    if (stats.failureDetails.length) {
      const sample = stats.failureDetails
        .slice(0, 3)
        .map(({ title, reason }) => `· ${title}：${reason}`)
        .join("\n");
      lines.push("部分失败示例：\n" + sample);
    }

    if (requestedPercent !== appliedPercent) {
      lines.push(
        `提示：缩放值已被限制在 ${MIN_ZOOM_PERCENT}% ~ ${MAX_ZOOM_PERCENT}% 之间`
      );
    }

    alert(lines.join("\n"));
  }

  // 从 storage 中读取全局缩放百分比，恢复用户偏好。
  async function loadTargetZoomFromStorage() {
    if (!storageArea) return;
    try {
      const data = await storageArea.get(ZOOM_STORAGE_KEY);
      const value = data?.[ZOOM_STORAGE_KEY];
      if (Number.isFinite(value)) {
        targetZoomPercent = clampZoom(value);
      }
    } catch (error) {
      console.warn("读取缩放设置失败", error);
    }
  }

  // 将新的缩放百分比持久化到同步存储。
  async function saveTargetZoomToStorage(value) {
    if (!storageArea) return;
    try {
      await storageArea.set({ [ZOOM_STORAGE_KEY]: value });
    } catch (error) {
      console.warn("保存缩放设置失败", error);
    }
  }

  // 遍历所有标签应用统一缩放，并记录成功/失败详细信息。
  async function applyZoomToAllTabs() {
    if (!Number.isFinite(targetZoomPercent)) {
      return { successCount: 0, failureDetails: [], skippedDetails: [] };
    }

    const zoomFactor = targetZoomPercent / 100;
    const tabs = await chrome.tabs.query({});
    const stats = { successCount: 0, failureDetails: [], skippedDetails: [] };

    await Promise.all(
      tabs.map(async (tab) => {
        if (isRestrictedUrl(tab?.url)) {
          stats.skippedDetails.push({
            title: tab?.title || tab?.url || "未知页面",
            reason: `不支持的协议：${getUrlProtocol(tab?.url) || "未知"}`,
          });
          return;
        }

        try {
          await chrome.tabs.setZoomSettings(tab.id, { scope: "per-tab" });
          await chrome.tabs.setZoom(tab.id, zoomFactor);
          stats.successCount += 1;
        } catch (error) {
          stats.failureDetails.push({
            title: tab.title || tab.url || "未知页面",
            reason: error?.message || "原因未知",
          });
        }
      })
    );

    return stats;
  }

  // 对单个标签设置缩放，主要用于新开/刷新场景。
  async function applyZoomToTab(tab) {
    if (
      !Number.isFinite(targetZoomPercent) ||
      !tab?.id ||
      isRestrictedUrl(tab.url)
    ) {
      return;
    }

    try {
      await chrome.tabs.setZoomSettings(tab.id, { scope: "per-tab" });
      await chrome.tabs.setZoom(tab.id, targetZoomPercent / 100);
    } catch (error) {
      console.warn("应用缩放失败", tab, error);
    }
  }

  // 安全解析 URL 协议，出现异常时返回空字符串。
  function getUrlProtocol(url) {
    try {
      return url ? new URL(url).protocol : "";
    } catch (error) {
      return "";
    }
  }
});
