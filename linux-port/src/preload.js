"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const { pathToFileURL } = require("node:url");

const registeredCallbacks = new Map();
const debugEventCounters = new Map();
const DOWNLOAD_PROCESS_EVENT = "__netease_linux_download_process__";
const bootstrapLocalStorageDefaults = {
  setting: {
    downloadDir: "",
    cacheDir: "",
    oldCacheDir: "",
    cacheCapacity: 1
  },
  appLayout: {
    isMaxWindow: false,
    windowWidth: 1080,
    windowHeight: 720,
    leftSideWidth: 240,
    isLeftSideOpen: true,
    isMyFavlistOpenV2: true,
    isMyCreateListOpenV2: true,
    tutorialInit: false,
    tutorialLoginPoped: false,
    cloudDiskUsed: false,
    sidebarFmUsed: false
  },
  sidebar: {
    uid: "",
    showList: [],
    hideList: []
  },
  v2tov3UpgradeFlag: {
    host: false,
    playList: false,
    lastPlayList: false,
    shortcut: false,
    otherSettingScene: false
  },
  NM_SETTING_CUSTOM: {
    storage: {
      path: ""
    },
    quantity: {
      fileNameType: 0,
      pathNameType: 0
    }
  }
};

function invokeNative(command, args) {
  return ipcRenderer.invoke("native:call", { command, args });
}

function toBridgeEventName(name, namespace) {
  const normalizedName = String(name || "").trim();
  const normalizedNamespace = String(namespace || "").trim();
  if (!normalizedName) {
    return "";
  }
  if (normalizedName.includes(".")) {
    return normalizedName;
  }
  if (!normalizedNamespace) {
    return normalizedName;
  }
  return `${normalizedNamespace}.${normalizedName.startsWith("on") ? normalizedName : `on${normalizedName}`}`;
}

function buildBridgeEventAliases(name) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) {
    return [];
  }

  const aliasSet = new Set([normalizedName, normalizedName.toLowerCase()]);
  const [namespace = "", rawEventName = ""] = normalizedName.split(".");
  const eventName = String(rawEventName || "").trim();
  const normalizedNamespace = String(namespace || "").trim();

  if (!normalizedNamespace || !eventName) {
    return Array.from(aliasSet);
  }

  const withoutOnPrefix = eventName.replace(/^on/i, "");
  const decapitalize = (value) =>
    value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
  const capitalize = (value) =>
    value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;

  const eventVariants = new Set([
    eventName,
    eventName.toLowerCase(),
    decapitalize(eventName),
    capitalize(eventName),
    withoutOnPrefix,
    withoutOnPrefix.toLowerCase(),
    decapitalize(withoutOnPrefix),
    capitalize(withoutOnPrefix)
  ]);

  for (const variant of eventVariants) {
    if (!variant) {
      continue;
    }
    aliasSet.add(`${normalizedNamespace}.${variant}`);
    aliasSet.add(`${normalizedNamespace}.${String(variant).toLowerCase()}`);
    aliasSet.add(`${variant}.${normalizedNamespace}`);
    aliasSet.add(`${String(variant).toLowerCase()}.${normalizedNamespace}`);
    aliasSet.add(variant);
    aliasSet.add(String(variant).toLowerCase());
  }

  return Array.from(aliasSet);
}

function resolveRegisteredCallbacks(name) {
  const matches = [];
  const seen = new Set();

  for (const alias of buildBridgeEventAliases(name)) {
    if (!alias || seen.has(alias)) {
      continue;
    }
    seen.add(alias);

    const handler = registeredCallbacks.get(alias);
    if (!handler) {
      continue;
    }

    matches.push({
      handler,
      matchedName: alias
    });
  }

  return matches;
}

function normalizeDownloadProcessPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const down = Number(payload.down ?? payload.download ?? 0);
  const total = Number(payload.total ?? 0);
  const speed = Number(payload.speed ?? 0);
  const nativeType = Number(payload.type ?? 0);
  const normalizedType =
    nativeType === 1 && !Boolean(payload.isLast) && total > 0 && down < total ? 0 : nativeType;

  return {
    ...payload,
    nativeType,
    type: normalizedType,
    down,
    download: down,
    total,
    speed,
    path: payload.path || payload.relativePath || "",
    relativePath: payload.relativePath || payload.path || ""
  };
}

function shouldLogLimitedDebug(key, limit = 8) {
  const next = (debugEventCounters.get(key) || 0) + 1;
  debugEventCounters.set(key, next);
  return next <= limit;
}

function buildDownloadProcessCallbackVariants(args) {
  if (!Array.isArray(args) || args.length === 0) {
    return [args];
  }

  const payload = normalizeDownloadProcessPayload(args[0]);
  if (!payload || typeof payload !== "object") {
    return [args];
  }

  return [
    [
      payload.id,
      payload,
      payload.type,
      Boolean(payload.isLast),
      payload.relativePath,
      payload.down,
      payload.total,
      payload.speed,
      payload.path,
      payload.nativeType
    ],
    [payload]
  ];
}

function buildRegisteredCallbackArgs(name, matchedName, args) {
  if (name !== "download.onProcess") {
    return [args];
  }

  return buildDownloadProcessCallbackVariants(args);
}

function parseDownloadOfflineId(offlineId) {
  const match = String(offlineId || "").match(/^(track|voice|mv)-(.+)$/);
  if (!match) {
    return null;
  }

  return {
    resourceType: match[1],
    resourceId: match[2]
  };
}

function resolveDownloadResourceRecord(state, offlineId) {
  const downloadState = state?.download;
  const parsed = parseDownloadOfflineId(offlineId);
  if (!downloadState || !parsed) {
    return null;
  }

  const mapByType = {
    track: downloadState.trackMap,
    voice: downloadState.voiceMap,
    mv: downloadState.mvMap
  };
  const targetMap = mapByType[parsed.resourceType];
  if (!targetMap || typeof targetMap.get !== "function") {
    return null;
  }

  return targetMap.get(parsed.resourceId) || null;
}

function dispatchDownloadFallback(payload) {
  if (!parseDownloadOfflineId(payload?.id)) {
    return false;
  }

  const store = resolveAppStore();
  if (!store || typeof store.dispatch !== "function") {
    return false;
  }

  try {
    store.dispatch({
      type: "download/onDownload",
      payload
    });

    if (shouldLogLimitedDebug("download.onProcess:fallback")) {
      console.log(
        "[bridge:event:download-fallback-dispatch]",
        JSON.stringify({
          id: payload.id,
          type: payload.type,
          nativeType: payload.nativeType,
          isLast: Boolean(payload.isLast),
          down: payload.down,
          total: payload.total,
          speed: payload.speed
        })
      );
    }
    return true;
  } catch (error) {
    console.error("[bridge:event:download-fallback-error]", error);
    return false;
  }
}

function emitDownloadProcessEvent(payload) {
  try {
    window.dispatchEvent(
      new CustomEvent(DOWNLOAD_PROCESS_EVENT, {
        detail: payload
      })
    );
  } catch (error) {
    if (shouldLogLimitedDebug("download.onProcess:emit-error")) {
      console.error("[bridge:event:download-emit-error]", error);
    }
  }
}

function runRegisteredCallbacks(name, args) {
  const matches = resolveRegisteredCallbacks(name);
  if (matches.length === 0) {
    if (/^download\.|^storage\./.test(String(name || ""))) {
      console.log("[bridge:event:miss]", name, Array.isArray(args) ? args.length : 0);
    }
    return;
  }

  if (/^download\.|^storage\./.test(String(name || ""))) {
    console.log(
      "[bridge:event:dispatch]",
      name,
      matches.reduce((total, entry) => {
        const callbackList = Array.isArray(entry.handler) ? entry.handler : [entry.handler];
        return total + callbackList.length;
      }, 0),
      matches.map((entry) => entry.matchedName).join(",") || name
    );
  }

  for (const { handler, matchedName } of matches) {
    const callbackList = Array.isArray(handler) ? handler : [handler];

    for (const callback of callbackList) {
      const variants = buildRegisteredCallbackArgs(name, matchedName, args);
      let lastError = null;

      for (const variantArgs of variants) {
        try {
          if (name === "download.onProcess" && shouldLogLimitedDebug("download.onProcess:variant")) {
            const id = variantArgs[0];
            const payload =
              variantArgs[1] && typeof variantArgs[1] === "object" ? variantArgs[1] : variantArgs[0];
            console.log(
              "[bridge:event:download-variant]",
              matchedName,
              Array.isArray(variantArgs) ? variantArgs.length : 0,
              typeof id,
              typeof payload,
              payload && typeof payload === "object"
                ? JSON.stringify({
                    idArg: typeof id === "string" ? id : null,
                    id: payload.id,
                    type: payload.type,
                    nativeType: payload.nativeType,
                    isLast: Boolean(payload.isLast),
                    down: payload.down,
                    total: payload.total,
                    speed: payload.speed,
                    path: payload.path
                  })
                : String(payload)
            );
          }
          callback(...variantArgs);
          lastError = null;
          break;
        } catch (error) {
          if (name === "download.onProcess" && shouldLogLimitedDebug("download.onProcess:error")) {
            console.error(
              "[bridge:event:download-callback-error]",
              matchedName,
              Array.isArray(variantArgs) ? variantArgs.length : 0,
              error
            );
          }
          lastError = error;
        }
      }

      if (lastError) {
        console.error("[native:event]", name, lastError);
      }
    }
  }

  if (name === "download.onProcess") {
    const payload = normalizeDownloadProcessPayload(args[0]);
    if (payload && typeof payload === "object") {
      emitDownloadProcessEvent(payload);
      dispatchDownloadFallback(payload);
    }
  }
}

