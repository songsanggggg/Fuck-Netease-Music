"use strict";

function createLocalPopupMenuBridge(options) {
  const {
    safeParseJson,
    normalizeBridgeValue,
    runRegisteredCallbacks
  } = options;

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

function createLocalAudioBridge(options) {
  const {
    safeParseJson,
    runRegisteredCallbacks,
    reportRendererError,
    invokeNative,
    resolveAppStore = () => null
  } = options;

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
    if (/^https:\/\/[^/]+\.music\.126\.net(\/|$)/i.test(normalizedUrl)) {
      return true;
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

  function buildPreparedPlayableSourceCacheKey(payload = {}, directUrl = "") {
    if (!directUrl) {
      return "";
    }
    const extHeader =
      payload && typeof payload.extHeader === "string" ? payload.extHeader : "";
    return JSON.stringify({
      url: directUrl,
      extHeader
    });
  }

  let audioElement = null;
  let preloadAudioElement = null;
  let currentPlayId = "";
  let currentResumeOrPauseId = "";
  let currentSeekId = "";
  let progressTimer = null;
  let lastPayload = null;
  let lastVolume = 1;
  let lastPlaybackRate = 1;
  let pendingSeekSeconds = null;
  const preparedPlayableSourceCache = new Map();
  const mediaSessionState = {
    info: null,
    lyrics: null,
    totalTime: 0,
    offset: 0,
    playbackState: "none"
  };

  const PLAY_STATE = {
    play: 0,
    pause: 1,
    stop: 2
  };

  const canUseMediaSession =
    typeof navigator !== "undefined" &&
    navigator.mediaSession &&
    typeof window !== "undefined";

  const normalizePlayerPayload = (args = []) => {
    if (args.length === 1) {
      return args[0] && typeof args[0] === "object" ? args[0] : null;
    }
    if (args.length > 1) {
      const [first] = args;
      return first && typeof first === "object" ? first : null;
    }
    return null;
  };

  const normalizeLyricsPayload = (args = []) => {
    if (args.length === 1) {
      return args[0];
    }
    return args;
  };

  const readLyricsText = (value) => {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => readLyricsText(entry)).filter(Boolean).join(" ");
    }
    if (typeof value === "object") {
      return (
        value.currentLine ||
        value.currentLyric ||
        value.line ||
        value.lyric ||
        value.lrc ||
        value.text ||
        value.content ||
        ""
      );
    }
    return "";
  };

  const buildArtworkList = (coverUrl = "") => {
    const source = normalizePlayableUrl(String(coverUrl || ""));
    if (!source) {
      return [];
    }
    return [
      { src: source, sizes: "512x512", type: "image/png" },
      { src: source, sizes: "256x256", type: "image/png" },
      { src: source, sizes: "128x128", type: "image/png" }
    ];
  };

  const readArtistText = (info = {}) => {
    if (typeof info.artistName === "string" && info.artistName) {
      return info.artistName;
    }
    if (Array.isArray(info.artists)) {
      return info.artists
        .map((artist) => {
          if (typeof artist === "string") {
            return artist;
          }
          return artist?.name || "";
        })
        .filter(Boolean)
        .join("/");
    }
    return "";
  };

  const updateMediaSessionPositionState = () => {
    if (!canUseMediaSession || typeof navigator.mediaSession.setPositionState !== "function") {
      return;
    }
    const audio = audioElement;
    const duration = Number(
      audio && Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : mediaSessionState.totalTime
    );
    const position = Number(
      audio && Number.isFinite(audio.currentTime) && audio.currentTime >= 0
        ? audio.currentTime
        : mediaSessionState.offset
    );
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || position < 0) {
      return;
    }
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: lastPlaybackRate > 0 ? lastPlaybackRate : 1,
        position: Math.min(position, duration)
      });
    } catch {}
  };

  const updateMediaSessionMetadata = () => {
    if (!canUseMediaSession || typeof MediaMetadata !== "function") {
      return;
    }
    const info = mediaSessionState.info || {};
    const lyricsText = readLyricsText(mediaSessionState.lyrics);
    const albumName =
      [info.albumName || "", lyricsText].filter(Boolean).join(" | ") ||
      info.albumName ||
      "";

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: info.songName || info.title || document.title || "NetEase Cloud Music",
        artist: readArtistText(info),
        album: albumName,
        artwork: buildArtworkList(info.url || info.cover || info.coverUrl || info.picUrl || "")
      });
    } catch (error) {
      reportRendererError("media-session-metadata-failed", {
        message: error?.message || String(error)
      });
    }
    updateMediaSessionPositionState();
  };

  const setMediaSessionPlaybackState = (value) => {
    mediaSessionState.playbackState = value;
    if (!canUseMediaSession) {
      return;
    }
    try {
      navigator.mediaSession.playbackState = value;
    } catch {}
    updateMediaSessionPositionState();
  };

  const dispatchStoreAction = (action) => {
    const store = resolveAppStore();
    if (!store || typeof store.dispatch !== "function") {
      return false;
    }
    try {
      store.dispatch(action);
      return true;
    } catch (error) {
      reportRendererError("media-session-dispatch-failed", {
        message: error?.message || String(error),
        action
      });
      return false;
    }
  };

  const installMediaSessionActionHandlers = () => {
    if (!canUseMediaSession || typeof navigator.mediaSession.setActionHandler !== "function") {
      return;
    }
    const wrapHandler = (name, handler) => {
      try {
        navigator.mediaSession.setActionHandler(name, handler);
      } catch {}
    };
    wrapHandler("play", async () => {
      if (!dispatchStoreAction({ type: "playing/switchResumeOrPause", payload: { triggerScene: "native" } })) {
        await ensureAudioElement().play().catch(() => {});
      }
    });
    wrapHandler("pause", () => {
      if (!dispatchStoreAction({ type: "playing/switchResumeOrPause", payload: { triggerScene: "native" } })) {
        ensureAudioElement().pause();
      }
    });
    wrapHandler("previoustrack", () => {
      dispatchStoreAction({
        type: "playing/jump2Track",
        payload: { flag: -1, type: "call", triggerScene: "native" }
      });
    });
    wrapHandler("nexttrack", () => {
      dispatchStoreAction({
        type: "playing/jump2Track",
        payload: { flag: 1, type: "call", triggerScene: "native" }
      });
    });
    wrapHandler("seekto", (details = {}) => {
      const audio = ensureAudioElement();
      const nextTime = Number(details.seekTime ?? 0);
      if (!Number.isFinite(nextTime) || nextTime < 0) {
        return;
      }
      audio.currentTime = nextTime;
      mediaSessionState.offset = nextTime;
      updateMediaSessionPositionState();
    });
    wrapHandler("seekbackward", (details = {}) => {
      const audio = ensureAudioElement();
      const offset = Number(details.seekOffset ?? 10);
      audio.currentTime = Math.max(0, (audio.currentTime || 0) - offset);
      mediaSessionState.offset = audio.currentTime || 0;
      updateMediaSessionPositionState();
    });
    wrapHandler("seekforward", (details = {}) => {
      const audio = ensureAudioElement();
      const offset = Number(details.seekOffset ?? 10);
      const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
      audio.currentTime = Math.min(duration, (audio.currentTime || 0) + offset);
      mediaSessionState.offset = audio.currentTime || 0;
      updateMediaSessionPositionState();
    });
  };

  installMediaSessionActionHandlers();

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
      mediaSessionState.totalTime = audioElement?.duration || mediaSessionState.totalTime || 0;
      runRegisteredCallbacks("audioplayer.onLoad", [
        currentPlayId,
        {
          code: 0,
          duration: audioElement?.duration || 0
        }
      ]);
      updateMediaSessionPositionState();
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
      setMediaSessionPlaybackState("playing");
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
      setMediaSessionPlaybackState(ended ? "none" : "paused");
      runRegisteredCallbacks("audioplayer.onPlayState", [
        currentPlayId,
        currentResumeOrPauseId,
        ended ? PLAY_STATE.stop : PLAY_STATE.pause
      ]);
    });

    audioElement.addEventListener("ended", () => {
      stopProgressTimer();
      setMediaSessionPlaybackState("none");
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
      mediaSessionState.offset = audioElement?.currentTime || 0;
      updateMediaSessionPositionState();
      emitPlayProgress(false);
    });

    audioElement.addEventListener("seeked", () => {
      mediaSessionState.offset = audioElement?.currentTime || 0;
      updateMediaSessionPositionState();
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

  const ensurePreloadAudioElement = () => {
    if (preloadAudioElement) {
      return preloadAudioElement;
    }
    preloadAudioElement = document.createElement("audio");
    preloadAudioElement.preload = "auto";
    preloadAudioElement.style.display = "none";
    return preloadAudioElement;
  };

  const resolvePreparedPlayableSource = async (payload = {}) => {
    const directUrl = normalizePlayableUrl(readPlayableUrl(payload));
    if (!directUrl) {
      return "";
    }
    if (!shouldPrepareLocalPlayback(payload, directUrl)) {
      return directUrl;
    }

    const cacheKey = buildPreparedPlayableSourceCacheKey(payload, directUrl);
    const existingTask = preparedPlayableSourceCache.get(cacheKey);
    if (existingTask) {
      return existingTask;
    }

    const prepareTask = invokeNative("linuxport.resolveaudio", [{ ...payload, url: directUrl }])
      .then((resolvedUrl) => {
        if (typeof resolvedUrl === "string" && resolvedUrl) {
          return resolvedUrl;
        }
        return directUrl;
      })
      .catch((error) => {
        reportRendererError("resolve-stream-audio-failed", {
          message: error?.message || String(error),
          url: directUrl
        });
        preparedPlayableSourceCache.delete(cacheKey);
        return directUrl;
      });

    preparedPlayableSourceCache.set(cacheKey, prepareTask);
    const resolved = await prepareTask;
    if (resolved === directUrl) {
      preparedPlayableSourceCache.delete(cacheKey);
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
      updateMediaSessionPositionState();
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
      mediaSessionState.offset = 0;
      setMediaSessionPlaybackState("none");
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
      mediaSessionState.offset = audio.currentTime || 0;
      updateMediaSessionPositionState();
      return true;
    },
    "player.setsmtcenable": async () => true,
    "player.setminiplayerstate": async (payload = {}) => {
      const normalized = payload && typeof payload === "object" ? payload : {};
      if (normalized.playstate === PLAY_STATE.play || normalized.playstate === 0) {
        setMediaSessionPlaybackState("playing");
      } else if (normalized.playstate === PLAY_STATE.pause || normalized.playstate === 1) {
        setMediaSessionPlaybackState("paused");
      } else if (normalized.playstate === PLAY_STATE.stop || normalized.playstate === 2) {
        setMediaSessionPlaybackState("none");
      }
      return true;
    },
    "player.setinfo": async (...args) => {
      mediaSessionState.info = normalizePlayerPayload(args);
      updateMediaSessionMetadata();
      return true;
    },
    "player.settotaltime": async (value = 0) => {
      mediaSessionState.totalTime = Number(value || 0);
      updateMediaSessionPositionState();
      return true;
    },
    "player.setlyrics": async (...args) => {
      mediaSessionState.lyrics = normalizeLyricsPayload(args);
      updateMediaSessionMetadata();
      return true;
    },
    "player.setoffset": async (value = 0) => {
      mediaSessionState.offset = Number(value || 0);
      updateMediaSessionPositionState();
      return true;
    },
    "audioplayer.preload": async (_playId, payload = {}) => {
      const nextUrl = await resolvePreparedPlayableSource(payload);
      if (!nextUrl) {
        return false;
      }
      const preloadAudio = ensurePreloadAudioElement();
      preloadAudio.preload = "auto";
      const currentPreloadSrc = preloadAudio.currentSrc || preloadAudio.src || "";
      if (currentPreloadSrc !== nextUrl) {
        preloadAudio.pause();
        preloadAudio.removeAttribute("src");
        preloadAudio.load();
        preloadAudio.src = nextUrl;
        preloadAudio.load();
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

module.exports = {
  createLocalAudioBridge,
  createLocalPopupMenuBridge
};
