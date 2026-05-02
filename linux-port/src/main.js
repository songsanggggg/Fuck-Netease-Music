"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, protocol, net, shell, session } = require("electron");

const { createNativeApi } = require("./native-api");
const { ORPHEUS_SCHEME, registerOrpheusProtocol } = require("./protocol");

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
const extractedRoot = path.join(projectRoot, "extracted");
const debugRoot = path.join(linuxPortRoot, "debug");
const appVersion = detectAppVersion();
const sharedWebPreferences = {
  preload: path.join(__dirname, "preload.js"),
  contextIsolation: false,
  nodeIntegration: false,
  sandbox: false,
  webSecurity: false
};

let mainWindow = null;
let nativeApi = null;
let rendererLogFile = null;
const childWindows = new Set();
const childWindowsByKey = new Map();

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

function wireAuxiliaryWindow(win) {
  if (!win || win.isDestroyed()) {
    return;
  }

  childWindows.add(win);

  win.webContents.setWindowOpenHandler(({ url, features }) => {
    if (url.startsWith(`${ORPHEUS_SCHEME}://`)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 440,
          height: 720,
          minWidth: 360,
          minHeight: 320,
          autoHideMenuBar: true,
          backgroundColor: "#1a1d21",
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

    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${ORPHEUS_SCHEME}://`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
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

function createAuxiliaryWindow({ url, bounds = {}, options = {}, parentWindow = null }) {
  const key = getWindowKeyFromUrl(url);
  const existingWindow = childWindowsByKey.get(key);
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.loadURL(url);
    if (options.visible !== false) {
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
    show: options.visible !== false,
    resizable: options.resizable !== false,
    minimizable: false,
    maximizable: options.resizable !== false,
    skipTaskbar: options.taskbarButton === false,
    autoHideMenuBar: true,
    backgroundColor: options.bk_color || "#1a1d21",
    parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : mainWindow,
    modal: Boolean(options.spec_window),
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

function configureSession() {
  const defaultSession = session.defaultSession;
  const corsFilter = {
    urls: [
      "https://*.music.163.com/*",
      "http://clientlog.music.163.com/*",
      "https://*.126.net/*",
      "https://*.netease.com/*"
    ]
  };
  const canonicalOrigin = "https://music.163.com";
  const canonicalReferer = "https://music.163.com/";

  const readHeader = (headers, key) => headers[key] || headers[key.toLowerCase()];
  const setHeaderPair = (headers, key, value) => {
    headers[key] = value;
    headers[key.toLowerCase()] = value;
  };
  const isOrpheusHeader = (value) =>
    typeof value === "string" && value.startsWith(`${ORPHEUS_SCHEME}://`);
  const needsCanonicalSiteHeaders = (details, headers) => {
    const originHeader = readHeader(headers, "Origin");
    const refererHeader = readHeader(headers, "Referer");
    if (isOrpheusHeader(originHeader) || isOrpheusHeader(refererHeader)) {
      return true;
    }

    const requestUrl = String(details.url || "");
    if (!/^https:\/\/[^/]+\.(music\.126\.net|126\.net)(\/|$)/i.test(requestUrl)) {
      return false;
    }

    const destination =
      details.resourceType ||
      readHeader(headers, "Sec-Fetch-Dest") ||
      readHeader(headers, "sec-fetch-dest") ||
      "";
    return ["image", "media", "audio"].includes(String(destination).toLowerCase());
  };

  defaultSession.webRequest.onBeforeSendHeaders(corsFilter, (details, callback) => {
    const headers = {
      ...details.requestHeaders
    };
    if (needsCanonicalSiteHeaders(details, headers)) {
      setHeaderPair(headers, "Origin", canonicalOrigin);
      setHeaderPair(headers, "Referer", canonicalReferer);
    }
    callback({ requestHeaders: headers });
  });

  defaultSession.webRequest.onHeadersReceived(corsFilter, (details, callback) => {
    const responseHeaders = {
      ...(details.responseHeaders || {})
    };
    const allowOrigin = details.requestHeaders?.Origin || details.requestHeaders?.origin || "*";
    responseHeaders["Access-Control-Allow-Origin"] = [allowOrigin];
    responseHeaders["Access-Control-Allow-Credentials"] = ["true"];
    responseHeaders["Access-Control-Allow-Headers"] = ["*"];
    responseHeaders["Access-Control-Allow-Methods"] = ["GET, POST, PUT, DELETE, OPTIONS"];
    callback({ responseHeaders });
  });

  if (process.env.NETEASE_DEBUG_BOOT) {
    defaultSession.webRequest.onCompleted((details) => {
      const url = details.url || "";
      if (
        url.startsWith("orpheus://") ||
        url.includes("music.163.com") ||
        url.includes("music.126.net") ||
        url.includes("netease.com")
      ) {
        console.log("[request:completed]", details.method, details.statusCode, url);
      }
    });

    defaultSession.webRequest.onErrorOccurred((details) => {
      const url = details.url || "";
      if (
        url.startsWith("orpheus://") ||
        url.includes("music.163.com") ||
        url.includes("music.126.net") ||
        url.includes("netease.com")
      ) {
        console.error("[request:error]", details.method, details.error, url);
      }
    });
  }
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

async function runBootDiagnostics() {
  if (!process.env.NETEASE_DEBUG_BOOT || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  await fs.promises.mkdir(debugRoot, { recursive: true });

  try {
    const page = await mainWindow.webContents.capturePage();
    await fs.promises.writeFile(path.join(debugRoot, "boot.png"), page.toPNG());
  } catch (error) {
    console.error("[debug:boot:capture-failed]", error);
  }

  try {
    const payload = await mainWindow.webContents.executeJavaScript(
      `(async () => {
        const root = document.querySelector("#root");
        const body = document.body;
        const trim = (value) => typeof value === "string" ? value.trim() : "";
        const text = trim(root?.innerText || body?.innerText || "");
        return {
          href: location.href,
          title: document.title,
          readyState: document.readyState,
          pathname: location.pathname,
          rootTag: root?.tagName || null,
          rootExists: Boolean(root),
          rootChildCount: root?.childElementCount || 0,
          rootHtmlLength: root?.innerHTML?.length || 0,
          rootReactKeys: root
            ? Object.getOwnPropertyNames(root).filter((key) => key.startsWith("__react")).slice(0, 20)
            : [],
          gAppExists: Boolean(window.g_app),
          gAppKeys: window.g_app ? Object.keys(window.g_app).slice(0, 20) : [],
          storeKeys: window.g_app?.store?.getState ? Object.keys(window.g_app.store.getState()) : [],
          historyLocation:
            window.g_app?.history?.location
              ? {
                  pathname: window.g_app.history.location.pathname,
                  search: window.g_app.history.location.search,
                  hash: window.g_app.history.location.hash
                }
              : null,
          performanceResources:
            typeof performance?.getEntriesByType === "function"
              ? performance
                  .getEntriesByType("resource")
                  .slice(-30)
                  .map((entry) => ({
                    name: entry.name,
                    initiatorType: entry.initiatorType,
                    duration: Math.round(entry.duration),
                    transferSize: entry.transferSize || 0
                  }))
              : [],
          localStorageKeys:
            window.localStorage
              ? Object.keys(window.localStorage).sort().slice(0, 40)
              : [],
          viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio || 1
          },
          bodyStyle: body
            ? (() => {
                const style = window.getComputedStyle(body);
                return {
                  backgroundColor: style.backgroundColor,
                  color: style.color,
                  opacity: style.opacity,
                  visibility: style.visibility
                };
              })()
            : null,
          rootStyle: root
            ? (() => {
                const style = window.getComputedStyle(root);
                const rect = root.getBoundingClientRect();
                return {
                  display: style.display,
                  opacity: style.opacity,
                  visibility: style.visibility,
                  color: style.color,
                  backgroundColor: style.backgroundColor,
                  rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                  }
                };
              })()
            : null,
          topElementAtCenter: (() => {
            const target = document.elementFromPoint(
              Math.max(0, Math.floor(window.innerWidth / 2)),
              Math.max(0, Math.floor(window.innerHeight / 2))
            );
            return target
              ? {
                  tag: target.tagName,
                  id: target.id || "",
                  className: target.className || "",
                  text: trim(target.innerText || "").slice(0, 120)
                }
              : null;
          })(),
          visibleTextSamples: Array.from(document.querySelectorAll("body *"))
            .map((element) => {
              const textContent = trim(element.innerText || "");
              if (!textContent) {
                return null;
              }
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName,
                id: element.id || "",
                className: String(element.className || "").slice(0, 120),
                text: textContent.slice(0, 80),
                display: style.display,
                visibility: style.visibility,
                opacity: style.opacity,
                color: style.color,
                rect: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height)
                }
              };
            })
            .filter(Boolean)
            .slice(0, 20),
          webpackProbe: await (async () => {
            try {
              let req = null;
              if (Array.isArray(window.webpackJsonp) && typeof window.webpackJsonp.push === "function") {
                const probeChunkId = 900001;
                const probeModuleId = 900002;
                window.webpackJsonp.push([
                  [probeChunkId],
                  {
                    [probeModuleId]: function captureWebpackRequire(module, exports, nextRequire) {
                      req = nextRequire;
                    }
                  },
                  [[probeModuleId]]
                ]);
              }
              if (!req) {
                return {
                  available: false
                };
              }
              const modelModule = req(1307);
              const modelEntries = Array.isArray(modelModule?.default) ? modelModule.default : [];
              const asyncHelper = req(151);
              const appContextModule = req(16);
              const appContext = appContextModule?.getAppContext?.();
              const dvaTool = req(11)?.a;
              const apiModule = req(15);
              const homeModule = req(203);
              const storeState = dvaTool?.app?._store?.getState ? dvaTool.app._store.getState() : null;
              const selectedApiKeys = ["Qb", "Xg", "ge", "oc", "pc", "ke", "ie", "he", "ac", "mi", "Me"];
              const selectedHomeKeys = ["b", "j", "f", "g", "i", "l", "h", "q"];
              const selectedModelNamespaces = [
                "page:essential",
                "page:banners",
                "page:ranklist",
                "page:verticalZone",
                "page:artistsGallery",
                "page:vipEssential",
                "page:playlistsquare"
              ];
              const modelPreview = [];
              for (const entry of modelEntries.slice(0, 20)) {
                const [loader, namespace] = entry;
                let contextProbe = "skipped";
                let loaderProbe = "skipped";
                if (typeof loader === "function" && asyncHelper && typeof asyncHelper.b === "function") {
                  contextProbe = await Promise.race([
                    Promise.resolve()
                      .then(() => asyncHelper.b({ namespace }))
                      .then(() => "resolved")
                      .catch((error) => "error:" + (error?.message || String(error))),
                    new Promise((resolve) => setTimeout(() => resolve("timeout"), 200))
                  ]);
                }
                if (typeof loader === "function") {
                  loaderProbe = await Promise.race([
                    Promise.resolve()
                      .then(() => loader())
                      .then((result) =>
                        result && typeof result === "object" && "namespace" in result
                          ? "resolved:" + result.namespace
                          : "resolved"
                      )
                      .catch((error) => "error:" + (error?.message || String(error))),
                    new Promise((resolve) => setTimeout(() => resolve("timeout"), 250))
                  ]);
                }
                modelPreview.push({
                  namespace,
                  loaderType: typeof loader,
                  loaderSource:
                    typeof loader === "function" ? String(loader).slice(0, 180) : String(loader).slice(0, 180),
                  contextProbe,
                  loaderProbe
                });
              }
              return {
                available: true,
                modelCount: modelEntries.length,
                asyncHelperKeys: asyncHelper ? Object.keys(asyncHelper).slice(0, 20) : [],
                appContextAvailable: Boolean(appContext),
                appContextKeys: appContext ? Object.keys(appContext).slice(0, 20) : [],
                appStoreStateKeys:
                  appContext?.app?._store?.getState
                    ? Object.keys(appContext.app._store.getState())
                    : [],
                appRouterDefined: Boolean(appContext?.app?._router),
                appStartedFlag: Boolean(appContext?.app?._started),
                appHistoryLocation:
                  appContext?.history?.location
                    ? {
                        pathname: appContext.history.location.pathname,
                        search: appContext.history.location.search,
                        hash: appContext.history.location.hash
                      }
                    : null,
                dvaToolInited: Boolean(dvaTool?.inited),
                dvaToolHasApp: Boolean(dvaTool?.app),
                dvaToolHasHistory: Boolean(dvaTool?.history),
                dvaToolStoreKeys:
                  dvaTool?.app?._store?.getState ? Object.keys(dvaTool.app._store.getState()) : [],
                storeSlices: storeState
                  ? {
                      homePage: storeState["page:homePage"],
                      banners: storeState["page:banners"],
                      essential: storeState["page:essential"],
                      ranklist: storeState["page:ranklist"],
                      verticalZone: storeState["page:verticalZone"],
                      artistsGallery: storeState["page:artistsGallery"],
                      vipEssential: storeState["page:vipEssential"],
                      host: storeState.host
                    }
                  : null,
                apiModuleKeys: apiModule ? Object.keys(apiModule).slice(0, 80) : [],
                apiModulePreview: apiModule
                  ? Object.fromEntries(
                      Object.entries(apiModule)
                        .slice(0, 30)
                        .map(([key, value]) => [
                          key,
                          typeof value === "function" ? String(value).slice(0, 200) : typeof value
                        ])
                    )
                  : null,
                apiModuleSelectedPreview: apiModule
                  ? Object.fromEntries(
                      selectedApiKeys.map((key) => [
                        key,
                        typeof apiModule[key] === "function"
                          ? String(apiModule[key]).slice(0, 600)
                          : apiModule[key]
                      ])
                    )
                  : null,
                homeModuleKeys: homeModule ? Object.keys(homeModule).slice(0, 40) : [],
                homeModulePreview: homeModule
                  ? Object.fromEntries(
                      Object.entries(homeModule)
                        .slice(0, 20)
                        .map(([key, value]) => [
                          key,
                          typeof value === "function" ? String(value).slice(0, 200) : value
                        ])
                    )
                  : null,
                homeModuleSelectedPreview: homeModule
                  ? Object.fromEntries(
                      selectedHomeKeys.map((key) => [
                        key,
                        typeof homeModule[key] === "function"
                          ? String(homeModule[key]).slice(0, 800)
                          : homeModule[key]
                      ])
                    )
                  : null,
                selectedModelLoaders: Object.fromEntries(
                  selectedModelNamespaces.map((namespace) => {
                    const entry = modelEntries.find((candidate) => candidate[1] === namespace);
                    const loader = entry?.[0];
                    return [
                      namespace,
                      loader
                        ? {
                            loaderType: typeof loader,
                            loaderSource: String(loader).slice(0, 1200)
                          }
                        : null
                    ];
                  })
                ),
                modelPreview
              };
            } catch (error) {
              return {
                available: true,
                error: error?.message || String(error),
                stack: error?.stack || null
              };
            }
          })(),
          bodyChildren: body
            ? Array.from(body.children).map((node) => ({
                tag: node.tagName,
                id: node.id || "",
                className: typeof node.className === "string" ? node.className : "",
                textLength: trim(node.textContent || "").length
              }))
            : [],
          bodyHtmlLength: body?.innerHTML?.length || 0,
          bodyPreview: trim(body?.innerHTML || "").slice(0, 400),
          textLength: text.length,
          textPreview: text.slice(0, 400)
        };
      })();`,
      true
    );
    await fs.promises.writeFile(
      path.join(debugRoot, "boot.json"),
      `${JSON.stringify(payload, null, 2)}\n`
    );
    console.log("[debug:boot]", JSON.stringify(payload));
  } catch (error) {
    console.error("[debug:boot:dom-failed]", error);
  }
}

function revealMainWindow() {
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
            report("switch-user-dispatched", {
              storeUid: String(host.uid || ""),
              targetUid: String(sessionBootstrap.host.uid || "")
            });
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "NetEase Cloud Music Linux Port",
    backgroundColor: "#1a1d21",
    webPreferences: {
      ...sharedWebPreferences
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url, features }) => {
    if (url.startsWith(`${ORPHEUS_SCHEME}://`)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 440,
          height: 720,
          minWidth: 360,
          minHeight: 320,
          autoHideMenuBar: true,
          backgroundColor: "#1a1d21",
          parent: mainWindow,
          modal: false,
          show: true,
          webPreferences: {
            ...sharedWebPreferences
          },
          ...parseWindowFeatures(features)
        }
      };
    }

    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${ORPHEUS_SCHEME}://`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("enter-full-screen", () => {
    nativeApi.emitNativeEvent("winhelper.onFullscreenChange", true);
  });
  mainWindow.on("leave-full-screen", () => {
    nativeApi.emitNativeEvent("winhelper.onFullscreenChange", false);
  });
  mainWindow.on("close", () => {
    nativeApi.emitNativeEvent("winhelper.onSystemRequestCloseWindow");
    nativeApi.emitNativeEvent("winhelper.onClose");
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[load-failed]", errorCode, errorDescription, validatedURL);
    revealMainWindow();
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
    revealMainWindow();
    injectRendererCompatibilityBootstrap(mainWindow);
    setTimeout(() => injectRendererCompatibilityBootstrap(mainWindow), 3000);
    setTimeout(() => injectRendererCompatibilityBootstrap(mainWindow), 8000);
    setTimeout(() => injectRendererCompatibilityBootstrap(mainWindow), 12000);
  });

  mainWindow.webContents.once("did-finish-load", () => {
    revealMainWindow();
    injectRendererCompatibilityBootstrap(mainWindow);
  });

  setTimeout(() => {
    revealMainWindow();
  }, 3000);

  setTimeout(() => {
    runBootDiagnostics();
  }, 10000);

  mainWindow.loadURL(`${ORPHEUS_SCHEME}://orpheus/pub/app.html`);
}

app.whenReady().then(async () => {
  nativeApi = createNativeApi({
    app,
    mainWindowRef: () => mainWindow,
    assetRoot,
    appVersion,
    createWindow: createAuxiliaryWindow,
    extractedRoot,
    logger: console
  });

  if (typeof nativeApi.initialize === "function") {
    await nativeApi.initialize();
  }

  rendererLogFile = path.join(app.getPath("userData"), "renderer.log");

  registerOrpheusProtocol(protocol, net, nativeApi);
  configureSession();

  ipcMain.handle("native:call", async (_event, payload = {}) => {
    const startedAt = Date.now();
    try {
      if (
        process.env.NETEASE_DEBUG_BOOT ||
        /^download\.|^storage\.(querydownloadingprocess|startscandownload|checkfilesexist|addid3)/i.test(
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
        /^download\.|^storage\.(querydownloadingprocess|startscandownload|checkfilesexist|addid3)/i.test(
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

  createMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow) {
    createMainWindow();
  }
});