ipcRenderer.on("native:event", (_event, payload) => {
  if (!payload || !payload.name) {
    return;
  }
  runRegisteredCallbacks(payload.name, payload.args || []);
});

function reportRendererError(type, payload) {
  ipcRenderer.send("native:renderer-log", {
    type,
    payload
  });
}

function reportRendererInfo(type, payload) {
  if (process.env.NETEASE_DEBUG_BOOT && String(type || "").startsWith("bootstrap-")) {
    return;
  }
  ipcRenderer.send("native:renderer-log", {
    type,
    payload
  });
}

function safeParseJson(value, fallbackValue) {
  try {
    return JSON.parse(value);
  } catch {
    return fallbackValue;
  }
}

function captureAppContext(app) {
  if (!app || (typeof app !== "object" && typeof app !== "function")) {
    return;
  }

  window.__NETEASE_APP_CONTEXT__ = { app };
  if (window.__NETEASE_LINUX_PORT__) {
    window.__NETEASE_LINUX_PORT__.app = app;
  }

  const store = readStoreFromCandidate(app);
  if (store) {
    window.__NETEASE_APP_STORE__ = store;
    if (window.__NETEASE_LINUX_PORT__) {
      window.__NETEASE_LINUX_PORT__.appStore = store;
    }
    if (!window.__NETEASE_LINUX_STORE_CAPTURED__) {
      window.__NETEASE_LINUX_STORE_CAPTURED__ = true;
      reportRendererInfo("bootstrap-store-captured", {
        storeKeys: Object.keys(store.getState?.() || {}).slice(0, 50)
      });
    }
  }
}

function patchAppContextModule(moduleTable) {
  if (!moduleTable || typeof moduleTable !== "object") {
    return;
  }

  for (const [moduleId, moduleFactory] of Object.entries(moduleTable)) {
    if (typeof moduleFactory !== "function" || moduleFactory.__LINUX_APP_CONTEXT_PATCHED__) {
      continue;
    }

    const source = Function.prototype.toString.call(moduleFactory);
    if (!source.includes('setAppContext') || !source.includes('getAppContext')) {
      continue;
    }

    const patchedFactory = function patchedAppContextModule(e, o, t) {
      moduleFactory(e, o, t);

      const exportCandidates = [o, o?.default, o?.a];
      for (const exportsObject of exportCandidates) {
        if (!exportsObject || typeof exportsObject !== "object") {
          continue;
        }

        const originalSetAppContext = exportsObject.setAppContext;
        if (
          typeof originalSetAppContext !== "function" ||
          originalSetAppContext.__LINUX_APP_CONTEXT_PATCHED__
        ) {
          continue;
        }

        exportsObject.setAppContext = function patchedSetAppContext(app, ...args) {
          captureAppContext(app);
          return originalSetAppContext.call(this, app, ...args);
        };
        exportsObject.setAppContext.__LINUX_APP_CONTEXT_PATCHED__ = true;

        const originalGetAppContext = exportsObject.getAppContext;
        if (typeof originalGetAppContext === "function" && !originalGetAppContext.__LINUX_APP_CONTEXT_PATCHED__) {
          exportsObject.getAppContext = function patchedGetAppContext(...args) {
            const appContext = originalGetAppContext.apply(this, args);
            try {
              if (typeof appContext?._currentValue?.app !== "undefined") {
                captureAppContext(appContext._currentValue.app);
              }
            } catch {}
            return appContext;
          };
          exportsObject.getAppContext.__LINUX_APP_CONTEXT_PATCHED__ = true;
        }

        patchedFactory.__LINUX_APP_CONTEXT_PATCHED__ = true;
        console.log("[linux:patch] app context module patched", moduleId);
        return;
      }
    };

    patchedFactory.__LINUX_APP_CONTEXT_PATCHED__ = true;
    patchedFactory.__LINUX_APP_CONTEXT_PATCHED_FROM__ = moduleFactory;
    moduleTable[moduleId] = patchedFactory;
  }
}

function patchDvaToolModule(moduleTable) {
  if (!moduleTable || typeof moduleTable !== "object") {
    return;
  }

  for (const [moduleId, moduleFactory] of Object.entries(moduleTable)) {
    if (typeof moduleFactory !== "function" || moduleFactory.__LINUX_DVA_TOOL_PATCHED__) {
      continue;
    }

    const source = Function.prototype.toString.call(moduleFactory);
    if (
      !source.includes("can't get store before inited") ||
      !source.includes("getDispatch") ||
      !source.includes("this.app=e")
    ) {
      continue;
    }

    const patchedFactory = function patchedDvaToolModule(e, o, t) {
      moduleFactory(e, o, t);

      const exportCandidates = [o, o?.default, o?.a];
      for (const exportsObject of exportCandidates) {
        const singleton = exportsObject?.a || exportsObject;
        if (!singleton || typeof singleton !== "object") {
          continue;
        }

        const originalInit = singleton.init;
        if (typeof originalInit !== "function" || originalInit.__LINUX_DVA_TOOL_PATCHED__) {
          continue;
        }

        singleton.init = function patchedDvaToolInit(app, history, ...args) {
          captureAppContext(app);
          if (history && window.__NETEASE_LINUX_PORT__) {
            window.__NETEASE_LINUX_PORT__.history = history;
          }
          return originalInit.call(this, app, history, ...args);
        };
        singleton.init.__LINUX_DVA_TOOL_PATCHED__ = true;

        patchedFactory.__LINUX_DVA_TOOL_PATCHED__ = true;
        console.log("[linux:patch] dva tool module patched", moduleId);
        return;
      }
    };

    patchedFactory.__LINUX_DVA_TOOL_PATCHED__ = true;
    patchedFactory.__LINUX_DVA_TOOL_PATCHED_FROM__ = moduleFactory;
    moduleTable[moduleId] = patchedFactory;
  }
}

function patchDownloadObservableModule(moduleTable) {
  if (!moduleTable || typeof moduleTable !== "object") {
    return;
  }

  const originalFactory = moduleTable[1315];
  if (typeof originalFactory !== "function" || originalFactory.__LINUX_PATCHED__) {
    return;
  }

  const patchedFactory = function patchedDownloadObservableModule(e, o, t) {
    "use strict";
    t.d(o, "a", function exportObservable() {
      return c;
    });
    var a = t(4),
      l = t(22),
      n = t(58);
    const c = Object(n.a)(
      (callback) =>
        window.__NETEASE_LINUX_PORT__ &&
        window.__NETEASE_LINUX_PORT__.subscribeDownloadProcess
          ? window.__NETEASE_LINUX_PORT__.subscribeDownloadProcess(callback)
          : a.Download.subscribeProcess(callback),
      () => {}
    ).pipe(
      Object(l.map)((eventArgs) => {
        let [payload] = eventArgs;
        return payload;
      })
    );
  };

  patchedFactory.__LINUX_PATCHED__ = true;
  patchedFactory.__LINUX_PATCHED_FROM__ = originalFactory;
  moduleTable[1315] = patchedFactory;
  console.log("[linux:patch] download observable module patched");
}

function patchWebpackChunkEntry(chunkEntry) {
  if (!Array.isArray(chunkEntry) || chunkEntry.length < 2) {
    return;
  }

  patchAppContextModule(chunkEntry[1]);
  patchDvaToolModule(chunkEntry[1]);
  patchDownloadObservableModule(chunkEntry[1]);
}

function installWebpackChunkPatch() {
  const queue = Array.isArray(window.webpackJsonp) ? window.webpackJsonp : [];

  for (const chunkEntry of queue) {
    patchWebpackChunkEntry(chunkEntry);
  }

  const originalPush = typeof queue.push === "function" ? queue.push.bind(queue) : Array.prototype.push.bind(queue);
  queue.push = function patchedWebpackJsonpPush(...entries) {
    for (const entry of entries) {
      patchWebpackChunkEntry(entry);
    }
    return originalPush(...entries);
  };

  window.webpackJsonp = queue;
}

function normalizePathValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && typeof value.path === "string") {
    return value.path;
  }
  return "";
}

function countMatches(value, pattern) {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
}

function scoreReadableEastAsianText(value) {
  if (typeof value !== "string" || !value) {
    return 0;
  }
  return (
    countMatches(value, /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) * 3 +
    countMatches(value, /[\u3040-\u30ff]/g) * 2 +
    countMatches(value, /[\uac00-\ud7af]/g) * 2
  );
}

function scoreUtf8MojibakeMarkers(value) {
  if (typeof value !== "string" || !value) {
    return 0;
  }
  return (
    countMatches(value, /[ÃÂÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g) +
    countMatches(value, /[\u0080-\u009f]/g) * 2
  );
}

function maybeRepairUtf8Mojibake(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  const markerScore = scoreUtf8MojibakeMarkers(value);
  if (markerScore === 0) {
    return value;
  }

  let repaired;
  try {
    repaired = Buffer.from(value, "latin1").toString("utf8");
  } catch {
    return value;
  }

  if (!repaired || repaired === value || repaired.includes("\uFFFD")) {
    return value;
  }

  const originalReadableScore = scoreReadableEastAsianText(value);
  const repairedReadableScore = scoreReadableEastAsianText(repaired);
  const repairedMarkerScore = scoreUtf8MojibakeMarkers(repaired);

  if (repairedReadableScore <= originalReadableScore) {
    return value;
  }

  if (repairedMarkerScore > markerScore) {
    return value;
  }

  return repaired;
}

function normalizeBridgeValue(value) {
  if (typeof value === "string") {
    return maybeRepairUtf8Mojibake(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeBridgeValue(item));
  }

  if (value && typeof value === "object") {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = normalizeBridgeValue(entry);
    }
    return output;
  }

  return value;
}

function readPlayableUrl(payload = {}) {
  if (payload && typeof payload.musicurl === "string" && payload.musicurl) {
    return payload.musicurl;
  }

  const playInfoString =
    payload && typeof payload.playInfoStr === "string" ? payload.playInfoStr : "";
  if (playInfoString) {
    const playInfo = safeParseJson(playInfoString, null);
    if (playInfo && typeof playInfo.url === "string" && playInfo.url) {
      return playInfo.url;
    }
  }

  return "";
}

function readPlayableInfo(payload = {}) {
  const playInfoString =
    payload && typeof payload.playInfoStr === "string" ? payload.playInfoStr : "";
  return playInfoString ? safeParseJson(playInfoString, null) : null;
}

function shouldPrepareLocalPlayback(payload = {}, normalizedUrl = "") {
  if (!normalizedUrl) {
    return false;
  }
  if (/\.flac(?:$|\?)/i.test(normalizedUrl)) {
    return true;
  }
  const playInfo = readPlayableInfo(payload);
  const level = String(
    payload.level ||
      payload.soundQuality ||
      payload.audioFormat ||
      playInfo?.level ||
      playInfo?.type ||
      ""
  ).toLowerCase();
  return level === "lossless" || level === "flac";
}

function normalizePlayableUrl(url) {
  if (typeof url !== "string" || !url) {
    return "";
  }
  return url.replace(/^http:\/\//i, "https://");
}

function createLocalPopupMenuBridge() {
  const MENU_ROOT_ID = "__netease_linux_popup_menu_root__";
  const MENU_STYLE_ID = "__netease_linux_popup_menu_style__";
  const pointerState = {
    clientX: 0,
    clientY: 0,
    hasValue: false
  };
  let activeMenu = null;

  const updatePointerState = (event) => {
    if (!event || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
      return;
    }
    pointerState.clientX = event.clientX;
    pointerState.clientY = event.clientY;
    pointerState.hasValue = true;
  };

  window.addEventListener("pointerdown", updatePointerState, true);
  window.addEventListener("pointermove", updatePointerState, true);

  const ensureMenuStyle = () => {
    if (document.getElementById(MENU_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = MENU_STYLE_ID;
    style.textContent = `
      #${MENU_ROOT_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-backdrop {
        position: absolute;
        inset: 0;
        background: transparent;
        pointer-events: auto;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-panel {
        position: absolute;
        min-width: 188px;
        max-width: min(320px, calc(100vw - 24px));
        padding: 8px;
        border-radius: 16px;
        border: 1px solid rgba(18, 18, 18, 0.08);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 18px 50px rgba(15, 23, 42, 0.18), 0 4px 16px rgba(15, 23, 42, 0.08);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        pointer-events: auto;
        color: rgba(28, 28, 32, 0.94);
        user-select: none;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        min-height: 38px;
        padding: 0 10px;
        border: 0;
        border-radius: 12px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-item:hover,
      #${MENU_ROOT_ID} .linux-popup-menu-item:focus-visible {
        background: rgba(235, 79, 62, 0.1);
        outline: none;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-item[aria-disabled="true"] {
        opacity: 0.42;
        cursor: default;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-icon img {
        width: 16px;
        height: 16px;
        object-fit: contain;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-label {
        flex: 1;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: 13px;
        line-height: 18px;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-caret {
        font-size: 12px;
        opacity: 0.45;
      }
      #${MENU_ROOT_ID} .linux-popup-menu-separator {
        height: 1px;
        margin: 6px 8px;
        border: 0;
        background: rgba(18, 18, 18, 0.08);
      }
      html[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-panel,
      body[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-panel {
        border-color: rgba(255, 255, 255, 0.1);
        background: rgba(38, 38, 44, 0.94);
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.34), 0 4px 16px rgba(0, 0, 0, 0.2);
        color: rgba(255, 255, 255, 0.92);
      }
      html[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-item:hover,
      html[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-item:focus-visible,
      body[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-item:hover,
      body[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-item:focus-visible {
        background: rgba(255, 255, 255, 0.08);
      }
      html[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-separator,
      body[style*="color-scheme: dark"] #${MENU_ROOT_ID} .linux-popup-menu-separator {
        background: rgba(255, 255, 255, 0.1);
      }
    `;
    document.head.appendChild(style);
  };

  const ensureRoot = () => {
    let root = document.getElementById(MENU_ROOT_ID);
    if (root) {
      return root;
    }
    root = document.createElement("div");
    root.id = MENU_ROOT_ID;
    const mount = () => {
      if (document.body && !root.isConnected) {
        document.body.appendChild(root);
      }
    };
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
    return root;
  };

  const resolveMenuItems = (payload) => {
    const rawItems =
      payload?.menuItems ||
      payload?.items ||
      payload?.menus ||
      payload?.menu ||
      payload?.list ||
      [];
    return Array.isArray(rawItems) ? rawItems : [];
  };

  const normalizeMenuPayload = (args = []) => {
    const primary = Array.isArray(args) ? args[0] : args;
    const payload = primary && typeof primary === "object" ? { ...primary } : {};
    if (typeof payload.content === "string" && !payload.items) {
      const parsedContent = safeParseJson(payload.content, []);
      if (Array.isArray(parsedContent)) {
        payload.items = parsedContent;
      }
    }
    if (typeof payload.hotkey === "string") {
      payload.hotkeyMap = safeParseJson(payload.hotkey, {});
    }
    return payload;
  };

  const getFallbackAnchorRect = () => {
    const activeElement =
      document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    if (activeElement && typeof activeElement.getBoundingClientRect === "function") {
      const rect = activeElement.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        return rect;
      }
    }
    return {
      left: Math.max(12, window.innerWidth - 236),
      right: Math.max(12, window.innerWidth - 44),
      top: Math.max(12, window.innerHeight - 180),
      bottom: Math.max(12, window.innerHeight - 88),
      width: 192,
      height: 44
    };
  };

  const resolveAnchorPoint = () => {
    if (pointerState.hasValue) {
      return {
        x: pointerState.clientX,
        y: pointerState.clientY
      };
    }
    const rect = getFallbackAnchorRect();
    return {
      x: Math.min(window.innerWidth - 20, rect.right),
      y: Math.min(window.innerHeight - 20, rect.bottom)
    };
  };

  const clampMenuPosition = (panel, x, y) => {
    const margin = 12;
    const width = panel.offsetWidth || 188;
    const height = panel.offsetHeight || 40;
    const left = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - width - margin));
    const top = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - height - margin));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  };

  const dispatchSelection = (menuId, hotkey) => {
    const normalizedMenuId = menuId == null ? "" : String(menuId);
    const normalizedHotkey = hotkey == null ? "" : String(hotkey);
    window.setTimeout(() => {
      runRegisteredCallbacks("winhelper.onMenuClick", [normalizedMenuId, normalizedHotkey]);
    }, 0);
  };

  const closeActiveMenu = (result = null) => {
    if (!activeMenu) {
      return;
    }
    const { root, cleanup, resolve } = activeMenu;
    activeMenu = null;
    try {
      cleanup();
    } finally {
      root.replaceChildren();
      resolve(result);
    }
  };

  const buildMenuItemElement = (item, payload, closeMenu) => {
    if (!item || typeof item !== "object") {
      return null;
    }
    if (item.separator) {
      const separator = document.createElement("div");
      separator.className = "linux-popup-menu-separator";
      return separator;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "linux-popup-menu-item";
    const enabled =
      typeof item.enable === "boolean"
        ? item.enable
        : typeof item.enabled === "boolean"
          ? item.enabled
          : typeof item.disable === "boolean"
            ? !item.disable
            : typeof item.disabled === "boolean"
              ? !item.disabled
              : true;
    button.setAttribute("aria-disabled", enabled ? "false" : "true");

    const icon = document.createElement("span");
    icon.className = "linux-popup-menu-icon";
    if (typeof item.image_path === "string" && item.image_path) {
      const image = document.createElement("img");
      image.src = item.image_path;
      image.alt = "";
      icon.appendChild(image);
    }
    button.appendChild(icon);

    const label = document.createElement("span");
    label.className = "linux-popup-menu-label";
    label.textContent = typeof item.text === "string" ? item.text : "";
    button.appendChild(label);

    const children = Array.isArray(item.children) ? item.children.filter(Boolean) : [];
    if (children.length) {
      const caret = document.createElement("span");
      caret.className = "linux-popup-menu-caret";
      caret.textContent = "›";
      button.appendChild(caret);
    }

    if (!enabled) {
      button.tabIndex = -1;
      return button;
    }

    const selectedHotkey =
      item.hotkey ??
      item.shortcut ??
      item.accelerator ??
      payload?.hotkeyMap?.[String(item.menu_id ?? "")] ??
      "";

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (children.length) {
        return;
      }
      closeMenu({
        __nativeCallbackArgs: [item.menu_id ?? null, normalizeBridgeValue(item)]
      });
      dispatchSelection(item.menu_id, selectedHotkey);
    });

    return button;
  };

  const renderPopupMenu = (payload) =>
    new Promise((resolve) => {
      if (activeMenu) {
        closeActiveMenu(null);
      }
      ensureMenuStyle();
      const root = ensureRoot();
      root.replaceChildren();

      const backdrop = document.createElement("div");
      backdrop.className = "linux-popup-menu-backdrop";
      root.appendChild(backdrop);

      const panel = document.createElement("div");
      panel.className = "linux-popup-menu-panel";
      panel.setAttribute("role", "menu");
      root.appendChild(panel);

      const list = document.createElement("div");
      list.className = "linux-popup-menu-list";
      panel.appendChild(list);

      const items = resolveMenuItems(payload);
      for (const item of items) {
        const element = buildMenuItemElement(item, payload, closeActiveMenu);
        if (element) {
          list.appendChild(element);
        }
      }

      const focusFirstItem = () => {
        const firstButton = panel.querySelector(".linux-popup-menu-item[aria-disabled='false']");
        if (firstButton && typeof firstButton.focus === "function") {
          firstButton.focus();
        }
      };

      const handlePointerDown = (event) => {
        if (!panel.contains(event.target)) {
          closeActiveMenu(null);
        }
      };

      const handleKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeActiveMenu(null);
        }
      };

      const cleanup = () => {
        document.removeEventListener("pointerdown", handlePointerDown, true);
        document.removeEventListener("keydown", handleKeyDown, true);
      };

      activeMenu = {
        root,
        cleanup,
        resolve
      };

      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("keydown", handleKeyDown, true);

      requestAnimationFrame(() => {
        const anchor = resolveAnchorPoint();
        clampMenuPosition(panel, anchor.x - 16, anchor.y + 12);
        focusFirstItem();
      });

      backdrop.addEventListener("click", () => {
        closeActiveMenu(null);
      });
    });

  const localHandlers = {
    "winhelper.popupmenu": async (...args) => {
      const payload = normalizeMenuPayload(args);
      const items = resolveMenuItems(payload);
      if (!items.length) {
        return null;
      }
      return renderPopupMenu(payload);
    }
  };

  return {
    has(command) {
      return Boolean(localHandlers[String(command || "").toLowerCase()]);
    },
    async invoke(command, args = []) {
      const handler = localHandlers[String(command || "").toLowerCase()];
      if (!handler) {
        return undefined;
      }
      return handler(...(Array.isArray(args) ? args : [args]));
    }
  };
}

