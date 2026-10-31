import './collection-worker.js';

const STORAGE_KEYS = {
  targetUrl: "targetUrl",
  targetTabId: "targetTabId",
  usePopupWindow: "usePopupWindow"
};

const SOURCE_URL_PARAM_KEY = "url";
const DOWNLOADER_PARAM_KEY = "downloader";
const DOWNLOADER_PARAM_VALUE = "1";
const SWARMUI_PATH_SEGMENT = "Text2Image";
const IN_PLACE_HASH_KEY = "swarmui-downloader";
const MENU_ID = "send-to-swarmui";
const MENU_TITLE = "Send to SwarmUI";

chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension();
});

chrome.runtime.onStartup.addListener(() => {
  void createContextMenu().catch((error) => {
    console.error("Failed to recreate context menu on startup:", error);
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  const sourceUrl = getSourceUrl(info, tab);
  if (!sourceUrl) {
    console.warn("No URL available for right-click context:", info);
    return;
  }

  void handleForwardMessage(sourceUrl)
    .catch(async (error) => {
      console.error("Failed to forward source URL:", error);
      if (shouldOpenOptionsForError(error)) {
        await chrome.runtime.openOptionsPage();
      }
    });
});

async function ensureDefaultSettings() {
  const { targetUrl, usePopupWindow } = await chrome.storage.local.get([
    STORAGE_KEYS.targetUrl,
    STORAGE_KEYS.usePopupWindow
  ]);
  if (!targetUrl) {
    await chrome.storage.local.set({ [STORAGE_KEYS.targetUrl]: "" });
  }
  if (typeof usePopupWindow !== "boolean") {
    await chrome.storage.local.set({ [STORAGE_KEYS.usePopupWindow]: false });
  }
}

async function initializeExtension() {
  try {
    await ensureDefaultSettings();
    await createContextMenu();
  } catch (error) {
    console.error("Failed to initialize extension:", error);
  }
}

function createContextMenu() {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.removeAll(() => {
      const removeError = chrome.runtime.lastError;
      if (removeError) {
        reject(new Error(removeError.message));
        return;
      }

      chrome.contextMenus.create(
        {
          id: MENU_ID,
          title: MENU_TITLE,
          contexts: ["all"]
        },
        () => {
          const createError = chrome.runtime.lastError;
          if (createError) {
            reject(new Error(createError.message));
            return;
          }
          resolve();
        }
      );
    });
  });
}

function getSourceUrl(info, tab) {
  if (info.linkUrl) {
    return info.linkUrl;
  }

  if (tab?.url) {
    return tab.url;
  }

  if (info.pageUrl) {
    return info.pageUrl;
  }

  if (info.frameUrl) {
    return info.frameUrl;
  }

  return null;
}

function shouldOpenOptionsForError(error) {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("SwarmUI server URL");
}

async function handleForwardMessage(sourceUrl) {
  const { targetUrl, usePopupWindow } = await chrome.storage.local.get([
    STORAGE_KEYS.targetUrl,
    STORAGE_KEYS.usePopupWindow
  ]);

  if (!targetUrl) {
    throw new Error("Set a SwarmUI server URL in extension options before forwarding URLs.");
  }

  const forwardUrl = buildForwardUrl(targetUrl, sourceUrl);
  const tabId = await getOrCreateTargetTab(targetUrl, sourceUrl, forwardUrl, usePopupWindow === true);
  await chrome.storage.local.set({ [STORAGE_KEYS.targetTabId]: tabId });
}

function buildForwardUrl(targetUrl, sourceUrl) {
  const parsed = parseTargetServerUrl(targetUrl);
  parsed.pathname = buildText2ImagePath(parsed.pathname);
  parsed.search = "";
  parsed.hash = "";
  parsed.searchParams.set(DOWNLOADER_PARAM_KEY, DOWNLOADER_PARAM_VALUE);
  parsed.searchParams.set(SOURCE_URL_PARAM_KEY, sourceUrl);
  return parsed.toString();
}

function parseTargetServerUrl(targetUrl) {
  const parsed = tryParseHttpOrHttpsUrl(targetUrl);
  if (parsed) {
    return parsed;
  }

  const fallback = tryParseHttpOrHttpsUrl(`http://${targetUrl}`);
  if (fallback) {
    return fallback;
  }

  throw new Error("SwarmUI server URL is invalid. Update extension options.");
}

function tryParseHttpOrHttpsUrl(candidate) {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function buildText2ImagePath(currentPath) {
  const trimmed = currentPath.replace(/\/+$/, "");

  if (!trimmed || trimmed === "/") {
    return `/${SWARMUI_PATH_SEGMENT}`;
  }

  if (trimmed.endsWith(`/${SWARMUI_PATH_SEGMENT}`)) {
    return trimmed;
  }

  return `${trimmed}/${SWARMUI_PATH_SEGMENT}`;
}

function normalizePath(pathname) {
  let normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function isTabOnTargetText2Image(tabUrl, targetServerUrl) {
  const current = tryParseHttpOrHttpsUrl(tabUrl);
  if (!current) {
    return false;
  }
  const target = parseTargetServerUrl(targetServerUrl);
  if (current.origin !== target.origin) {
    return false;
  }
  return normalizePath(current.pathname) === normalizePath(buildText2ImagePath(target.pathname));
}

function buildInPlaceHash(sourceUrl) {
  const encoded = encodeURIComponent(sourceUrl);
  return `${IN_PLACE_HASH_KEY}=${encoded}&t=${Date.now()}`;
}

function buildInPlaceTabUrl(existingTabUrl, sourceUrl) {
  const parsed = tryParseHttpOrHttpsUrl(existingTabUrl);
  if (!parsed) {
    return null;
  }
  parsed.hash = buildInPlaceHash(sourceUrl);
  return parsed.toString();
}

async function getOrCreateTargetTab(targetUrl, sourceUrl, forwardUrl, usePopupWindow) {
  const { targetTabId } = await chrome.storage.local.get(STORAGE_KEYS.targetTabId);

  if (typeof targetTabId === "number") {
    try {
      const existingTab = await chrome.tabs.get(targetTabId);
      if (isTabOnTargetText2Image(existingTab.url, targetUrl)) {
        const inPlaceUrl = buildInPlaceTabUrl(existingTab.url, sourceUrl);
        await chrome.tabs.update(targetTabId, {
          active: true,
          ...(inPlaceUrl ? { url: inPlaceUrl } : {})
        });
        if (typeof existingTab.windowId === "number") {
          await chrome.windows.update(existingTab.windowId, { focused: true });
        }
      } else {
        await chrome.tabs.update(targetTabId, { url: forwardUrl, active: true });
        if (typeof existingTab.windowId === "number") {
          await chrome.windows.update(existingTab.windowId, { focused: true });
        }
      }
      return targetTabId;
    } catch {
      await chrome.storage.local.remove(STORAGE_KEYS.targetTabId);
    }
  }

  return await createTargetTab(forwardUrl, usePopupWindow === true);
}

async function createTargetTab(forwardUrl, usePopupWindow) {
  if (usePopupWindow) {
    const createdWindow = await chrome.windows.create({
      url: forwardUrl,
      type: "popup",
      focused: true,
      width: 1400,
      height: 1000
    });
    const popupTabId = createdWindow.tabs?.[0]?.id;
    if (typeof popupTabId !== "number") {
      throw new Error("Unable to create popup target tab.");
    }
    return popupTabId;
  }
  const tab = await chrome.tabs.create({
    url: forwardUrl,
    active: true
  });

  if (typeof tab.id !== "number") {
    throw new Error("Unable to create target tab.");
  }

  return tab.id;
}
