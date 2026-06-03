"use strict";

function createDownloadManager(options) {
  const {
    app,
    fsp,
    path,
    session,
    logger = console,
    pathExists,
    ensureDir,
    safeJsonParse,
    normalizeAssetUrl,
    normalizeStorageTarget,
    isSubPath,
    emitNativeEvent
  } = options;

  const activeDownloads = new Map();
  const copyNcmSubscribers = new Set();

  function guessFileExtensionFromUrl(inputUrl, fallbackExtension = ".bin") {
    if (typeof inputUrl !== "string" || !inputUrl) {
      return fallbackExtension;
    }
    try {
      const parsed = new URL(inputUrl);
      const extension = path.extname(parsed.pathname || "");
      if (!extension || extension.length > 10) {
        return fallbackExtension;
      }
      return extension.toLowerCase();
    } catch {
      return fallbackExtension;
    }
  }

  function flattenInvokeArgs(argsLike = []) {
    const source = Array.isArray(argsLike) ? argsLike : [argsLike];
    const flattened = [];
    for (const entry of source) {
      if (Array.isArray(entry)) {
        flattened.push(...flattenInvokeArgs(entry));
      } else {
        flattened.push(entry);
      }
    }
    return flattened;
  }

  function normalizeDownloadPayloadArgs(argsLike = []) {
    const args = flattenInvokeArgs(argsLike);
    const objectArgs = args.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
    const mergedObject = Object.assign({}, ...objectArgs);

    const idCandidate =
      mergedObject.id ||
      mergedObject.downloadId ||
      (typeof args[0] === "string" ? args[0] : "") ||
      "";

    const urlCandidate =
      mergedObject.url ||
      mergedObject.downloadUrl ||
      mergedObject.musicurl ||
      "";

    const relativePathCandidate =
      mergedObject.relativePath ||
      mergedObject.rel_path ||
      mergedObject.relPath ||
      mergedObject.path ||
      mergedObject.targetPath ||
      mergedObject.filePath ||
      mergedObject.finalPath ||
      "";

    const extHeaderCandidate =
      mergedObject.extHeader ||
      mergedObject.ext_header ||
      mergedObject.headers ||
      mergedObject.extraHeader ||
      "";

    const sizeCandidate =
      mergedObject.size ||
      mergedObject.total ||
      mergedObject.contentLength ||
      0;

    const prePathCandidate =
      mergedObject.prePath ||
      mergedObject.pre_path ||
      mergedObject.tmpPath ||
      "";

    return {
      ...mergedObject,
      id: String(idCandidate || ""),
      url: String(urlCandidate || ""),
      relativePath: String(relativePathCandidate || ""),
      prePath: String(prePathCandidate || ""),
      extHeader:
        typeof extHeaderCandidate === "string"
          ? extHeaderCandidate
          : extHeaderCandidate && typeof extHeaderCandidate === "object"
            ? JSON.stringify(extHeaderCandidate)
            : "",
      size: Number(sizeCandidate || 0)
    };
  }

  function normalizeStorageCheckFilesExistArgs(argsLike = []) {
    const args = flattenInvokeArgs(argsLike);
    const [firstArg, secondArg, thirdArg] = args;
    if (firstArg && typeof firstArg === "object" && !Array.isArray(firstArg)) {
      return {
        files: Array.isArray(firstArg.files) ? firstArg.files : [],
        baseDir: String(firstArg.path || thirdArg || app.getPath("downloads"))
      };
    }
    return {
      files: Array.isArray(secondArg) ? secondArg : Array.isArray(firstArg) ? firstArg : [],
      baseDir: String(thirdArg || app.getPath("downloads"))
    };
  }

  function normalizeDownloadProcessQueryArgs(argsLike = []) {
    const args = flattenInvokeArgs(argsLike);
    const [firstArg, secondArg] = args;
    if (Array.isArray(firstArg)) {
      return firstArg;
    }
    if (firstArg && typeof firstArg === "object" && Array.isArray(firstArg.items)) {
      return firstArg.items;
    }
    if (Array.isArray(secondArg)) {
      return secondArg;
    }
    return [];
  }

  function normalizeStartScanDownloadArgs(argsLike = []) {
    const args = flattenInvokeArgs(argsLike);
    const [firstArg, secondArg, thirdArg] = args;
    if (firstArg && typeof firstArg === "object" && !Array.isArray(firstArg)) {
      return {
        path: String(firstArg.path || app.getPath("downloads")),
        excludePath: Array.isArray(firstArg.excludePath) ? firstArg.excludePath : []
      };
    }
    return {
      path: String((typeof secondArg === "string" ? secondArg : thirdArg) || firstArg || app.getPath("downloads")),
      excludePath: Array.isArray(thirdArg) ? thirdArg : Array.isArray(secondArg) ? secondArg : []
    };
  }

  function normalizeRelativeDownloadPath(targetPath = "") {
    return String(targetPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .trim();
  }

  function resolveDownloadFilePath(baseDir, relativePath) {
    const normalizedRelativePath = normalizeRelativeDownloadPath(relativePath);
    if (!normalizedRelativePath) {
      return null;
    }
    const resolvedBaseDir = path.resolve(String(baseDir || app.getPath("downloads")));
    const candidatePath = path.resolve(path.join(resolvedBaseDir, normalizedRelativePath));
    if (!isSubPath(resolvedBaseDir, candidatePath)) {
      return null;
    }
    return candidatePath;
  }

  async function buildDownloadHeaders(targetUrl, extHeaderText = "") {
    const normalizedUrl = normalizeAssetUrl(String(targetUrl || ""));
    const headers = {
      Origin: "https://music.163.com",
      origin: "https://music.163.com",
      Referer: "https://music.163.com/",
      referer: "https://music.163.com/",
      Accept: "*/*"
    };

    const extHeaders = safeJsonParse(String(extHeaderText || ""), {});
    if (extHeaders && typeof extHeaders === "object" && !Array.isArray(extHeaders)) {
      for (const [key, value] of Object.entries(extHeaders)) {
        if (value !== undefined && value !== null && value !== "") {
          headers[key] = String(value);
        }
      }
    }

    if (normalizedUrl) {
      const cookies = await session.defaultSession.cookies.get({ url: normalizedUrl });
      if (cookies.length > 0) {
        headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      }
    }

    return headers;
  }

  function getDownloadStateSnapshot(task) {
    const totalBytes = task.totalBytes > 0 ? task.totalBytes : Math.max(task.expectedBytes || 0, 1);
    const downloadedBytes = Math.max(0, task.downloadedBytes || 0);
    const progress = Math.min(1, totalBytes > 0 ? downloadedBytes / totalBytes : 0);
    return {
      id: task.id,
      download: downloadedBytes,
      total: totalBytes,
      speed: Math.max(0, Math.round(task.speedBytesPerSecond || 0)),
      path: task.relativePath,
      progress
    };
  }

  function emitDownloadProcess(task, extra = {}) {
    const snapshot = getDownloadStateSnapshot(task);
    const eventPayload = {
      id: task.id,
      type: extra.type ?? 1,
      isLast: Boolean(extra.isLast),
      download: snapshot.download,
      total: snapshot.total,
      speed: snapshot.speed,
      path: extra.path || snapshot.path,
      relativePath: snapshot.path
    };
    logger.log("[native:download:process]", JSON.stringify(eventPayload));
    emitNativeEvent("download.onProcess", eventPayload);
  }

  async function performNativeDownload(task) {
    let response;
    let fileHandle;
    let fileStream;
    try {
      const headers = await buildDownloadHeaders(task.url, task.extHeader);
      response = await fetch(task.url, {
        method: "GET",
        headers,
        signal: task.abortController.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`download failed: ${response.status}`);
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > 0) {
        task.totalBytes = contentLength;
      }

      await ensureDir(path.dirname(task.filePath));
      fileHandle = await fsp.open(task.filePath, "w");
      fileStream = fileHandle.createWriteStream();

      const reader = response.body.getReader();
      let previousBytes = 0;
      let previousTime = Date.now();
      task.status = "downloading";
      task.downloadedBytes = 0;
      task.speedBytesPerSecond = 0;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        const chunk = Buffer.from(value);
        await new Promise((resolve, reject) => {
          fileStream.write(chunk, (error) => (error ? reject(error) : resolve()));
        });
        task.downloadedBytes += chunk.length;
        const now = Date.now();
        const elapsed = Math.max(1, now - previousTime);
        if (elapsed >= 500) {
          task.speedBytesPerSecond = ((task.downloadedBytes - previousBytes) * 1000) / elapsed;
          previousBytes = task.downloadedBytes;
          previousTime = now;
          emitDownloadProcess(task);
        }
      }

      await new Promise((resolve, reject) => {
        fileStream.end((error) => (error ? reject(error) : resolve()));
      });
      await fileHandle.close();
      fileHandle = null;
      fileStream = null;

      task.speedBytesPerSecond = 0;
      task.totalBytes = Math.max(task.totalBytes || 0, task.downloadedBytes || 0, 1);
      task.status = "completed";
      emitDownloadProcess(task, {
        type: 0,
        isLast: true,
        path: task.relativePath
      });
      return { ok: true, id: task.id, path: task.relativePath };
    } catch (error) {
      const isAbort = error && (error.name === "AbortError" || /aborted/i.test(String(error.message || "")));
      if (fileStream) {
        try {
          await new Promise((resolve) => fileStream.end(resolve));
        } catch {
          // ignore cleanup failure
        }
      }
      if (fileHandle) {
        try {
          await fileHandle.close();
        } catch {
          // ignore cleanup failure
        }
      }

      if (task.status === "cancelled") {
        try {
          await fsp.rm(task.filePath, { force: true });
        } catch {
          // ignore cleanup failure
        }
        return { ok: true, id: task.id, cancelled: true };
      }
      if (task.status === "paused" || isAbort) {
        return { ok: true, id: task.id, paused: true };
      }

      logger.warn("[native:download]", task.id, error && error.message ? error.message : error);
      emitDownloadProcess(task, {
        type: -101,
        isLast: true,
        path: task.relativePath
      });
      return { ok: false, id: task.id, error: error && error.message ? error.message : String(error) };
    } finally {
      activeDownloads.delete(task.id);
    }
  }

  async function startNativeDownload(rawPayload = {}) {
    const payload = normalizeDownloadPayloadArgs(rawPayload);
    const downloadDir =
      normalizeStorageTarget(payload.downloadDir) ||
      normalizeStorageTarget(payload.basePath) ||
      app.getPath("downloads");
    const relativePath = normalizeRelativeDownloadPath(
      payload.relativePath || payload.prePath || `${payload.id || "download"}${guessFileExtensionFromUrl(payload.url)}`
    );
    const filePath = resolveDownloadFilePath(downloadDir, relativePath);
    if (!payload.url || !filePath) {
      throw new Error("invalid download payload");
    }

    logger.log(
      "[native:download:start]",
      JSON.stringify({
        id: String(payload.id || ""),
        relativePath,
        filePath,
        hasExtHeader: Boolean(payload.extHeader),
        size: Number(payload.size || 0),
        payloadKeys: Object.keys(payload).sort()
      })
    );

    const currentTask = activeDownloads.get(String(payload.id || ""));
    if (currentTask) {
      currentTask.abortController.abort();
      activeDownloads.delete(currentTask.id);
    }

    const task = {
      id: String(payload.id || `download-${Date.now()}`),
      url: normalizeAssetUrl(String(payload.url || "")),
      relativePath,
      filePath,
      extHeader: String(payload.extHeader || ""),
      expectedBytes: Number(payload.size || 0),
      totalBytes: Number(payload.size || 0),
      downloadedBytes: 0,
      speedBytesPerSecond: 0,
      status: "queued",
      abortController: new AbortController()
    };

    activeDownloads.set(task.id, task);
    task.promise = performNativeDownload(task);
    return { ok: true, id: task.id };
  }

  async function downloadFileOnce(rawPayload = {}) {
    const payload = normalizeDownloadPayloadArgs(rawPayload);
    const relativePath = normalizeRelativeDownloadPath(
      payload.relativePath || payload.pathId || `${payload.id || "download-sync"}${guessFileExtensionFromUrl(payload.url)}`
    );
    const downloadDir =
      normalizeStorageTarget(payload.downloadDir) ||
      normalizeStorageTarget(payload.basePath) ||
      app.getPath("downloads");
    const filePath = resolveDownloadFilePath(downloadDir, relativePath);
    if (!payload.url || !filePath) {
      return { type: -101, path: relativePath };
    }

    const headers = await buildDownloadHeaders(payload.url, payload.extHeader);
    const response = await fetch(payload.url, {
      method: "GET",
      headers
    });
    if (!response.ok) {
      return { type: -101, path: relativePath };
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await ensureDir(path.dirname(filePath));
    await fsp.writeFile(filePath, bytes);
    return { type: 0, path: relativePath };
  }

  async function listDownloadFilesForScan(baseDir, excludePathList = []) {
    const normalizedBaseDir = String(baseDir || app.getPath("downloads"));
    const excluded = new Set(
      (Array.isArray(excludePathList) ? excludePathList : [])
        .map((entry) => normalizeRelativeDownloadPath(String(entry || "")))
        .filter(Boolean)
    );
    const results = [];

    async function walk(currentDir) {
      let entries = [];
      try {
        entries = await fsp.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(entryPath);
          continue;
        }

        const relativePath = normalizeRelativeDownloadPath(path.relative(normalizedBaseDir, entryPath));
        if (!relativePath || excluded.has(relativePath)) {
          continue;
        }

        let stat;
        try {
          stat = await fsp.stat(entryPath);
        } catch {
          continue;
        }

        results.push({
          path: relativePath,
          size: stat.size,
          creationTime: stat.mtimeMs,
          comment: ""
        });
      }
    }

    await walk(normalizedBaseDir);
    return results;
  }

  function getDownloadTaskByPayload(payload = {}) {
    const id =
      typeof payload === "string"
        ? payload
        : typeof payload?.id === "string"
          ? payload.id
          : typeof payload?.downloadId === "string"
            ? payload.downloadId
            : "";
    return id ? activeDownloads.get(id) : null;
  }

  async function checkDownloadFilesExist(argsLike = []) {
    const { files, baseDir } = normalizeStorageCheckFilesExistArgs(argsLike);
    const results = [];
    for (const entry of files) {
      const relativePath =
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object"
            ? entry.path || entry.relativePath || ""
            : "";
      const resolvedPath = resolveDownloadFilePath(baseDir, relativePath);
      if (!resolvedPath || !(await pathExists(resolvedPath))) {
        results.push({ type: -101, path: relativePath });
        continue;
      }
      results.push({ type: 0, path: relativePath });
    }
    return results;
  }

  async function scanDownloads(argsLike = []) {
    const { path: baseDir, excludePath } = normalizeStartScanDownloadArgs(argsLike);
    const entries = await listDownloadFilesForScan(baseDir, excludePath);
    logger.log(
      "[native:download:scan]",
      JSON.stringify({
        path: baseDir,
        excludeCount: excludePath.length,
        found: entries.length
      })
    );
    emitNativeEvent("storage.ondownloadscan", entries);
    return entries;
  }

  async function copyNcmFiles(payload = {}) {
    const srcFiles = Array.isArray(payload?.srcFiles) ? payload.srcFiles : [];
    const destFiles = Array.isArray(payload?.destFiles) ? payload.destFiles : [];
    const copied = [];
    for (let index = 0; index < Math.min(srcFiles.length, destFiles.length); index += 1) {
      const src = String(srcFiles[index] || "");
      const dst = String(destFiles[index] || "");
      if (!src || !dst) {
        continue;
      }
      const resolvedSrc = normalizeStorageTarget(src) || src;
      const resolvedDst = normalizeStorageTarget(dst) || dst;
      await ensureDir(path.dirname(resolvedDst));
      await fsp.copyFile(resolvedSrc, resolvedDst);
      const eventPayload = { type: "copyncm", code: 0, src: resolvedSrc, dst: resolvedDst };
      copied.push(eventPayload);
      emitNativeEvent("storage.oncopyncmprocess", eventPayload);
      for (const callback of copyNcmSubscribers) {
        try {
          callback(eventPayload);
        } catch {
          // ignore renderer callback failure
        }
      }
    }
    return copied;
  }

  function subscribeCopyNcmProcess(payload = {}) {
    if (typeof payload?.callback === "function") {
      copyNcmSubscribers.add(payload.callback);
    }
    return true;
  }

  function queryDownloadProgress(argsLike = []) {
    const inputItems = normalizeDownloadProcessQueryArgs(argsLike);
    return inputItems.map((entry) => {
      const task = activeDownloads.get(String(entry?.id || ""));
      if (!task) {
        return {
          id: String(entry?.id || ""),
          path: String(entry?.path || ""),
          progress: 0
        };
      }
      const snapshot = getDownloadStateSnapshot(task);
      return {
        id: task.id,
        path: entry?.path || task.relativePath,
        progress: snapshot.progress,
        download: snapshot.download,
        total: snapshot.total,
        speed: snapshot.speed
      };
    });
  }

  function queryDownloadSchedule(argsLike = []) {
    const inputItems = normalizeDownloadProcessQueryArgs(argsLike);
    return inputItems
      .map((entry) => {
        const task = activeDownloads.get(String(entry?.id || ""));
        if (!task) {
          return null;
        }
        const snapshot = getDownloadStateSnapshot(task);
        return {
          id: task.id,
          path: entry?.path || task.relativePath,
          progress: snapshot.progress,
          download: snapshot.download,
          total: snapshot.total,
          speed: snapshot.speed
        };
      })
      .filter(Boolean);
  }

  function pauseDownload(payload = {}) {
    const task = getDownloadTaskByPayload(normalizeDownloadPayloadArgs(payload));
    if (!task) {
      return true;
    }
    task.status = "paused";
    task.abortController.abort();
    return true;
  }

  function cancelDownload(payload = {}) {
    const task = getDownloadTaskByPayload(normalizeDownloadPayloadArgs(payload));
    if (!task) {
      return true;
    }
    task.status = "cancelled";
    task.abortController.abort();
    return true;
  }

  return {
    activeDownloads,
    cancelDownload,
    checkDownloadFilesExist,
    copyNcmFiles,
    downloadFileOnce,
    normalizeDownloadPayloadArgs,
    pauseDownload,
    queryDownloadProgress,
    queryDownloadSchedule,
    scanDownloads,
    startNativeDownload,
    subscribeCopyNcmProcess
  };
}

module.exports = {
  createDownloadManager
};
