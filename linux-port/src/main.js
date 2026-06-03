"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, net, protocol } = require("electron");

const { runBootDiagnostics } = require("./main/boot-diagnostics");
const { ORPHEUS_SCHEME, registerOrpheusProtocol } = require("./main/protocol");
const { configureSession } = require("./main/session-runtime");
const { createWindowManager } = require("./main/window-manager");
const { createNativeApi } = require("./native-api");

protocol.registerSchemesAsPrivileged([
  {
    scheme: ORPHEUS_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      allowServiceWorkers: false
    }
  }
]);

app.commandLine.appendSwitch("disable-features", "OutOfBlinkCors");
app.commandLine.appendSwitch("disable-web-security");
app.commandLine.appendSwitch("no-sandbox");

const projectRoot = path.resolve(__dirname, "..", "..");
const linuxPortRoot = path.resolve(__dirname, "..");
const assetRoot = process.env.NETEASE_ASSET_ROOT
  ? path.resolve(process.env.NETEASE_ASSET_ROOT)
  : path.join(projectRoot, "extracted", "orpheus_pkg", "pub");
const appIconPath = path.join(linuxPortRoot, "build", "icon.png");
const extractedRoot = path.join(projectRoot, "extracted");
const debugRoot = path.join(linuxPortRoot, "debug");
const sharedWebPreferences = {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: false,
  nodeIntegration: false,
  sandbox: false,
  webSecurity: false
};

let nativeApi = null;
let rendererLogFile = null;

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function detectAppVersion() {
  const versionFromEnv = String(process.env.NETEASE_APP_VERSION || "").trim();
  if (versionFromEnv) {
    return versionFromEnv;
  }

  const exeMatch = fs
    .readdirSync(projectRoot)
    .find((entry) => /^NeteaseCloudMusic_.*_(\d+\.\d+\.\d+\.\d+)_\d+\.exe$/i.test(entry));
  if (exeMatch) {
    const match = exeMatch.match(/_(\d+\.\d+\.\d+\.\d+)_\d+\.exe$/i);
    if (match) {
      return match[1];
    }
  }

  const versionFile = readTextIfExists(path.join(assetRoot, "VERSION"));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(versionFile)) {
    return versionFile;
  }

  return "3.1.32.205206";
}

function summarizeValue(value) {
  if (value === null || typeof value === "undefined") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 180 ? `${value.slice(0, 177)}...` : value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      preview: value.slice(0, 3)
    };
  }
  const preview = {};
  for (const key of Object.keys(value).slice(0, 8)) {
    const item = value[key];
    preview[key] = typeof item === "string" && item.length > 120 ? `${item.slice(0, 117)}...` : item;
  }
  return preview;
}

function appendRendererLog(entry) {
  if (!rendererLogFile) {
    return;
  }
  try {
    fs.appendFileSync(rendererLogFile, `${new Date().toISOString()} ${entry}\n`);
  } catch (error) {
    console.error("[renderer-log-write-failed]", error);
  }
}

function revealMainWindow(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
}

