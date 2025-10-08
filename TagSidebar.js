document.addEventListener("DOMContentLoaded", async () => {
  const toggleFullscreenBtn = document.getElementById("toggle-fullscreen-btn");
  const tabsContainer = document.getElementById("tabs-container");

  if (!tabsContainer) {
    console.warn("未找到标签容器 #tabs-container");
    return;
  }

  // 切换全屏
  toggleFullscreenBtn?.addEventListener("click", async () => {
    const currentWindow = await chrome.windows.getCurrent();
    const { state } = currentWindow;

    if (state === "fullscreen") {
      chrome.windows.update(currentWindow.id, { state: "maximized" });
    } else {
      chrome.windows.update(currentWindow.id, { state: "fullscreen" });
    }
  });

  // 首次加载
  await loadTabs();

  // 监听标签页变化，同步侧边栏数据
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

  tabEvents.forEach((event) => event.addListener(loadTabs));

  window.addEventListener("unload", () => {
    tabEvents.forEach((event) => event.removeListener(loadTabs));
  });

  // 渲染标签列表
  async function loadTabs() {
    const currentWindow = await chrome.windows.getCurrent({ populate: false });
    const tabs = await chrome.tabs.query({ windowId: currentWindow.id });

    if (!tabs.length) {
      tabsContainer.innerHTML =
        '<p class="empty-state">当前没有打开的标签页</p>';
      return;
    }

    const fragment = document.createDocumentFragment();

    tabs.forEach((tab) => {
      const titleText =
        (tab.title && tab.title.trim()) ||
        tab.pendingUrl ||
        tab.url ||
        "未命名标签页";
      const displayTitle = titleText || "未命名标签页";

      const tabItem = document.createElement("div");
      tabItem.className = "tab-item";
      tabItem.dataset.tabId = String(tab.id);
      if (tab.active) {
        tabItem.classList.add("tab-item--active");
      }

      const iconContainer = document.createElement("div");
      iconContainer.className = "tab-icon";

      if (tab.favIconUrl) {
        const iconImg = document.createElement("img");
        iconImg.src = tab.favIconUrl;
        iconImg.alt = displayTitle;
        iconContainer.appendChild(iconImg);
      } else {
        iconContainer.textContent = (displayTitle[0] || "★").toUpperCase();
      }

      const tabTitle = document.createElement("span");
      tabTitle.className = "tab-title";
      tabTitle.textContent = displayTitle;
      tabTitle.title = displayTitle;
      if (tab.mutedInfo?.muted) {
        tabTitle.classList.add("tab-title--muted");
      }

      const closeBtn = document.createElement("button");
      closeBtn.className = "close-tab-btn";
      closeBtn.type = "button";
      closeBtn.innerHTML = "&times;";
      closeBtn.setAttribute("aria-label", `关闭标签页 ${displayTitle}`);

      tabItem.appendChild(iconContainer);
      tabItem.appendChild(tabTitle);
      tabItem.appendChild(closeBtn);

      fragment.appendChild(tabItem);
    });

    tabsContainer.innerHTML = "";
    tabsContainer.appendChild(fragment);
  }

  // 事件委托：切换或关闭标签
  tabsContainer.addEventListener("click", async (event) => {
    const target = event.target;
    const tabElement = target.closest(".tab-item");
    if (!tabElement) {
      return;
    }

    const tabId = Number(tabElement.dataset.tabId);
    if (!Number.isFinite(tabId)) {
      return;
    }

    if (target.classList.contains("close-tab-btn")) {
      await chrome.tabs.remove(tabId);
      return;
    }

    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
  });
});
