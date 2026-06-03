"use strict";

function createWindowHandlers(options) {
  const {
    Menu,
    dialog,
    globalShortcut,
    app,
    settings,
    saveSettings,
    emitNativeEvent,
    currentWindow,
    normalizeDataValue,
    normalizeMenuCoordinates,
    normalizeMenuInput,
    buildPopupMenuTemplate,
    showPopupMenu,
    createWindow
  } = options;

  function coerceWindowTitle(payload) {
    if (typeof payload === "string" && payload) {
      return payload;
    }
    if (payload && typeof payload === "object" && typeof payload.title === "string" && payload.title) {
      return payload.title;
    }
    return "NetEase Cloud Music";
  }

  const KEYCODE_TO_KEY = {
    8: "Backspace", 9: "Tab", 13: "Enter", 27: "Escape", 32: "Space",
    33: "PageUp", 34: "PageDown", 35: "End", 36: "Home",
    37: "Left", 38: "Up", 39: "Right", 40: "Down",
    46: "Delete", 45: "Insert",
    112: "F1", 113: "F2", 114: "F3", 115: "F4", 116: "F5", 117: "F6",
    118: "F7", 119: "F8", 120: "F9", 121: "F10", 122: "F11", 123: "F12",
    186: "Semicolon", 187: "Equal", 188: "Comma", 189: "Minus", 190: "Period",
    191: "Slash", 192: "Backquote",
    219: "BracketLeft", 220: "Backslash", 221: "BracketRight", 222: "Quote"
  };

  function keyCodesToAccelerator(keyCodes = []) {
    if (!Array.isArray(keyCodes) || keyCodes.length === 0) {
      return "";
    }
    const parts = [];
    const keyParts = [];
    for (const code of keyCodes) {
      const c = Number(code);
      if (c === 16) { parts.push("Shift"); }
      else if (c === 17) { parts.push("Ctrl"); }
      else if (c === 18) { parts.push("Alt"); }
      else if (c === 91 || c === 93) { parts.push("Super"); }
      else {
        const mapped = KEYCODE_TO_KEY[c];
        if (mapped) {
          keyParts.push(mapped);
        } else if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) {
          keyParts.push(String.fromCharCode(c));
        }
      }
    }
    if (keyParts.length === 0) {
      return "";
    }
    return [...parts, keyParts[0]].join("+");
  }

  function resolveMinimumSizeValue(...candidates) {
    for (const candidate of candidates) {
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.round(parsed);
      }
    }
    return null;
  }

  return {
    "app.opensavefiledialog": async (payload = {}) => {
      const win = currentWindow();
      return dialog.showSaveDialog(win, {
        title: payload.title || "Save file",
        defaultPath: payload.defaultPath
      });
    },
    "app.selectsystemfilelimitcount": async (payload = {}) => {
      const win = currentWindow();
      return dialog.showOpenDialog(win, {
        title: payload.title || "Select file",
        properties: ["openFile", "multiSelections"]
      });
    },
    "app.selectsystemfileanddir": async (payload = {}) => {
      const win = currentWindow();
      return dialog.showOpenDialog(win, {
        title: payload.title || "Select file or directory",
        properties: ["openFile", "openDirectory", "multiSelections"]
      });
    },
    "winhelper.initmainwindow": async () => true,
    "winhelper.finishloadmainwindow": async () => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        win.show();
      }
      return true;
    },
    "winhelper.setnativewindowshow": async (visible = true) => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        if (visible === false) {
          win.hide();
        } else {
          win.show();
        }
      }
      return true;
    },
    "winhelper.show": async () => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
      return true;
    },
    "winhelper.showwindow": async (state) => {
      const win = currentWindow();
      if (!win || win.isDestroyed()) {
        return true;
      }
      if (state === "hide" || state === false) {
        win.hide();
        return true;
      }
      win.show();
      win.focus();
      return true;
    },
    "winhelper.hide": async () => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        win.hide();
      }
      return true;
    },
    "winhelper.getwindowposition": async () => {
      const win = currentWindow();
      if (!win || win.isDestroyed()) {
        return { x: 0, y: 0, width: 0, height: 0 };
      }
      const bounds = win.getBounds();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      };
    },
    "winhelper.launchwindow": async (targetUrl = "", bounds = {}, windowOptions = {}) => {
      if (typeof createWindow !== "function" || !targetUrl) {
        return null;
      }
      return createWindow({
        url: String(targetUrl),
        bounds: bounds && typeof bounds === "object" ? bounds : {},
        options: windowOptions && typeof windowOptions === "object" ? windowOptions : {},
        parentWindow: currentWindow()
      });
    },
    "winhelper.close": async () => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        win.close();
      }
      return true;
    },
    "winhelper.setwindowposition": async (payload = {}) => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        const width = Math.max(320, Math.round(payload.width || win.getBounds().width));
        const height = Math.max(240, Math.round(payload.height || win.getBounds().height));
        const x = Number.isFinite(Number(payload.x)) ? Math.round(Number(payload.x)) : win.getBounds().x;
        const y = Number.isFinite(Number(payload.y)) ? Math.round(Number(payload.y)) : win.getBounds().y;
        win.setBounds({ x, y, width, height });
        if (payload.topmost !== undefined) {
          win.setAlwaysOnTop(Boolean(payload.topmost));
        }
      }
      return true;
    },
    "winhelper.bringwindowtotop": async () => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
      return true;
    },
    "winhelper.setwindowsizelimit": async (payload = {}) => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        const minWidth =
          resolveMinimumSizeValue(payload.minWidth, payload.width, payload.x) || 480;
        const minHeight =
          resolveMinimumSizeValue(payload.minHeight, payload.height, payload.y) || 320;
        win.setMinimumSize(minWidth, minHeight);
      }
      return true;
    },
    "winhelper.iswindowfullscreen": async () => {
      const win = currentWindow();
      return Boolean(win && !win.isDestroyed() && win.isFullScreen());
    },
    "winhelper.setwindowfullscreen": async (payload = {}) => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        win.setFullScreen(Boolean(payload.value ?? payload));
      }
      return true;
    },
    "winhelper.setwindowtitle": async (payload = {}) => {
      const win = currentWindow();
      if (win && !win.isDestroyed()) {
        win.setTitle(coerceWindowTitle(payload));
      }
      return true;
    },
    "winhelper.setwindowiconfromlocalfile": async () => true,
    "winhelper.popupmenu": async (...args) => {
      const payload = args.length === 1 ? args[0] : args;
      return showPopupMenu(payload);
    },
    "winhelper.updatemenu": async () => true,
    "winhelper.setusemediakey": async () => true,
    "winhelper.registerhotkey": async (nameOrPayload = {}, keyCodes, isGlobal, meta = {}) => {
      if (typeof nameOrPayload === "string") {
        settings.hotkeys[nameOrPayload] = {
          keyCodes: Array.isArray(keyCodes) ? keyCodes : [],
          isGlobal: Boolean(isGlobal)
        };
        saveSettings();
        const accelerator = keyCodesToAccelerator(keyCodes);
        if (accelerator) {
          try {
            globalShortcut.register(accelerator, () => {
              emitNativeEvent("winhelper.onHotkey", nameOrPayload, Boolean(isGlobal));
            });
          } catch {
            // accelerator registration failed
          }
        }
        emitNativeEvent(
          "winhelper.onRegisterHotkeyResult",
          nameOrPayload,
          Boolean(isGlobal),
          0,
          meta
        );
        return true;
      }

      const accelerator =
        nameOrPayload.hotkey || nameOrPayload.key || nameOrPayload.accelerator || "";
      if (!accelerator) {
        return false;
      }
      settings.hotkeys[accelerator] = true;
      saveSettings();
      return globalShortcut.register(accelerator, () => {
        emitNativeEvent("winhelper.onHotkey", accelerator, false);
      });
    },
    "winhelper.unregisterhotkey": async (nameOrPayload = {}, isGlobal, meta = {}) => {
      if (typeof nameOrPayload === "string") {
        delete settings.hotkeys[nameOrPayload];
        saveSettings();
        emitNativeEvent(
          "winhelper.onUnregisterHotkeyResult",
          nameOrPayload,
          Boolean(isGlobal),
          0,
          meta
        );
        return true;
      }

      const accelerator =
        nameOrPayload.hotkey || nameOrPayload.key || nameOrPayload.accelerator || "";
      if (accelerator) {
        globalShortcut.unregister(accelerator);
        delete settings.hotkeys[accelerator];
        saveSettings();
      }
      return true;
    }
  };
}

module.exports = {
  createWindowHandlers
};