function injectRendererCompatibilityBootstrap(win) {
  if (!win || win.isDestroyed()) {
    return;
  }

  win.webContents
    .executeJavaScript(
      `(() => {
        if (
          window.__neteaseLinuxHostBootstrapInstalled &&
          typeof window.__neteaseLinuxHostBootstrapTick === "function"
        ) {
          return window.__neteaseLinuxHostBootstrapTick();
        }
        window.__neteaseLinuxHostBootstrapInstalled = true;

        const report = (type, payload = {}) => {
          try {
            console.log("[linux-bootstrap]", JSON.stringify({ type, payload }));
          } catch (error) {
            console.log("[linux-bootstrap]", type, payload, error?.message || error);
          }
        };

        const resolveWebpackRequire = () => {
          return typeof window.__webpack_require__ === "function" ? window.__webpack_require__ : null;
        };

        const readStoreFromCandidate = (candidate) => {
          if (!candidate || typeof candidate !== "object") {
            return null;
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
              return readStoreFromCandidate(appContext);
            } catch {}
          }

          return null;
        };

        const resolveAppStoreFromWebpackCache = (req) => {
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
        };

        const resolveAppStoreFromWindowGlobals = () => {
          const globalCandidates = [];
          if (window.g_app) {
            globalCandidates.push(window.g_app);
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
        };

        const getStore = () => {
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
            report("get-store-failed", { message: error?.message || String(error) });
            return null;
          }
        };

        const readSessionBootstrap = () => {
          try {
            if (
              window.__NETEASE_SESSION_BOOTSTRAP__ &&
              typeof window.__NETEASE_SESSION_BOOTSTRAP__ === "object"
            ) {
              return window.__NETEASE_SESSION_BOOTSTRAP__;
            }
            const stateHost = window.localStorage?.getItem("stateHost");
            const autoLoginCookies = window.localStorage?.getItem("autoLoginCookies");
            const vipInfo = window.localStorage?.getItem("vipInfo");
            const parsedHost = stateHost ? JSON.parse(stateHost) : null;
            const parsedCookies = autoLoginCookies ? JSON.parse(autoLoginCookies) : [];
            const parsedVipInfo = vipInfo ? JSON.parse(vipInfo) : null;
            if (!parsedHost?.uid && !Array.isArray(parsedCookies) && !parsedVipInfo) {
              return null;
            }
            return {
              host: parsedHost,
              cookies: Array.isArray(parsedCookies) ? parsedCookies : [],
              vipInfo: parsedVipInfo
            };
          } catch (error) {
            report("read-session-bootstrap-failed", { message: error?.message || String(error) });
            return null;
          }
        };

        const dispatchIfAvailable = (store, action) => {
          try {
            store.dispatch(action);
            return true;
          } catch (error) {
            report("dispatch-failed", {
              action: action?.type || "",
              message: error?.message || String(error)
            });
            return false;
          }
        };

        const bootstrapRendererState = () => {
          const store = getStore();
          if (!store || typeof store.getState !== "function" || typeof store.dispatch !== "function") {
            return false;
          }

          const state = store.getState();
          const host = state?.host;
          if (!host) {
            return false;
          }

          let touched = false;
          const sessionBootstrap = readSessionBootstrap();
          if (
            sessionBootstrap?.host?.uid &&
            (host.isAnonymous || !host.uid || String(host.uid) !== String(sessionBootstrap.host.uid)) &&
            !window.__NETEASE_SESSION_BOOTSTRAP_SWITCH_SENT__
          ) {
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

          const essential = state["page:essential"] || {};
          const homePage = state["page:homePage"] || {};
          const vipEssential = state["page:vipEssential"] || {};
          const playlistSquare = state["page:playlistsquare"] || {};

          if (!host.uid && !host.createAnonimousFailed) {
            touched =
              dispatchIfAvailable(store, {
                type: "host/onUpdate",
                payload: {
                  createAnonimousFailed: true
                }
              }) || touched;
          }

          if (!essential.banners?.length) {
            touched = dispatchIfAvailable(store, { type: "page:essential/getBanners" }) || touched;
          }

          if (!essential.hasFetched && !essential.isFetching) {
            touched =
              dispatchIfAvailable(store, {
                type: "page:essential/fetchBlocksData",
                payload: {
                  notifyError: false
                }
              }) || touched;
          }

          if (!vipEssential.hasFetched && !vipEssential.isFetching) {
            touched =
              dispatchIfAvailable(store, {
                type: "page:vipEssential/fetchData",
                payload: {}
              }) || touched;
          }

          if (!playlistSquare.playlistTags?.length && !playlistSquare.isFetching) {
            touched =
              dispatchIfAvailable(store, {
                type: "page:playlistsquare/fetchBlocksData",
                payload: {}
              }) || touched;
          }

          if (homePage.isFetchLoading || !homePage.lastRefreshTime) {
            touched =
              dispatchIfAvailable(store, {
                type: "page:homePage/fetchBlocksData",
                payload: {
                  notifyError: false
                }
              }) || touched;
            touched =
              dispatchIfAvailable(store, {
                type: "page:homePage/fetchHomePageAllResourceDatas",
                payload: {
                  notifyError: false
                }
              }) || touched;
          }

          const latestState = store.getState() || {};
          const latestHost = latestState.host || {};
          const latestEssential = latestState["page:essential"] || {};
          const latestHomePage = latestState["page:homePage"] || {};
          const latestVipEssential = latestState["page:vipEssential"] || {};
          const completed =
            Boolean(
              sessionBootstrap?.host?.uid
                ? String(latestHost.uid || "") === String(sessionBootstrap.host.uid || "")
                : true
            ) &&
            Boolean(latestEssential.hasFetched || latestEssential.isFetching || latestEssential.banners?.length) &&
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

          window.__NETEASE_LINUX_BOOTSTRAP_LAST_STATE__ = {
            hostUid: String(latestHost.uid || ""),
            hostIsAnonymous: Boolean(latestHost.isAnonymous),
            essentialHasFetched: Boolean(latestEssential.hasFetched),
            homePageLastRefreshTime: Number(latestHomePage.lastRefreshTime || 0),
            vipEssentialHasFetched: Boolean(latestVipEssential.hasFetched),
            completed
          };
          return completed || touched;
        };
        window.__neteaseLinuxHostBootstrapTick = bootstrapRendererState;

        let attempts = 0;
        const timer = setInterval(() => {
          attempts += 1;
          try {
            const ready = bootstrapRendererState();
            if (attempts === 1 || attempts % 5 === 0 || ready) {
              report("tick", {
                attempts,
                ready,
                state: window.__NETEASE_LINUX_BOOTSTRAP_LAST_STATE__ || null
              });
            }
            if (ready || attempts >= 40) {
              clearInterval(timer);
              report("finished", {
                attempts,
                ready,
                state: window.__NETEASE_LINUX_BOOTSTRAP_LAST_STATE__ || null
              });
            }
          } catch (error) {
            report("tick-failed", { attempts, message: error?.message || String(error) });
            if (attempts >= 40) {
              clearInterval(timer);
            }
          }
        }, 500);

        bootstrapRendererState();
        return "ok";
      })();`,
      true
    )
    .catch((error) => {
      console.warn("[linux-bootstrap:inject-failed]", error);
    });
}