function createLocalAudioBridge() {
  let audioElement = null;
  let currentPlayId = "";
  let currentResumeOrPauseId = "";
  let currentSeekId = "";
  let progressTimer = null;
  let lastPayload = null;
  let lastVolume = 1;
  let lastPlaybackRate = 1;
  let pendingSeekSeconds = null;
  const preparedPlayableSourceCache = new Map();

  const PLAY_STATE = {
    play: 0,
    pause: 1,
    stop: 2
  };

  const ensureAudioElement = () => {
    if (audioElement) {
      return audioElement;
    }

    audioElement = document.createElement("audio");
    audioElement.preload = "auto";
    audioElement.style.display = "none";
    audioElement.volume = lastVolume;
    audioElement.playbackRate = lastPlaybackRate;
    audioElement.defaultPlaybackRate = lastPlaybackRate;

    const applyPendingSeek = () => {
      if (!audioElement || pendingSeekSeconds === null) {
        return;
      }
      if (!Number.isFinite(pendingSeekSeconds) || pendingSeekSeconds < 0) {
        pendingSeekSeconds = null;
        return;
      }
      if (audioElement.readyState < 1 || !Number.isFinite(audioElement.duration)) {
        return;
      }
      const boundedTime = Math.min(
        pendingSeekSeconds,
        audioElement.duration > 0 ? audioElement.duration : pendingSeekSeconds
      );
      pendingSeekSeconds = null;
      audioElement.currentTime = boundedTime;
    };

    const mount = () => {
      if (document.body && audioElement && !audioElement.isConnected) {
        document.body.appendChild(audioElement);
      }
    };

    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }

    const emitPlayProgress = (force = false) => {
      if (!audioElement || !currentPlayId) {
        return;
      }

      let cacheProgress = 0;
      try {
        if (audioElement.buffered.length > 0) {
          cacheProgress = audioElement.buffered.end(audioElement.buffered.length - 1);
        }
      } catch {
        cacheProgress = 0;
      }

      runRegisteredCallbacks("audioplayer.onPlayProgress", [
        currentPlayId,
        audioElement.currentTime,
        cacheProgress,
        force
      ]);
    };

    const startProgressTimer = () => {
      if (progressTimer) {
        return;
      }
      progressTimer = window.setInterval(() => {
        emitPlayProgress(false);
      }, 500);
    };

    const stopProgressTimer = () => {
      if (!progressTimer) {
        return;
      }
      window.clearInterval(progressTimer);
      progressTimer = null;
    };

    audioElement.addEventListener("loadedmetadata", () => {
      applyPendingSeek();
      runRegisteredCallbacks("audioplayer.onLoad", [
        currentPlayId,
        {
          code: 0,
          duration: audioElement?.duration || 0
        }
      ]);
      emitPlayProgress(true);
    });

    audioElement.addEventListener("error", () => {
      stopProgressTimer();
      const mediaError = audioElement?.error;
      runRegisteredCallbacks("audioplayer.onLoad", [
        currentPlayId,
        {
          code: mediaError?.code || -1,
          message: mediaError?.message || "audio-load-failed"
        }
      ]);
    });

    audioElement.addEventListener("play", () => {
      startProgressTimer();
      runRegisteredCallbacks("audioplayer.onBuffering", [currentPlayId, false]);
      runRegisteredCallbacks("audioplayer.onPlayState", [
        currentPlayId,
        currentResumeOrPauseId,
        PLAY_STATE.play
      ]);
    });

    audioElement.addEventListener("pause", () => {
      stopProgressTimer();
      const ended = Boolean(audioElement?.ended);
      runRegisteredCallbacks("audioplayer.onPlayState", [
        currentPlayId,
        currentResumeOrPauseId,
        ended ? PLAY_STATE.stop : PLAY_STATE.pause
      ]);
    });

    audioElement.addEventListener("ended", () => {
      stopProgressTimer();
      emitPlayProgress(true);
      runRegisteredCallbacks("audioplayer.onEnd", [
        currentPlayId,
        {
          code: 0
        }
      ]);
      runRegisteredCallbacks("audioplayer.onPlayState", [
        currentPlayId,
        currentResumeOrPauseId,
        PLAY_STATE.stop
      ]);
    });

    audioElement.addEventListener("waiting", () => {
      runRegisteredCallbacks("audioplayer.onBuffering", [currentPlayId, true]);
    });

    audioElement.addEventListener("stalled", () => {
      runRegisteredCallbacks("audioplayer.onBuffering", [currentPlayId, true]);
    });

    audioElement.addEventListener("playing", () => {
      runRegisteredCallbacks("audioplayer.onBuffering", [currentPlayId, false]);
    });

    audioElement.addEventListener("canplay", () => {
      applyPendingSeek();
    });

    audioElement.addEventListener("timeupdate", () => {
      emitPlayProgress(false);
    });

    audioElement.addEventListener("seeked", () => {
      runRegisteredCallbacks("audioplayer.onSeek", [
        currentPlayId,
        currentSeekId,
        0,
        audioElement?.currentTime || 0
      ]);
      emitPlayProgress(true);
    });

    return audioElement;
  };

  const toPreparedFileUrl = (filePath) => {
    if (!filePath) {
      return "";
    }
    try {
      return pathToFileURL(String(filePath)).toString();
    } catch {
      return "";
    }
  };

  const resolvePreparedPlayableSource = async (payload = {}) => {
    const directUrl = normalizePlayableUrl(readPlayableUrl(payload));
    if (!directUrl) {
      return "";
    }
    if (!shouldPrepareLocalPlayback(payload, directUrl)) {
      return directUrl;
    }

    const existingTask = preparedPlayableSourceCache.get(directUrl);
    if (existingTask) {
      return existingTask;
    }

    const prepareTask = invokeNative("linuxport.prepareaudio", [{ url: directUrl }])
      .then((filePath) => {
        const localUrl = toPreparedFileUrl(filePath);
        return localUrl || directUrl;
      })
      .catch((error) => {
        reportRendererError("prepare-lossless-audio-failed", {
          message: error?.message || String(error),
          url: directUrl
        });
        preparedPlayableSourceCache.delete(directUrl);
        return directUrl;
      });

    preparedPlayableSourceCache.set(directUrl, prepareTask);
    const resolved = await prepareTask;
    if (resolved === directUrl) {
      preparedPlayableSourceCache.delete(directUrl);
    }
    return resolved;
  };

  const localHandlers = {
    "audioplayer.load": async (playId, payload = {}) => {
      const audio = ensureAudioElement();
      const nextUrl = await resolvePreparedPlayableSource(payload);
      currentPlayId = String(playId || payload.playId || "");
      currentResumeOrPauseId = "";
      currentSeekId = "";
      lastPayload = payload && typeof payload === "object" ? { ...payload } : null;
      pendingSeekSeconds = null;

      if (!nextUrl) {
        runRegisteredCallbacks("audioplayer.onLoad", [
          currentPlayId,
          { code: -1, message: "missing-audio-url" }
        ]);
        return false;
      }

      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audio.src = nextUrl;
      audio.playbackRate = lastPlaybackRate;
      audio.defaultPlaybackRate = lastPlaybackRate;
      audio.currentTime = 0;
      audio.load();
      return true;
    },
    "audioplayer.play": async (playId, resumeOrPauseId = "") => {
      const audio = ensureAudioElement();
      currentPlayId = String(playId || currentPlayId || "");
      currentResumeOrPauseId = String(resumeOrPauseId || "");
      try {
        await audio.play();
        return true;
      } catch (error) {
        runRegisteredCallbacks("audioplayer.onLoad", [
          currentPlayId,
          {
            code: -1,
            message: error && error.message ? error.message : "audio-play-failed"
          }
        ]);
        return false;
      }
    },
    "audioplayer.pause": async (playId, resumeOrPauseId = "") => {
      const audio = ensureAudioElement();
      currentPlayId = String(playId || currentPlayId || "");
      currentResumeOrPauseId = String(resumeOrPauseId || "");
      audio.pause();
      return true;
    },
    "audioplayer.stop": async (playId = "") => {
      const audio = ensureAudioElement();
      currentPlayId = String(playId || currentPlayId || "");
      audio.pause();
      audio.currentTime = 0;
      runRegisteredCallbacks("audioplayer.onPlayState", [currentPlayId, "", PLAY_STATE.stop]);
      runRegisteredCallbacks("audioplayer.onEnd", [currentPlayId, { code: 0, stopped: true }]);
      return true;
    },
    "audioplayer.seek": async (playId, seekId = "", value = 0) => {
      const audio = ensureAudioElement();
      currentPlayId = String(playId || currentPlayId || "");
      currentSeekId = String(seekId || "");
      const nextTimeSeconds = Math.max(0, Number(value || 0));
      if (!Number.isFinite(nextTimeSeconds)) {
        runRegisteredCallbacks("audioplayer.onSeek", [currentPlayId, currentSeekId, -1, 0]);
        return false;
      }
      if (audio.readyState < 1 || !Number.isFinite(audio.duration)) {
        pendingSeekSeconds = nextTimeSeconds;
        return true;
      }
      pendingSeekSeconds = null;
      audio.currentTime = Math.min(
        nextTimeSeconds,
        audio.duration > 0 ? audio.duration : nextTimeSeconds
      );
      return true;
    },
    "audioplayer.preload": async (_playId, payload = {}) => {
      const audio = ensureAudioElement();
      const nextUrl = await resolvePreparedPlayableSource(payload);
      if (!nextUrl) {
        return false;
      }
      audio.preload = "auto";
      if (!audio.src) {
        audio.src = nextUrl;
        audio.load();
      }
      return true;
    },
    "audioplayer.setplaybackrate": async (...args) => {
      const audio = ensureAudioElement();
      let nextRateRaw = 1;
      for (let index = args.length - 1; index >= 0; index -= 1) {
        if (Number.isFinite(Number(args[index]))) {
          nextRateRaw = args[index];
          break;
        }
      }
      const nextRate = Number(nextRateRaw || 1);
      if (!Number.isFinite(nextRate) || nextRate <= 0) {
        return false;
      }
      lastPlaybackRate = nextRate;
      audio.playbackRate = nextRate;
      audio.defaultPlaybackRate = nextRate;
      return true;
    },
    "audioplayer.setvolume": async (_playId, _volumeId, value = 100) => {
      const audio = ensureAudioElement();
      const nextVolume = Math.max(0, Math.min(1, Number(value || 0) / 100));
      lastVolume = Number.isFinite(nextVolume) ? nextVolume : lastVolume;
      audio.volume = lastVolume;
      runRegisteredCallbacks("audioplayer.onVolume", [
        currentPlayId,
        "",
        0,
        Math.round(lastVolume * 100)
      ]);
      return true;
    },
    "audioplayer.getplayedtime": async () => {
      const audio = ensureAudioElement();
      return audio.currentTime || 0;
    },
    "audioplayer.getplaybackinfo": async () => {
      const audio = ensureAudioElement();
      return {
        playId: currentPlayId,
        current: audio.currentTime || 0,
        duration: audio.duration || 0,
        paused: audio.paused,
        ended: audio.ended,
        src: audio.currentSrc || audio.src || "",
        payload: lastPayload
      };
    }
  };

  return {
    has(command) {
      return Boolean(localHandlers[String(command || "").toLowerCase()]);
    },
    async invoke(command, args = []) {
      const handler = localHandlers[String(command || "").toLowerCase()];
      if (!handler) {
        return undefined;
      }
      return handler(...(Array.isArray(args) ? args : [args]));
    }
  };
}

