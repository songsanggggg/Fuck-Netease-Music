"use strict";

const { BrowserWindow, shell } = require("electron");

function createWindowManager(options) {
  const {
    ORPHEUS_SCHEME,
    sharedWebPreferences,
    appIconPath,
    appTitle = "NetEase Cloud Music Linux Port",
    appBackgroundColor = "#1a1d21",
    auxiliaryBackgroundColor = "#1a1d21",
    revealMainWindow,
    injectRendererCompatibilityBootstrap,
    runBootDiagnostics,
    nativeApiRef
  } = options;

  let mainWindow = null;
  const childWindows = new Set();
  const childWindowsByKey = new Map();

  function parseWindowFeatures(features = "") {
    const entries = {};
    for (const item of String(features || "").split(",")) {
      const [rawKey, rawValue] = item.split("=");
      const key = String(rawKey || "").trim();
      if (!key) {
        continue;
      }
      entries[key] = String(rawValue || "").trim();
    }

    const numberOrUndefined = (value) => {
      if (!value) {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
    };

    return {
      width: numberOrUndefined(entries.width),
      height: numberOrUndefined(entries.height),
      x: numberOrUndefined(entries.left ?? entries.x),
      y: numberOrUndefined(entries.top ?? entries.y)
    };
  }

  function wireExternalNavigation(win) {
    const openExternalUrl = (targetUrl) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(String(targetUrl || ""));
      } catch {
        console.warn("[external:navigate:invalid-url]", targetUrl);
        return;
      }

      if (!["http:", "https:", "mailto:"].includes(parsedUrl.protocol)) {
        console.warn("[external:navigate:blocked-protocol]", parsedUrl.protocol, targetUrl);
        return;
      }

      void shell.openExternal(parsedUrl.toString()).catch((error) => {
        console.error("[external:navigate:failed]", parsedUrl.toString(), error);
      });
    };

    win.webContents.setWindowOpenHandler(({ url, features }) => {
      if (url.startsWith(`${ORPHEUS_SCHEME}://`)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            width: 440,
            height: 720,
            minWidth: 360,
            minHeight: 320,
            icon: appIconPath,
            autoHideMenuBar: true,
            backgroundColor: auxiliaryBackgroundColor,
            parent: win,
            modal: false,
            show: true,
            webPreferences: {
              ...sharedWebPreferences
            },
            ...parseWindowFeatures(features)
          }
        };
      }

      openExternalUrl(url);
      return { action: "deny" };
    });

    win.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(`${ORPHEUS_SCHEME}://`)) {
        event.preventDefault();
        openExternalUrl(url);
      }
    });
  }

  function wireAuxiliaryWindow(win) {
    if (!win || win.isDestroyed()) {
      return;
    }

    childWindows.add(win);
    wireExternalNavigation(win);

    win.webContents.on("did-create-window", (childWin) => {
      wireAuxiliaryWindow(childWin);
    });

    win.on("closed", () => {
      childWindows.delete(win);
      for (const [key, candidate] of childWindowsByKey.entries()) {
        if (candidate === win) {
          childWindowsByKey.delete(key);
        }
      }
    });
  }

  function getWindowKeyFromUrl(rawUrl) {
    try {
      const target = new URL(rawUrl);
      return target.searchParams.get("uuid") || target.searchParams.get("main") || rawUrl;
    } catch {
      return rawUrl;
    }
  }

  function createAuxiliaryWindow({ url, bounds = {}, options: windowOptions = {}, parentWindow = null }) {
    const key = getWindowKeyFromUrl(url);
    const existingWindow = childWindowsByKey.get(key);
    if (existingWindow && !existingWindow.isDestroyed()) {
      existingWindow.loadURL(url);
      if (windowOptions.visible !== false) {
        existingWindow.show();
        existingWindow.focus();
      }
      return {
        id: existingWindow.id,
        key
      };
    }

    const win = new BrowserWindow({
      width: Math.max(320, Math.round(bounds.width || 440)),
      height: Math.max(240, Math.round(bounds.height || 720)),
      x: Number.isFinite(Number(bounds.x)) ? Math.round(bounds.x) : undefined,
      y: Number.isFinite(Number(bounds.y)) ? Math.round(bounds.y) : undefined,
      show: windowOptions.visible !== false,
      resizable: windowOptions.resizable !== false,
      minimizable: false,
      maximizable: windowOptions.resizable !== false,
      skipTaskbar: windowOptions.taskbarButton === false,
      autoHideMenuBar: true,
      icon: appIconPath,
      backgroundColor: windowOptions.bk_color || auxiliaryBackgroundColor,
      parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : mainWindow,
      modal: Boolean(windowOptions.spec_window),
      webPreferences: {
        ...sharedWebPreferences
      }
    });

    childWindowsByKey.set(key, win);
    wireAuxiliaryWindow(win);
    win.loadURL(url);

    return {
      id: win.id,
      key
    };
  }

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      show: false,
      autoHideMenuBar: true,
      icon: appIconPath,
      title: appTitle,
      backgroundColor: appBackgroundColor,
      webPreferences: {
        ...sharedWebPreferences
      }
    });

    wireExternalNavigation(mainWindow);

    mainWindow.on("enter-full-screen", () => {
      nativeApiRef()?.emitNativeEvent("winhelper.onFullscreenChange", true);
    });
    mainWindow.on("leave-full-screen", () => {
      nativeApiRef()?.emitNativeEvent("winhelper.onFullscreenChange", false);
    });
    mainWindow.on("close", (event) => {
      const nativeApi = nativeApiRef();
      if (nativeApi?.shouldHideOnClose?.()) {
        event.preventDefault();
        mainWindow.hide();
      } else {
        nativeApi?.emitNativeEvent("winhelper.onSystemRequestCloseWindow");
        nativeApi?.emitNativeEvent("winhelper.onClose");
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
      console.error("[load-failed]", errorCode, errorDescription, validatedURL);
      revealMainWindow(mainWindow);
    });

    mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
    });

    mainWindow.webContents.on("did-create-window", (win) => {
      wireAuxiliaryWindow(win);
    });

    if (process.env.NETEASE_DEBUG_BOOT) {
      mainWindow.webContents.on("did-start-loading", () => {
        console.log("[webContents] did-start-loading");
      });
      mainWindow.webContents.on("did-stop-loading", () => {
        console.log("[webContents] did-stop-loading");
      });
      mainWindow.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        console.log("[webContents] did-frame-finish-load", {
          isMainFrame,
          frameProcessId,
          frameRoutingId,
          url: mainWindow.webContents.getURL()
        });
      });
      mainWindow.webContents.on("render-process-gone", (_event, details) => {
        console.error("[webContents] render-process-gone", details);
      });
    }

    mainWindow.webContents.on("dom-ready", () => {
      revealMainWindow(mainWindow);
      injectRendererCompatibilityBootstrap(mainWindow);
      setTimeout(() => injectRendererCompatibilityBootstrap(mainWindow), 3000);
      setTimeout(() => injectRendererCompatibilityBootstrap(mainWindow), 8000);
      setTimeout(() => injectRendererCompatibilityBootstrap(mainWindow), 12000);
    });

    mainWindow.webContents.once("did-finish-load", () => {
      revealMainWindow(mainWindow);
      injectRendererCompatibilityBootstrap(mainWindow);
    });

    setTimeout(() => {
      revealMainWindow(mainWindow);
    }, 3000);

    setTimeout(() => {
      runBootDiagnostics(mainWindow);
    }, 10000);

    mainWindow.loadURL(`${ORPHEUS_SCHEME}://orpheus/pub/app.html`);
    return mainWindow;
  }

  function closeChildWindows() {
    for (const win of [...childWindows]) {
      if (win && !win.isDestroyed()) {
        win.close();
      }
    }
  }

  return {
    createAuxiliaryWindow,
    createMainWindow,
    closeChildWindows,
    getMainWindow() {
      return mainWindow;
    },
    hasMainWindow() {
      return Boolean(mainWindow);
    },
    wireAuxiliaryWindow
  };
}

module.exports = {
  createWindowManager
};
