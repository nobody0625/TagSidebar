document.addEventListener("DOMContentLoaded", async () => {
  const [toggleFullscreenBtn, setZoomBtn, tabsContainer, contextMenu] = [
    document.getElementById("toggle-fullscreen-btn"),
    document.getElementById("set-zoom-btn"),
    document.getElementById("tabs-container"),
    document.getElementById("custom-context-menu"),
  ];

  if (!tabsContainer || !contextMenu) {
    console.warn("初始化侧边栏失败：缺少关键元素");
    return;
  }

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

  const cleanupTasks = [];
  const addListener = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanupTasks.push(() => target.removeEventListener(type, handler, options));
  };
  const addChromeListener = (eventTarget, handler) => {
    eventTarget.addListener(handler);
    cleanupTasks.push(() => eventTarget.removeListener(handler));
  };
  const dispose = () => {
    while (cleanupTasks.length) {
      try {
        cleanupTasks.pop()?.();
      } catch (error) {
        console.error("清理监听器失败", error);
      }
    }
    hideContextMenu(true);
  };

  let cachedTabs = [];
  let isContextMenuVisible = false;
  let contextMenuAnchor = null;
  let targetZoomPercent = null;
  const reloadingTabIds = new Set();
  let currentActiveTabId = null;
  let lastActiveTabIdBeforeClick = null;
  let draggedTabId = null;
  let dragOverElement = null;

  addListener(window, "unload", dispose);

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

  if (toggleFullscreenBtn) {
    addListener(toggleFullscreenBtn, "click", async () => {
      const currentWindow = await chrome.windows.getCurrent();
      const nextState =
        currentWindow.state === "fullscreen" ? "maximized" : "fullscreen";
      chrome.windows.update(currentWindow.id, { state: nextState });
    });
  }

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
  const isZoomableTab = (tab) =>
    Boolean(tab?.url) && !restrictedProtocols.has(getUrlProtocol(tab.url));

  if (setZoomBtn) {
    addListener(setZoomBtn, "click", () => promptAndApplyZoom());
  }

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
  addChromeListener(chrome.tabs.onUpdated, handleTabStatusChange);
  addChromeListener(chrome.tabs.onRemoved, handleTabRemoved);
  addChromeListener(chrome.windows.onCreated, async (window) => {
    if (!Number.isFinite(targetZoomPercent)) return;
    const tabs = await chrome.tabs.query({ windowId: window.id });
    await Promise.all(tabs.map(applyZoomToTab));
  });
  addChromeListener(chrome.tabs.onActivated, handleTabActivated);

  addListener(tabsContainer, "contextmenu", handleTabContextMenu);
  addListener(tabsContainer, "click", handleTabClick);
  addListener(tabsContainer, "dblclick", handleTabDoubleClick);
  addListener(tabsContainer, "dragstart", handleTabDragStart);
  addListener(tabsContainer, "dragover", handleTabDragOver);
  addListener(tabsContainer, "dragleave", handleTabDragLeave);
  addListener(tabsContainer, "drop", handleTabDrop);
  addListener(tabsContainer, "dragend", handleTabDragEnd);

  const passive = { passive: true };
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

  await loadTargetZoomFromStorage();
  await applyZoomToAllTabs();
  await loadTabs();

  function getTabContext(event) {
    const element = event.target.closest(".tab-item");
    if (!element) return null;
    const id = Number(element.dataset.tabId);
    return Number.isFinite(id) ? { element, id } : null;
  }

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
      const activeTab = cachedTabs.find((tab) => tab.active);
      if (activeTab) currentActiveTabId = activeTab.id;
    }

    const markup = cachedTabs.length
      ? cachedTabs.map(renderTab).join("")
      : '<p class="empty-state">当前没有打开的标签页</p>';

    tabsContainer.innerHTML = `${markup}${renderNewTabRow()}`;
  }

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

  function renderNewTabRow() {
    return `
      <button class="new-tab-btn" type="button">
        <span class="new-tab-btn__icon">＋</span>
        <span>新建标签页</span>
      </button>
    `;
  }

  function setTabLoadingState(tabId, isLoading) {
    if (isLoading) {
      reloadingTabIds.add(tabId);
    } else {
      reloadingTabIds.delete(tabId);
    }

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

  async function handleTabContextMenu(event) {
    const context = getTabContext(event);
    if (!context) return;

    event.preventDefault();
    hideContextMenu(true);

    const tab =
      cachedTabs.find((item) => item.id === context.id) ||
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

  function handleTabStatusChange(tabId, changeInfo) {
    if (changeInfo.status === "loading") {
      setTabLoadingState(tabId, true);
    } else if (changeInfo.status === "complete") {
      setTabLoadingState(tabId, false);
    }
  }

  function handleTabRemoved(tabId) {
    reloadingTabIds.delete(tabId);
    if (currentActiveTabId === tabId) currentActiveTabId = null;
    if (lastActiveTabIdBeforeClick === tabId) lastActiveTabIdBeforeClick = null;
  }

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

    if (event.detail === 1) {
      lastActiveTabIdBeforeClick = null;
    }

    if (actionButton?.classList.contains("copy-tab-btn")) {
      event.preventDefault();
      event.stopPropagation();
      await copyTabUrl(context.id, actionButton);
      return;
    }

    if (actionButton?.classList.contains("reload-tab-btn")) {
      setTabLoadingState(context.id, true);
      try {
        await chrome.tabs.reload(context.id);
      } catch (error) {
        console.error("刷新标签页失败", error);
        setTabLoadingState(context.id, false);
      }
      return;
    }

    if (actionButton?.classList.contains("close-tab-btn")) {
      await chrome.tabs.remove(context.id);
      return;
    }

    const fallbackActiveTabId =
      currentActiveTabId ?? cachedTabs.find((tab) => tab.active)?.id ?? null;
    if (fallbackActiveTabId !== null && fallbackActiveTabId !== context.id) {
      lastActiveTabIdBeforeClick = fallbackActiveTabId;
    }

    await chrome.tabs.update(context.id, { active: true });
    const tab = await chrome.tabs.get(context.id);
    await chrome.windows.update(tab.windowId, { focused: true });
  }

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

  function handleTabDragOver(event) {
    if (!Number.isFinite(draggedTabId)) return;

    const tabElement = event.target.closest(".tab-item");
    if (!tabElement || Number(tabElement.dataset.tabId) === draggedTabId) {
      if (!tabElement) {
        dragOverElement?.classList.remove("tab-item--drag-over");
        dragOverElement = null;
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }

    if (dragOverElement && dragOverElement !== tabElement) {
      dragOverElement.classList.remove("tab-item--drag-over");
    }

    dragOverElement = tabElement;
    dragOverElement.classList.add("tab-item--drag-over");
  }

  function handleTabDragLeave(event) {
    const related = event.relatedTarget;
    if (!related || !tabsContainer.contains(related)) {
      dragOverElement?.classList.remove("tab-item--drag-over");
      dragOverElement = null;
    }
  }

  async function handleTabDrop(event) {
    if (!Number.isFinite(draggedTabId)) return;
    event.preventDefault();

    const sourceTab = cachedTabs.find((tab) => tab.id === draggedTabId);
    if (!sourceTab) {
      resetDragState();
      return;
    }

    const targetElement = event.target.closest(".tab-item");
    let targetIndex = cachedTabs.length;

    if (targetElement) {
      const targetId = Number(targetElement.dataset.tabId);
      if (targetId === draggedTabId) {
        resetDragState();
        return;
      }

      if (Number.isFinite(targetId)) {
        const targetTab = cachedTabs.find((tab) => tab.id === targetId);
        if (targetTab) {
          const rect = targetElement.getBoundingClientRect();
          const insertBefore = event.clientY < rect.top + rect.height / 2;
          targetIndex = insertBefore ? targetTab.index : targetTab.index + 1;
        }
      }
    }

    if (!Number.isFinite(targetIndex)) {
      resetDragState();
      return;
    }

    if (targetIndex > sourceTab.index) {
      targetIndex -= 1;
    }

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

  function handleTabDragEnd() {
    resetDragState();
  }

  function resetDragState() {
    tabsContainer
      .querySelectorAll(".tab-item--dragging")
      .forEach((element) => element.classList.remove("tab-item--dragging"));
    dragOverElement?.classList.remove("tab-item--drag-over");
    dragOverElement = null;
    draggedTabId = null;
  }

  async function copyTabUrl(tabId, triggerButton) {
    const tab =
      cachedTabs.find((item) => item.id === tabId) ||
      (await chrome.tabs.get(tabId).catch(() => null));
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
    } catch (error) {
      console.error("复制标签页地址失败", error);
    } finally {
      document.body.removeChild(textarea);
    }
  }

  function handleTabActivated(activeInfo) {
    if (currentActiveTabId !== activeInfo.tabId) {
      currentActiveTabId = activeInfo.tabId;
    }
  }

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

  function showContextMenu(items, position) {
    contextMenu.innerHTML = "";
    const fragment = document.createDocumentFragment();

    items.forEach((item) => {
      fragment.appendChild(createMenuElement(item));
    });

    contextMenu.appendChild(fragment);
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

  function hideContextMenu(force = false) {
    if (!isContextMenuVisible && !force) return;

    contextMenu.style.display = "none";
    contextMenu.setAttribute("aria-hidden", "true");
    contextMenu.innerHTML = "";
    isContextMenuVisible = false;
    contextMenuAnchor = null;
  }

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

  async function saveTargetZoomToStorage(value) {
    if (!storageArea) return;
    try {
      await storageArea.set({ [ZOOM_STORAGE_KEY]: value });
    } catch (error) {
      console.warn("保存缩放设置失败", error);
    }
  }

  async function applyZoomToAllTabs() {
    if (!Number.isFinite(targetZoomPercent)) {
      return { successCount: 0, failureDetails: [], skippedDetails: [] };
    }

    const zoomFactor = targetZoomPercent / 100;
    const tabs = await chrome.tabs.query({});
    const stats = { successCount: 0, failureDetails: [], skippedDetails: [] };

    await Promise.all(
      tabs.map(async (tab) => {
        if (!tab?.url || restrictedProtocols.has(getUrlProtocol(tab.url))) {
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

  async function applyZoomToTab(tab) {
    if (
      !Number.isFinite(targetZoomPercent) ||
      !tab?.id ||
      restrictedProtocols.has(getUrlProtocol(tab.url))
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

  function getUrlProtocol(url) {
    try {
      return url ? new URL(url).protocol : "";
    } catch (error) {
      return "";
    }
  }
});