function normalizeStoredValue(key, value) {
  if (key === "setting") {
    const next = {
      ...bootstrapLocalStorageDefaults.setting,
      ...(value && typeof value === "object" ? value : {})
    };
    next.downloadDir = normalizePathValue(next.downloadDir);
    next.cacheDir = normalizePathValue(next.cacheDir);
    next.oldCacheDir = normalizePathValue(next.oldCacheDir);
    if (typeof next.cacheCapacity !== "number") {
      next.cacheCapacity = 1;
    }
    return next;
  }

  if (key === "NM_SETTING_CUSTOM") {
    const next = {
      ...bootstrapLocalStorageDefaults.NM_SETTING_CUSTOM,
      ...(value && typeof value === "object" ? value : {})
    };
    const storage = next.storage && typeof next.storage === "object" ? next.storage : {};
    next.storage = {
      ...storage,
      path: normalizePathValue(storage.path)
    };
    const quantity = next.quantity && typeof next.quantity === "object" ? next.quantity : {};
    next.quantity = {
      fileNameType: Number.isFinite(Number(quantity.fileNameType))
        ? Number(quantity.fileNameType)
        : 0,
      pathNameType: Number.isFinite(Number(quantity.pathNameType))
        ? Number(quantity.pathNameType)
        : 0
    };
    return next;
  }

  if (key === "appLayout" || key === "sidebar" || key === "v2tov3UpgradeFlag") {
    return {
      ...bootstrapLocalStorageDefaults[key],
      ...(value && typeof value === "object" ? value : {})
    };
  }

  return value;
}