const appVersion = detectAppVersion();

const windowManager = createWindowManager({
  ORPHEUS_SCHEME,
  sharedWebPreferences,
  appIconPath,
  revealMainWindow,
  injectRendererCompatibilityBootstrap,
  runBootDiagnostics: (mainWindow) => runBootDiagnostics(mainWindow, debugRoot),
  nativeApiRef: () => nativeApi
});

app.whenReady().then(async () => {
  nativeApi = createNativeApi({
    app,
    mainWindowRef: () => windowManager.getMainWindow(),
    assetRoot,
    appVersion,
    appIconPath,
    createWindow: windowManager.createAuxiliaryWindow,
    closeChildWindows: windowManager.closeChildWindows,
    extractedRoot,
    logger: console
  });

  if (typeof nativeApi.initialize === "function") {
    await nativeApi.initialize();
  }

  rendererLogFile = path.join(app.getPath("userData"), "renderer.log");

  registerOrpheusProtocol(protocol, net, nativeApi);
  configureSession({ ORPHEUS_SCHEME });

  ipcMain.handle("native:call", async (_event, payload = {}) => {
    const startedAt = Date.now();
    try {
      if (
        process.env.NETEASE_DEBUG_BOOT ||
        /^download\.|^storage\.(querydownloadingprocess|startscandownload|checkfilesexist|addid3)|^winhelper\.popupmenu|^player\.(setlikemark|setinf|setinfo|setminiplayerstate|settotaltime|setlyrics|setoffset)/i.test(
          String(payload.command || "")
        )
      ) {
        console.log("[native:call:start]", payload.command, JSON.stringify(summarizeValue(payload.args)));
      }
      const result = await nativeApi.invoke(payload.command, payload.args, {
        window: BrowserWindow.fromWebContents(_event.sender)
      });
      if (
        process.env.NETEASE_DEBUG_BOOT ||
        /^download\.|^storage\.(querydownloadingprocess|startscandownload|checkfilesexist|addid3)|^winhelper\.popupmenu|^player\.(setlikemark|setinf|setinfo|setminiplayerstate|settotaltime|setlyrics|setoffset)/i.test(
          String(payload.command || "")
        )
      ) {
        console.log(
          "[native:call:ok]",
          payload.command,
          `${Date.now() - startedAt}ms`,
          JSON.stringify(summarizeValue(result))
        );
      }
      return result;
    } catch (error) {
      console.error("[native:call:failed]", payload.command, error);
      throw error;
    }
  });

  ipcMain.on("native:renderer-log", (_event, payload = {}) => {
    const entry = JSON.stringify(payload);
    console.error("[renderer]", entry);
    appendRendererLog(entry);
  });

  windowManager.createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!windowManager.hasMainWindow()) {
    windowManager.createMainWindow();
  }
});
