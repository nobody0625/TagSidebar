document.addEventListener("DOMContentLoaded", async () => {
  const toggleFullscreenBtn = document.getElementById("toggle-fullscreen-btn");
  const setZoomBtn = document.getElementById("set-zoom-btn");
  const tabsContainer = document.getElementById("tabs-container");
  const contextMenu = document.getElementById("custom-context-menu");

  if (!tabsContainer || !contextMenu) {
    console.warn("初始化侧边栏失败：缺少关键元素");
    return;
  }

  const ESCAPE_LOOKUP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  const escapeHtml = (value = "") =>
    String(value).replace(/[&<>"']/g, (char) => ESCAPE_LOOKUP[char] ?? char);

  const cleanupTasks = [];
  const addCleanup = (fn) => cleanupTasks.push(fn);
  const addListener = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    addCleanup(() => target.removeEventListener(type, handler, options));
  };
  const addChromeListener = (eventTarget, handler) => {
    eventTarget.addListener(handler);
    addCleanup(() => eventTarget.removeListener(handler));
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

  const tabEvents = [
    chrome.tabs.onCreated,
    chrome.tabs.onRemoved,
    chrome.tabs.onUpdated,
    chrome.tabs.onMoved,
    chrome.tabs.onAttached,
    chrome.tabs.onDetached,
    chrome.tabs.onReplaced,
    chrome.tabs.onActivated,
  ];
  tabEvents.forEach((eventTarget) => {
    addChromeListener(eventTarget, loadTabs);
  });

  addChromeListener(chrome.tabs.onCreated, handleTabCreated);
  addChromeListener(chrome.tabs.onUpdated, handleTabUpdated);
  addChromeListener(chrome.tabs.onUpdated, handleTabStatusChange);
  addChromeListener(chrome.tabs.onRemoved, handleTabRemoved);
  addChromeListener(chrome.windows.onCreated, handleWindowCreated);
  addChromeListener(chrome.tabs.onActivated, handleTabActivated);

  addListener(tabsContainer, "contextmenu", handleTabContextMenu);
  addListener(tabsContainer, "click", handleTabClick);
  addListener(tabsContainer, "dblclick", handleTabDoubleClick);

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

    let markup = "";

    if (!cachedTabs.length) {
      markup = '<p class="empty-state">当前没有打开的标签页</p>';
    } else {
      markup = cachedTabs.map(renderTab).join("");
    }

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
      <div class="tab-item${activeClass}" data-tab-id="${tab.id}">
        <div class="${iconClass}">${icon}</div>
        <span class="tab-title${mutedClass}" title="${escapedTitle}">${escapedTitle}</span>
        <button class="reload-tab-btn"${reloadAttrs} type="button" aria-label="刷新标签页 ${escapedTitle}" title="刷新">↻</button>
        <button class="close-tab-btn" type="button" aria-label="关闭标签页 ${escapedTitle}">&times;</button>
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

    const iconElement = tabElement.querySelector(".tab-icon");
    iconElement?.classList.toggle("tab-icon--loading", isLoading);

    const reloadButton = tabElement.querySelector(".reload-tab-btn");
    if (!reloadButton) return;

    reloadButton.disabled = isLoading;
    if (isLoading) {
      reloadButton.setAttribute("aria-busy", "true");
    } else {
      reloadButton.removeAttribute("aria-busy");
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

    const actionButton = event.target.closest(
      ".reload-tab-btn, .close-tab-btn"
    );

    if (event.detail === 1) {
      lastActiveTabIdBeforeClick = null;
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

    const actionButton = event.target.closest(
      ".reload-tab-btn, .close-tab-btn"
    );
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

    const success = [];
    const failures = [];
    const skipped = [];

    await Promise.all(
      tabs.map(async (tab) => {
        try {
          const protocol = getUrlProtocol(tab.url);
          if (!tab.url || restrictedProtocols.has(protocol)) {
            skipped.push({
              title: tab.title || tab.url || "未知页面",
              reason: `不支持的协议：${protocol || "未知"}`,
            });
            return;
          }

          await chrome.tabs.setZoomSettings(tab.id, { scope: "per-tab" });
          await chrome.tabs.setZoom(tab.id, zoomFactor);
          success.push(tab.id);
        } catch (error) {
          failures.push({
            title: tab.title || tab.url || "未知页面",
            reason: error?.message || "原因未知",
          });
        }
      })
    );

    return {
      successCount: success.length,
      failureDetails: failures,
      skippedDetails: skipped,
    };
  }

  async function handleTabCreated(tab) {
    await applyZoomToTab(tab);
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (!Number.isFinite(targetZoomPercent)) return;
    if (changeInfo.status === "complete" || changeInfo.url) {
      await applyZoomToTab(
        tab ?? (await chrome.tabs.get(tabId).catch(() => null))
      );
    }
  }

  async function handleWindowCreated(window) {
    if (!Number.isFinite(targetZoomPercent)) return;

    const tabs = await chrome.tabs.query({ windowId: window.id });
    await Promise.all(tabs.map((tab) => applyZoomToTab(tab)));
  }

  async function applyZoomToTab(tab) {
    if (!Number.isFinite(targetZoomPercent)) return;

    let targetTab = tab;
    if (!targetTab || typeof targetTab.id !== "number") {
      return;
    }

    try {
      const protocol = getUrlProtocol(targetTab.url);
      if (!targetTab.url || restrictedProtocols.has(protocol)) {
        return;
      }

      await chrome.tabs.setZoomSettings(targetTab.id, { scope: "per-tab" });
      await chrome.tabs.setZoom(targetTab.id, targetZoomPercent / 100);
    } catch (error) {
      console.warn("应用缩放失败", targetTab, error);
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