function seedLocalStorageDefaults() {
  try {
    if (!window.localStorage) {
      return;
    }
    for (const [key, value] of Object.entries(bootstrapLocalStorageDefaults)) {
      const current = window.localStorage.getItem(key);
      if (current === null || current === "" || current === "null" || current === "undefined") {
        window.localStorage.setItem(key, JSON.stringify(value));
        continue;
      }
      const parsed = safeParseJson(current, value);
      const normalized = normalizeStoredValue(key, parsed);
      window.localStorage.setItem(key, JSON.stringify(normalized));
    }
  } catch (error) {
    reportRendererError("bootstrap-localstorage-failed", {
      message: error.message,
      stack: error.stack || null
    });
  }
}

function buildSessionBootstrapStorageEntries(bootstrap = {}) {
  const entries = [];
  const host = bootstrap && typeof bootstrap.host === "object" ? bootstrap.host : null;
  const cookies = Array.isArray(bootstrap?.cookies) ? bootstrap.cookies : [];
  const vipInfo = bootstrap && typeof bootstrap.vipInfo === "object" ? bootstrap.vipInfo : null;

  if (host && host.uid) {
    entries.push(["stateHost", JSON.stringify(host)]);
  }

  if (cookies.length > 0) {
    const cookiesJson = JSON.stringify(cookies);
    entries.push(["autoLoginCookies", cookiesJson]);
    entries.push(["autoLoginCookies@music.163.com", cookiesJson]);
    entries.push(["autoLoginCookies@http://music.163.com", cookiesJson]);
    entries.push(["autoLoginCookies@https://music.163.com", cookiesJson]);
  }

  if (vipInfo) {
    entries.push(["vipInfo", JSON.stringify(vipInfo)]);
  }

  return entries;
}

function applySessionBootstrapToLocalStorage(bootstrap = {}) {
  try {
    if (!window.localStorage) {
      return false;
    }

    let touched = false;
    for (const [key, value] of buildSessionBootstrapStorageEntries(bootstrap)) {
      if (!key || typeof value !== "string" || !value) {
        continue;
      }
      if (window.localStorage.getItem(key) !== value) {
        window.localStorage.setItem(key, value);
        touched = true;
      }
    }
    window.__NETEASE_SESSION_BOOTSTRAP__ = normalizeBridgeValue(bootstrap);
    return touched;
  } catch (error) {
    reportRendererError("bootstrap-session-localstorage-failed", {
      message: error.message,
      stack: error.stack || null
    });
    return false;
  }
}

function installSessionBootstrapBridge() {
  const applyBootstrap = (payload) => {
    const normalized = normalizeBridgeValue(payload);
    const touched = applySessionBootstrapToLocalStorage(normalized);
    if (normalized?.host?.uid) {
      invokeNative("app.syncsessionhost", [normalized.host]).catch((error) => {
        reportRendererError("bootstrap-session-sync-host-failed", {
          message: error.message,
          stack: error.stack || null
        });
      });
    }
    reportRendererInfo("bootstrap-session-applied", {
      touched,
      hostUid: normalized?.host?.uid || "",
      cookieCount: Array.isArray(normalized?.cookies) ? normalized.cookies.length : 0,
      hasVipInfo: Boolean(normalized?.vipInfo)
    });
  };

  invokeNative("app.getsessionbootstrap", [])
    .then((payload) => {
      if (payload && typeof payload === "object") {
        applyBootstrap(payload);
      }
    })
    .catch((error) => {
      reportRendererError("bootstrap-session-fetch-failed", {
        message: error.message,
        stack: error.stack || null
      });
    });

  channel.registerCall("session.bootstrap.updated", (payload) => {
    applyBootstrap(payload);
  });
}

function normalizeFetchHeaders(headers) {
  if (!headers) {
    return {};
  }
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
}

function normalizeFetchBody(body) {
  if (typeof body === "undefined" || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return new URLSearchParams(Array.from(body.entries())).toString();
  }
  return body;
}

function shouldUseNativeFetch(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) {
    return false;
  }
  if (rawUrl.startsWith("/api/")) {
    return true;
  }
  if (!/^https?:\/\//i.test(rawUrl)) {
    return false;
  }
  try {
    const url = new URL(rawUrl);
    return (
      url.hostname.endsWith(".music.163.com") ||
      url.hostname === "music.163.com" ||
      url.hostname.endsWith(".126.net") ||
      url.hostname.endsWith(".netease.com")
    );
  } catch {
    return false;
  }
}

function resolveNativeFetchUrl(rawUrl) {
  if (typeof rawUrl !== "string") {
    return "";
  }
  if (rawUrl.startsWith("/api/")) {
    return `https://interfacepc.music.163.com${rawUrl}`;
  }
  return rawUrl;
}

function installFetchBridge() {
  if (typeof window.fetch !== "function") {
    return;
  }

  const originalFetch = window.fetch.bind(window);
  const bridgedFetch = async (input, init = {}) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input && typeof input === "object" && "url" in input
          ? String(input.url)
          : "";

    if (!shouldUseNativeFetch(requestUrl)) {
      return originalFetch(input, init);
    }

    const requestInit =
      typeof input === "object" && input && "method" in input
        ? {
            method: input.method,
            headers: normalizeFetchHeaders(input.headers),
            body: normalizeFetchBody(input.body),
            ...init,
            headers: {
              ...normalizeFetchHeaders(input.headers),
              ...normalizeFetchHeaders(init.headers)
            }
          }
        : {
            ...init,
            headers: normalizeFetchHeaders(init.headers),
            body: normalizeFetchBody(init.body)
          };

    const payload = {
      url: resolveNativeFetchUrl(requestUrl),
      options: {
        method: requestInit.method || "GET",
        headers: requestInit.headers,
        body: normalizeFetchBody(requestInit.body)
      }
    };

    const result = await invokeNative("network.fetch", [payload]);
    const normalizedResult =
      result &&
      typeof result === "object" &&
      Array.isArray(result.__nativeCallbackArgs)
        ? {
            text: result.__nativeCallbackArgs[0] || "",
            status: result.__nativeCallbackArgs[1] || 500,
            headers: result.__nativeCallbackArgs[2] || {}
          }
        : result &&
            typeof result === "object" &&
            typeof result.blob === "string"
          ? {
              text: result.blob,
              status: result.status || 500,
              headers: result.headers || {}
            }
          : result;
    return new Response(normalizedResult?.text ?? "", {
      status: normalizedResult?.status || 500,
      headers: normalizedResult?.headers || {}
    });
  };

  window.fetch = bridgedFetch;
  globalThis.fetch = bridgedFetch;
}

function resolveWebpackRequire() {
  if (typeof window.__webpack_require__ === "function") {
    return window.__webpack_require__;
  }

  return null;
}

function readStoreFromCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  if (
    typeof candidate.getStore === "function" &&
    typeof candidate.getDispatch === "function"
  ) {
    try {
      const sampleState = candidate.getStore();
      const sampleDispatch = candidate.getDispatch();
      if (
        sampleState &&
        typeof sampleState === "object" &&
        typeof sampleDispatch === "function"
      ) {
        return {
          getState() {
            return candidate.getStore() || {};
          },
          dispatch(action) {
            return candidate.getDispatch()(action);
          }
        };
      }
    } catch {}
  }

  const possibleStores = [
    candidate,
    candidate._store,
    candidate.store,
    candidate.app?._store,
    candidate.app?.store
  ];

  for (const store of possibleStores) {
    if (
      store &&
      typeof store.getState === "function" &&
      typeof store.dispatch === "function"
    ) {
      return store;
    }
  }

  if (typeof candidate.getAppContext === "function") {
    try {
      const appContext = candidate.getAppContext();
      const store = readStoreFromCandidate(appContext);
      if (store) {
        return store;
      }
    } catch {}
  }

  return null;
}

function resolveAppStoreFromWebpackCache(req) {
  const moduleCache = req?.c;
  if (!moduleCache || typeof moduleCache !== "object") {
    return null;
  }

  for (const cachedModule of Object.values(moduleCache)) {
    const exportsObject = cachedModule?.exports;
    const store =
      readStoreFromCandidate(exportsObject) ||
      readStoreFromCandidate(exportsObject?.default) ||
      readStoreFromCandidate(exportsObject?.a);
    if (store) {
      return store;
    }
  }

  return null;
}

