"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const { pathToFileURL } = require("node:url");

const registeredCallbacks = new Map();
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

function runRegisteredCallbacks(name, args) {
  const handler = registeredCallbacks.get(name);
  if (!handler) {
    return;
  }

  const callbackList = Array.isArray(handler) ? handler : [handler];
  for (const callback of callbackList) {
    try {
      callback(...args);
    } catch (error) {
      console.error("[native:event]", name, error);
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
  try {
    if (!Array.isArray(window.webpackJsonp) || typeof window.webpackJsonp.push !== "function") {
      return null;
    }
    let req = null;
    const probeChunkId = 910101;
    const probeModuleId = 910102;
    window.webpackJsonp.push([
      [probeChunkId],
      {
        [probeModuleId]: function captureWebpackRequire(module, exports, nextRequire) {
          req = nextRequire;
        }
      },
      [[probeModuleId]]
    ]);
    return req;
  } catch (error) {
    reportRendererError("bootstrap-webpack-probe-failed", {
      message: error.message,
      stack: error.stack || null
    });
    return null;
  }
}

function resolveAppStore() {
  try {
    const req = resolveWebpackRequire();
    const dvaTool = req?.(11)?.a;
    const store = dvaTool?.app?._store;
    return store && typeof store.getState === "function" && typeof store.dispatch === "function"
      ? store
      : null;
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

window.channel = channel;
window.__NETEASE_LINUX_PORT__ = {
  channel,
  invokeNative
};

seedLocalStorageDefaults();
installSessionBootstrapBridge();
installFetchBridge();
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
}
