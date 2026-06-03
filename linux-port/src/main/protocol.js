"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ORPHEUS_SCHEME = "orpheus";

const FALLBACK_PAGES = {
  "/start.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0;url=app.html" />
    <title>NetEase Cloud Music Linux Port</title>
  </head>
  <body>Redirecting to app.html...</body>
</html>
`,
  "/lrc.html": `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Desktop Lyric Placeholder</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        color: white;
        font-family: sans-serif;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
      }
    </style>
  </head>
  <body>Desktop lyric is not implemented yet.</body>
</html>
`
};

function ensureInside(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (
    resolvedCandidate !== resolvedBase &&
    !resolvedCandidate.startsWith(resolvedBase + path.sep)
  ) {
    return null;
  }
  return resolvedCandidate;
}

function relativeFromOrpheusPath(inputPath) {
  const trimmed = inputPath.replace(/^\/+/, "");
  if (!trimmed) {
    return "app.html";
  }
  if (trimmed.startsWith("pub/")) {
    return trimmed.slice(4);
  }
  return trimmed;
}

function resolveNativeAsset(assetRoot, inputPath) {
  const page = inputPath === "/" ? "/app.html" : inputPath;
  const relativePath = relativeFromOrpheusPath(page);
  return ensureInside(assetRoot, path.join(assetRoot, relativePath));
}

function resolveStorageFile(storageRoot, inputPath) {
  const relativePath = inputPath.replace(/^\/+/, "");
  return ensureInside(storageRoot, path.join(storageRoot, relativePath));
}

function resolveAbsoluteOrRelativePath(nativeApi, inputPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(inputPath);
  } catch {
    return null;
  }
  if (!decoded || decoded === "/") {
    return null;
  }
  return nativeApi.resolveOrpheusPath(decoded);
}

function isUndefinedStyleRequest(url) {
  return url.pathname === "/pub/styles/undefined" || url.pathname.endsWith("/styles/undefined");
}

function createTextResponse(contents, contentType) {
  return new Response(contents, {
    status: 200,
    headers: {
      "content-type": contentType
    }
  });
}

async function createFileResponse(electronNet, filePath) {
  return electronNet.fetch(pathToFileURL(filePath).toString());
}

async function createMissingResponse(url) {
  const escapedUrl = String(url).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return new Response(
    `<!doctype html><html><body><h1>404</h1><p>${escapedUrl} was not found.</p></body></html>`,
    {
      status: 404,
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    }
  );
}

async function handleOrpheusRequest(request, electronNet, nativeApi) {
  const url = new URL(request.url);
  let resolvedFile = null;

  if (isUndefinedStyleRequest(url)) {
    return createTextResponse("", "text/css; charset=utf-8");
  }

  switch (url.host) {
    case "native":
      resolvedFile = resolveNativeAsset(nativeApi.assetRoot, url.pathname);
      if (!resolvedFile && FALLBACK_PAGES[url.pathname]) {
        return createTextResponse(FALLBACK_PAGES[url.pathname], "text/html; charset=utf-8");
      }
      break;
    case "cache":
      resolvedFile = resolveStorageFile(nativeApi.cacheRoot, url.pathname);
      break;
    case "file":
      resolvedFile = resolveAbsoluteOrRelativePath(nativeApi, url.pathname);
      if (resolvedFile) {
        resolvedFile =
          ensureInside(nativeApi.storageRoot, resolvedFile) ||
          ensureInside(nativeApi.extractedRoot, resolvedFile) ||
          ensureInside(nativeApi.assetRoot, resolvedFile) ||
          ensureInside(nativeApi.cacheRoot, resolvedFile) ||
          null;
      }
      break;
    case "localmusic":
      resolvedFile = resolveAbsoluteOrRelativePath(nativeApi, url.searchParams.get("path") || url.pathname);
      if (resolvedFile) {
        resolvedFile =
          ensureInside(nativeApi.storageRoot, resolvedFile) ||
          ensureInside(nativeApi.extractedRoot, resolvedFile) ||
          ensureInside(nativeApi.assetRoot, resolvedFile) ||
          ensureInside(nativeApi.cacheRoot, resolvedFile) ||
          null;
      }
      break;
    case "orpheus":
      resolvedFile = resolveAbsoluteOrRelativePath(nativeApi, url.pathname);
      if (resolvedFile) {
        resolvedFile =
          ensureInside(nativeApi.storageRoot, resolvedFile) ||
          ensureInside(nativeApi.extractedRoot, resolvedFile) ||
          ensureInside(nativeApi.assetRoot, resolvedFile) ||
          ensureInside(nativeApi.cacheRoot, resolvedFile) ||
          null;
      }
      break;
    default:
      break;
  }

  if (resolvedFile && fs.existsSync(resolvedFile) && fs.statSync(resolvedFile).isFile()) {
    if (process.env.NETEASE_DEBUG_BOOT) {
      console.log("[orpheus:serve]", request.url, "->", resolvedFile);
    }
    return createFileResponse(electronNet, resolvedFile);
  }
  if (url.host === "native" && FALLBACK_PAGES[url.pathname]) {
    return createTextResponse(FALLBACK_PAGES[url.pathname], "text/html; charset=utf-8");
  }
  console.warn("[orpheus:404]", request.url, resolvedFile);
  return createMissingResponse(request.url);
}

function registerOrpheusProtocol(protocol, electronNet, nativeApi) {
  if (typeof protocol.handle === "function") {
    protocol.handle(ORPHEUS_SCHEME, (request) =>
      handleOrpheusRequest(request, electronNet, nativeApi)
    );
    return;
  }

  protocol.registerBufferProtocol(ORPHEUS_SCHEME, async (request, respond) => {
    const response = await handleOrpheusRequest(request, electronNet, nativeApi);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    respond({
      data: buffer,
      mimeType: response.headers.get("content-type") || "application/octet-stream",
      statusCode: response.status
    });
  });
}

module.exports = {
  ORPHEUS_SCHEME,
  registerOrpheusProtocol
};