function resolveAppStoreFromWindowGlobals() {
  const globalCandidates = [];

  if (window.__NETEASE_APP_STORE__) {
    globalCandidates.push(window.__NETEASE_APP_STORE__);
  }
  if (window.__NETEASE_APP_CONTEXT__) {
    globalCandidates.push(window.__NETEASE_APP_CONTEXT__);
  }
  if (window.__NETEASE_LINUX_PORT__?.appStore) {
    globalCandidates.push(window.__NETEASE_LINUX_PORT__.appStore);
  }
  if (window.__NETEASE_LINUX_PORT__?.app) {
    globalCandidates.push(window.__NETEASE_LINUX_PORT__.app);
  }
  if (window.g_app) {
    globalCandidates.push(window.g_app);
  }
  if (window.__INITIAL_STATE__) {
    globalCandidates.push(window.__INITIAL_STATE__);
  }

  for (const key of Object.getOwnPropertyNames(window)) {
    if (key === "window" || key === "self" || key === "globalThis") {
      continue;
    }
    let value = null;
    try {
      value = window[key];
    } catch {
      continue;
    }
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      continue;
    }
    globalCandidates.push(value);
  }

  for (const candidate of globalCandidates) {
    const store =
      readStoreFromCandidate(candidate) ||
      readStoreFromCandidate(candidate?.default) ||
      readStoreFromCandidate(candidate?.a);
    if (store) {
      return store;
    }
  }

  return null;
}

function resolveAppStore() {
  try {
    const globalStore = resolveAppStoreFromWindowGlobals();
    if (globalStore) {
      return globalStore;
    }
    const req = resolveWebpackRequire();
    if (!req) {
      return null;
    }
    return resolveAppStoreFromWebpackCache(req);
  } catch (error) {
    reportRendererError("bootstrap-store-probe-failed", {
      message: error.message,
      stack: error.stack || null
    });
    return null;
  }
}

function installRendererCompatibilityBootstrap() {
  if (window.__NETEASE_LINUX_BOOTSTRAP_STARTED__) {
    return;
  }
  window.__NETEASE_LINUX_BOOTSTRAP_STARTED__ = true;

  const startAt = Date.now();
  let attempts = 0;
  let lastStage = "init";

  const dispatchIfAvailable = (store, action) => {
    try {
      store.dispatch(action);
      return true;
    } catch (error) {
      reportRendererError("bootstrap-dispatch-failed", {
        action: action?.type || "",
        message: error.message,
        stack: error.stack || null
      });
      return false;
    }
  };

  const tick = () => {
    attempts += 1;
    const store = resolveAppStore();
    if (!store) {
      lastStage = "no-store";
      if (attempts === 1 || attempts % 5 === 0) {
        reportRendererInfo("bootstrap-wait-store", { attempts });
      }
      if (attempts >= 30) {
        reportRendererError("bootstrap-store-timeout", {
          attempts,
          elapsedMs: Date.now() - startAt,
          lastStage
        });
        clearInterval(timer);
      }
      return;
    }

    const state = store.getState() || {};
    const host = state.host || null;
    if (!host) {
      lastStage = "no-host";
      return;
    }

    const essential = state["page:essential"] || {};
    const homePage = state["page:homePage"] || {};
    const vipEssential = state["page:vipEssential"] || {};
    const playlistSquare = state["page:playlistsquare"] || {};
    let touched = false;
    const sessionBootstrap =
      window.__NETEASE_SESSION_BOOTSTRAP__ &&
      typeof window.__NETEASE_SESSION_BOOTSTRAP__ === "object"
        ? window.__NETEASE_SESSION_BOOTSTRAP__
        : null;

    if (
      sessionBootstrap?.host?.uid &&
      (host.isAnonymous || !host.uid || String(host.uid) !== String(sessionBootstrap.host.uid)) &&
      !window.__NETEASE_SESSION_BOOTSTRAP_SWITCH_SENT__
    ) {
      lastStage = "host-switch";
      window.__NETEASE_SESSION_BOOTSTRAP_SWITCH_SENT__ = true;
      touched =
        dispatchIfAvailable(store, {
          type: "host/switchUser",
          payload: {
            host: sessionBootstrap.host,
            isAutoLogin: true
          }
        }) || touched;
    }

    if (!window.__NETEASE_LINUX_BOOTSTRAP_LOGGED_STORE__) {
      window.__NETEASE_LINUX_BOOTSTRAP_LOGGED_STORE__ = true;
      reportRendererInfo("bootstrap-store-ready", {
        attempts,
        hostUid: host.uid || "",
        hostIsAnonymous: Boolean(host.isAnonymous),
        hostCreateAnonimousFailed: Boolean(host.createAnonimousFailed),
        storeKeys: Object.keys(state).slice(0, 50)
      });
    }

    if (!host.uid && !host.createAnonimousFailed) {
      lastStage = "unlock-guest";
      touched =
        dispatchIfAvailable(store, {
          type: "host/onUpdate",
          payload: {
            createAnonimousFailed: true
          }
        }) || touched;
    }

    if (!essential.banners?.length) {
      lastStage = "essential-banners";
      touched = dispatchIfAvailable(store, { type: "page:essential/getBanners" }) || touched;
    }

    if (!essential.hasFetched && !essential.isFetching) {
      lastStage = "essential-blocks";
      touched =
        dispatchIfAvailable(store, {
          type: "page:essential/fetchBlocksData",
          payload: { notifyError: false }
        }) || touched;
    }

    if (!vipEssential.hasFetched && !vipEssential.isFetching) {
      lastStage = "vip-essential";
      touched =
        dispatchIfAvailable(store, {
          type: "page:vipEssential/fetchData",
          payload: {}
        }) || touched;
    }

    if (!playlistSquare.playlistTags?.length && !playlistSquare.isFetching) {
      lastStage = "playlist-square";
      touched =
        dispatchIfAvailable(store, {
          type: "page:playlistsquare/fetchBlocksData",
          payload: {}
        }) || touched;
    }

    if (homePage.isFetchLoading || !homePage.lastRefreshTime) {
      lastStage = "home-page";
      touched =
        dispatchIfAvailable(store, {
          type: "page:homePage/fetchBlocksData",
          payload: { notifyError: false }
        }) || touched;
      touched =
        dispatchIfAvailable(store, {
          type: "page:homePage/fetchHomePageAllResourceDatas",
          payload: { notifyError: false }
        }) || touched;
    }

    const latestState = store.getState() || {};
    const latestEssential = latestState["page:essential"] || {};
    const latestHomePage = latestState["page:homePage"] || {};
    const latestVipEssential = latestState["page:vipEssential"] || {};
    const bootstrapCompleted =
      Boolean((latestEssential.hasFetched || latestEssential.isFetching)) &&
      Boolean(
        (!latestHomePage.isFetchLoading && latestHomePage.lastRefreshTime) ||
          latestHomePage.lastRefreshTimeEcpm ||
          latestHomePage.isFetchError ||
          latestHomePage.isFetchErrorEcpm
      ) &&
      Boolean(
        latestVipEssential.hasFetched ||
          latestVipEssential.isFetching ||
          latestVipEssential.isFetchingError
      );

    if (touched || bootstrapCompleted || attempts === 1 || attempts % 5 === 0) {
      reportRendererInfo("bootstrap-tick", {
        attempts,
        elapsedMs: Date.now() - startAt,
        stage: lastStage,
        touched,
        hostUid: latestState.host?.uid || "",
        hostCreateAnonimousFailed: Boolean(latestState.host?.createAnonimousFailed),
        essentialHasFetched: Boolean(latestEssential.hasFetched),
        essentialIsFetching: Boolean(latestEssential.isFetching),
        homePageLastRefreshTime: latestHomePage.lastRefreshTime || 0,
        homePageIsFetchLoading: Boolean(latestHomePage.isFetchLoading),
        homePageLastRefreshTimeEcpm: latestHomePage.lastRefreshTimeEcpm || 0,
        homePageIsFetchError: Boolean(latestHomePage.isFetchError),
        vipEssentialHasFetched: Boolean(latestVipEssential.hasFetched),
        vipEssentialIsFetching: Boolean(latestVipEssential.isFetching),
        playlistTagCount: Array.isArray((latestState["page:playlistsquare"] || {}).playlistTags)
          ? latestState["page:playlistsquare"].playlistTags.length
          : 0
      });
    }

    if (bootstrapCompleted || attempts >= 30) {
      clearInterval(timer);
      reportRendererInfo("bootstrap-finished", {
        attempts,
        elapsedMs: Date.now() - startAt,
        completed: bootstrapCompleted,
        stage: lastStage
      });
    }
  };

  const timer = setInterval(tick, 500);
  window.addEventListener("load", tick, { once: true });
  setTimeout(tick, 0);
}

