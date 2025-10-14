// background.js 运行在 Chrome 扩展的 Service Worker 环境中。
// 这里仅在扩展安装或更新后配置侧边栏行为。
chrome.runtime.onInstalled.addListener(() => {
  // openPanelOnActionClick: true 表示点击工具栏图标时直接打开 side panel。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) =>
      // 在 Service Worker 中所有异常都必须显式记录，方便调试。
      console.error("设置侧边栏行为失败", error)
    );
});
