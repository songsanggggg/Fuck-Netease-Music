"use strict";

function createBootstrapRuntime(options) {
  const {
    channel,
    invokeNative,
    normalizeBridgeValue,
    reportRendererError,
    reportRendererInfo,
    safeParseJson
  } = options;

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

  function normalizePathValue(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object" && typeof value.path === "string") {
      return value.path;
    }
    return "";
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
        status: normalizedResult?.status ?? 500,
        headers: normalizedResult?.headers || {}
      });
    };

    window.fetch = bridgedFetch;
    globalThis.fetch = bridgedFetch;
  }

  return {
    installFetchBridge,
    installSessionBootstrapBridge,
    normalizePathValue,
    seedLocalStorageDefaults
  };
}

module.exports = {
  createBootstrapRuntime
};
