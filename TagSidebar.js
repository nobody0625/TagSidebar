document.addEventListener("DOMContentLoaded", async () => {
  const toggleFullscreenBtn = document.getElementById("toggle-fullscreen-btn");
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
    eventTarget.addListener(loadTabs);
    addCleanup(() => eventTarget.removeListener(loadTabs));
  });

  addListener(tabsContainer, "contextmenu", handleTabContextMenu);
  addListener(tabsContainer, "click", handleTabClick);

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

    if (isContextMenuVisible) hideContextMenu(true);

    if (!cachedTabs.length) {
      tabsContainer.innerHTML =
        '<p class="empty-state">当前没有打开的标签页</p>';
      return;
    }

    const markup = cachedTabs
      .map((tab) => {
        const rawTitle =
          tab.title?.trim() || tab.pendingUrl || tab.url || "未命名标签页";
        const escapedTitle = escapeHtml(rawTitle);
        const iconContent = tab.favIconUrl
          ? `<img src="${escapeHtml(tab.favIconUrl)}" alt="${escapedTitle}" />`
          : escapeHtml((rawTitle[0] || "★").toUpperCase());
        const activeClass = tab.active ? " tab-item--active" : "";
        const mutedClass = tab.mutedInfo?.muted ? " tab-title--muted" : "";

        return `
          <div class="tab-item${activeClass}" data-tab-id="${tab.id}">
            <div class="tab-icon">${iconContent}</div>
            <span class="tab-title${mutedClass}" title="${escapedTitle}">${escapedTitle}</span>
            <button class="close-tab-btn" type="button" aria-label="关闭标签页 ${escapedTitle}">&times;</button>
          </div>
        `;
      })
      .join("");

    tabsContainer.innerHTML = markup;
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

  async function handleTabClick(event) {
    const context = getTabContext(event);
    if (!context) return;

    hideContextMenu();

    if (event.target.classList.contains("close-tab-btn")) {
      await chrome.tabs.remove(context.id);
      return;
    }

    await chrome.tabs.update(context.id, { active: true });
    const tab = await chrome.tabs.get(context.id);
    await chrome.windows.update(tab.windowId, { focused: true });
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
      actionItem("在右侧新建标签页", () =>
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
});