function installReactDomProbe() {
  if (!process.env.NETEASE_DEBUG_BOOT) {
    return;
  }

  let reactDomValue = null;
  Object.defineProperty(window, "ReactDOM", {
    configurable: true,
    enumerable: true,
    get() {
      return reactDomValue;
    },
    set(value) {
      if (!value || typeof value.render !== "function") {
        reactDomValue = value;
        return;
      }

      reactDomValue = new Proxy(value, {
        get(target, prop, receiver) {
          if (prop === "render") {
            return function wrappedRender(...args) {
              try {
                const container = args[1];
                console.log("[reactdom.render:start]", {
                  containerId: container?.id || null,
                  containerTag: container?.tagName || null,
                  argCount: args.length
                });
                const result = target.render.apply(target, args);
                console.log("[reactdom.render:ok]");
                return result;
              } catch (error) {
                console.error("[reactdom.render:failed]", error);
                throw error;
              }
            };
          }
          return Reflect.get(target, prop, receiver);
        }
      });
      console.log("[reactdom.probe:installed]");
    }
  });
}

const localAudioBridge = createLocalAudioBridge();
const localPopupMenuBridge = createLocalPopupMenuBridge();

const bridge = {
  call(name, ...args) {
    if (localAudioBridge.has(name)) {
      return Promise.resolve(localAudioBridge.invoke(name, args)).then((result) =>
        normalizeBridgeValue(result)
      );
    }
    if (localPopupMenuBridge.has(name)) {
      return Promise.resolve(localPopupMenuBridge.invoke(name, args)).then((result) => {
        if (
          result &&
          typeof result === "object" &&
          Array.isArray(result.__nativeCallbackArgs)
        ) {
          return normalizeBridgeValue(result.__nativeCallbackArgs[0]);
        }
        return normalizeBridgeValue(result);
      });
    }
    return invokeNative(name, args).then((result) => {
      if (
        result &&
        typeof result === "object" &&
        Array.isArray(result.__nativeCallbackArgs)
      ) {
        return normalizeBridgeValue(result.__nativeCallbackArgs[0]);
      }
      return normalizeBridgeValue(result);
    });
  },
  fillRegisterCallIfEmpty(name, namespace, callback) {
    const eventName = toBridgeEventName(name, namespace);
    if (!eventName || typeof callback !== "function" || registeredCallbacks.has(eventName)) {
      return false;
    }
    if (/^download\.|^storage\./.test(eventName)) {
      console.log("[bridge:register:fill]", eventName);
    }
    registeredCallbacks.set(eventName, callback);
    return true;
  },
  overwriteRegisterCall(name, namespace, callback) {
    const eventName = toBridgeEventName(name, namespace);
    if (!eventName || typeof callback !== "function") {
      return false;
    }
    if (/^download\.|^storage\./.test(eventName)) {
      console.log("[bridge:register:overwrite]", eventName);
    }
    registeredCallbacks.set(eventName, callback);
    return true;
  },
  appendRegisterCall(name, namespace, callback) {
    const eventName = toBridgeEventName(name, namespace);
    if (!eventName || typeof callback !== "function") {
      return false;
    }
    if (/^download\.|^storage\./.test(eventName)) {
      console.log("[bridge:register:append]", eventName);
    }
    const existing = registeredCallbacks.get(eventName);
    if (!existing) {
      registeredCallbacks.set(eventName, callback);
      return true;
    }
    if (Array.isArray(existing)) {
      existing.push(callback);
      return true;
    }
    registeredCallbacks.set(eventName, [existing, callback]);
    return true;
  },
  removeRegisterCall(name, namespace, callback) {
    const eventName = toBridgeEventName(name, namespace);
    if (!eventName) {
      return false;
    }
    if (/^download\.|^storage\./.test(eventName)) {
      console.log("[bridge:register:remove]", eventName);
    }
    const existing = registeredCallbacks.get(eventName);
    if (!existing) {
      return false;
    }
    if (!callback) {
      registeredCallbacks.delete(eventName);
      return true;
    }
    if (Array.isArray(existing)) {
      const next = existing.filter((entry) => entry !== callback);
      if (next.length === 0) {
        registeredCallbacks.delete(eventName);
      } else if (next.length === 1) {
        registeredCallbacks.set(eventName, next[0]);
      } else {
        registeredCallbacks.set(eventName, next);
      }
      return true;
    }
    if (existing === callback) {
      registeredCallbacks.delete(eventName);
      return true;
    }
    return false;
  }
};

function subscribeDownloadProcess(callback) {
  if (typeof callback !== "function") {
    return () => {};
  }

  const handler = (event) => {
    callback(event?.detail);
  };

  window.addEventListener(DOWNLOAD_PROCESS_EVENT, handler);
  return () => {
    window.removeEventListener(DOWNLOAD_PROCESS_EVENT, handler);
  };
}

const channel = {
  call(name, callback, argsLike) {
    const args = Array.isArray(argsLike) ? argsLike : Array.from(argsLike || []);
    if (localAudioBridge.has(name)) {
      Promise.resolve(localAudioBridge.invoke(name, args))
        .then((result) => {
          if (typeof callback === "function") {
            callback(normalizeBridgeValue(result));
          }
        })
        .catch((error) => {
          console.error("[channel.call:local]", name, error);
          if (typeof callback === "function") {
            callback(null);
          }
        });
      return;
    }
    if (localPopupMenuBridge.has(name)) {
      Promise.resolve(localPopupMenuBridge.invoke(name, args))
        .then((result) => {
          if (typeof callback === "function") {
            if (
              result &&
              typeof result === "object" &&
              Array.isArray(result.__nativeCallbackArgs)
            ) {
              callback(...normalizeBridgeValue(result.__nativeCallbackArgs));
              return;
            }
            callback(normalizeBridgeValue(result));
          }
        })
        .catch((error) => {
          console.error("[channel.call:local-menu]", name, error);
          if (typeof callback === "function") {
            callback(null);
          }
        });
      return;
    }

    invokeNative(name, args)
      .then((result) => {
        if (typeof callback === "function") {
          if (
            result &&
            typeof result === "object" &&
            Array.isArray(result.__nativeCallbackArgs)
          ) {
            callback(...normalizeBridgeValue(result.__nativeCallbackArgs));
            return;
          }
          callback(normalizeBridgeValue(result));
        }
      })
      .catch((error) => {
        console.error("[channel.call]", name, error);
        if (typeof callback === "function") {
          callback(null);
        }
      });
  },
  registerCall(name, callback) {
    if (!name || typeof callback !== "function") {
      return false;
    }
    if (/^download\.|^storage\./.test(String(name))) {
      console.log("[channel:register]", name);
    }

    const existing = registeredCallbacks.get(name);
    if (!existing) {
      registeredCallbacks.set(name, callback);
      return true;
    }

    if (Array.isArray(existing)) {
      existing.push(callback);
      return true;
    }

    registeredCallbacks.set(name, [existing, callback]);
    return true;
  },
  viewCall() {
    return true;
  },
  encodeAnonymousId(value) {
    return value;
  },
  encodeAnonymousId2(value) {
    return value;
  },
  encryptId(value) {
    return value;
  },
  serialData(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  },
  serialData2(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  },
  deSerialData(value) {
    return normalizeBridgeValue(value);
  },
  serialKey(value) {
    return String(value || "");
  },
  enData(value) {
    return value;
  },
  deData(value) {
    return normalizeBridgeValue(value);
  },
  oldLocalStorageData() {
    return "{}";
  }
};

// The app runtime may try to wrap registerCall with a legacy stub layer.
// Keep the original multi-listener behavior from preload instead.
channel.registerCall.__HACKED__ = true;

window.channel = channel;
window.Bridge = bridge;
window.__NETEASE_LINUX_PORT__ = {
  channel,
  invokeNative,
  Bridge: bridge,
  subscribeDownloadProcess
};

seedLocalStorageDefaults();
installSessionBootstrapBridge();
installFetchBridge();
installWebpackChunkPatch();
installRendererCompatibilityBootstrap();
installReactDomProbe();

window.addEventListener("error", (event) => {
  reportRendererError("error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    stack: event.error && event.error.stack ? event.error.stack : null
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportRendererError("unhandledrejection", {
    message: reason && reason.message ? reason.message : String(reason),
    stack: reason && reason.stack ? reason.stack : null
  });
});

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld("channel", channel);
  contextBridge.exposeInMainWorld("Bridge", bridge);
  contextBridge.exposeInMainWorld("__NETEASE_LINUX_PORT__", window.__NETEASE_LINUX_PORT__);
}
