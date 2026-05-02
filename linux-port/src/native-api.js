"use strict";

const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { screen, shell, nativeTheme, dialog, session, globalShortcut } = require("electron");

function hashString(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isSubPath(baseDir, candidatePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  return (
    resolvedCandidate === resolvedBase ||
    resolvedCandidate.startsWith(resolvedBase + path.sep)
  );
}

function toForwardSlash(value) {
  return value.split(path.sep).join("/");
}

function safeJsonParse(contents, fallbackValue) {
  try {
    return JSON.parse(contents);
  } catch {
    return fallbackValue;
  }
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

function normalizeDataValue(value) {
  if (typeof value === "string") {
    return normalizeAssetUrl(normalizeJsonText(maybeRepairUtf8Mojibake(value)));
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeDataValue(item));
  }
  if (value && typeof value === "object") {
    const normalizedEcpmPayload = normalizeHomePageEcpmPayload(value);
    if (normalizedEcpmPayload !== value) {
      return normalizeDataValue(normalizedEcpmPayload);
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = normalizeDataValue(entry);
    }
    return output;
  }
  return value;
}

function normalizeAssetUrl(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  if (/^\/\//.test(value)) {
    return `https:${value}`;
  }

  if (/^http:\/\/[^/\s]+\.(music\.126\.net|music\.163\.com|126\.net|netease\.com)(\/|$)/i.test(value)) {
    return value.replace(/^http:\/\//i, "https://");
  }

  return value;
}

function normalizeEcpmBlockEntry(blockName, blockValue) {
  const fallbackTitles = {
    featureRecommendBlock: "每日推荐",
    recommendPlaylistBlock: "推荐歌单",
    bannersBlock: "精选活动",
    ranklistBlock: "排行榜",
    allListenBlock: "大家都在听",
    recentListenBlock: "最近在听",
    heartbeatRecommendBlock: "红心推荐",
    radarBlock: "私人雷达",
    vipRecommendBlock: "会员推荐",
    styleRecommendBlock: "风格推荐",
    dailyVoiceBlock: "每日播客",
    personalizeVoiceListBlock: "热门播客",
    listenAudioBookBlock: "听见好书"
  };

  const normalizedBlock =
    blockValue && typeof blockValue === "object" && !Array.isArray(blockValue)
      ? { ...blockValue }
      : {};

  if (blockName === "bannersBlock") {
    return {
      ...normalizedBlock,
      title: "",
      data: [],
      alg: ""
    };
  }

  if (typeof normalizedBlock.title !== "string" || !normalizedBlock.title) {
    const nestedTitle =
      normalizedBlock.data &&
      typeof normalizedBlock.data === "object" &&
      !Array.isArray(normalizedBlock.data)
        ? normalizedBlock.data.blockName ||
          normalizedBlock.data.title ||
          normalizedBlock.data.uiElement?.mainTitle?.title ||
          ""
        : "";
    normalizedBlock.title = nestedTitle || fallbackTitles[blockName] || "";
  }

  if (typeof normalizedBlock.alg !== "string") {
    normalizedBlock.alg = normalizedBlock.alg ? String(normalizedBlock.alg) : "";
  }

  if (
    blockName === "listenAudioBookBlock" &&
    normalizedBlock.data &&
    typeof normalizedBlock.data === "object" &&
    !Array.isArray(normalizedBlock.data) &&
    Array.isArray(normalizedBlock.data.creatives)
  ) {
    normalizedBlock.data = normalizedBlock.data.creatives;
  }

  if (typeof normalizedBlock.data === "undefined" || normalizedBlock.data === null) {
    normalizedBlock.data = [];
  }

  return normalizedBlock;
}

function normalizeHomePageEcpmPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const blockKeys = [
    "featureRecommendBlock",
    "recommendPlaylistBlock",
    "bannersBlock",
    "ranklistBlock",
    "allListenBlock",
    "recentListenBlock",
    "heartbeatRecommendBlock",
    "radarBlock",
    "vipRecommendBlock",
    "styleRecommendBlock",
    "dailyVoiceBlock",
    "personalizeVoiceListBlock",
    "listenAudioBookBlock"
  ];

  if (!blockKeys.some((key) => key in value)) {
    return value;
  }

  const normalized = { ...value };
  for (const key of blockKeys) {
    normalized[key] = normalizeEcpmBlockEntry(key, normalized[key]);
  }
  if (Array.isArray(normalized.homePageEcpmOrderedBlocks)) {
    normalized.homePageEcpmOrderedBlocks = normalized.homePageEcpmOrderedBlocks.filter(
      (blockName) => blockName !== "bannersBlock"
    );
  }
  if (Array.isArray(normalized.orderedBlocks)) {
    normalized.orderedBlocks = normalized.orderedBlocks.filter(
      (blockName) => blockName !== "bannersBlock"
    );
  }
  return normalized;
}

function sanitizeHomePageEcpmCachePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const nextValue = { ...value };
  if (nextValue.homePageEcpmResourceDatas) {
    nextValue.homePageEcpmResourceDatas = normalizeHomePageEcpmPayload(
      nextValue.homePageEcpmResourceDatas
    );
  }
  if (Array.isArray(nextValue.homePageEcpmOrderedBlocks)) {
    nextValue.homePageEcpmOrderedBlocks = nextValue.homePageEcpmOrderedBlocks.filter(
      (blockName) => blockName !== "bannersBlock"
    );
  }
  return nextValue;
}

function sanitizeHomePageEcpmCacheText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return text;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }

  const sanitized = sanitizeHomePageEcpmCachePayload(parsed);
  return sanitized === parsed ? text : JSON.stringify(sanitized);
}

function deepEqualJsonLike(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeJsonText(text) {
  if (typeof text !== "string" || !text) {
    return text;
  }

  const trimmed = text.trim();
  if (
    !trimmed ||
    ((!trimmed.startsWith("{") || !trimmed.endsWith("}")) &&
      (!trimmed.startsWith("[") || !trimmed.endsWith("]")))
  ) {
    return text;
  }

  try {
    const parsed = JSON.parse(text);
    const normalized = normalizeDataValue(parsed);
    if (deepEqualJsonLike(parsed, normalized)) {
      return text;
    }
    return JSON.stringify(normalized);
  } catch {
    return text;
  }
}

function normalizeSqlStringLiteralToken(token) {
  if (typeof token !== "string" || token.length < 2 || !token.startsWith("'") || !token.endsWith("'")) {
    return token;
  }
  const unescaped = token.slice(1, -1).replace(/''/g, "'");
  const normalized = maybeRepairUtf8Mojibake(unescaped);
  if (normalized === unescaped) {
    return token;
  }
  return `'${normalized.replace(/'/g, "''")}'`;
}

function normalizeSqlTextLiterals(sqlText) {
  const source = String(sqlText || "");
  if (!source) {
    return source;
  }
  return source.replace(/'(?:''|[^'])*'/g, (token) => normalizeSqlStringLiteralToken(token));
}

function chromeCookieExpiresUtcToUnixSeconds(expiresUtc) {
  const numericValue = Number(expiresUtc);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }
  const unixMicroseconds = numericValue - 11644473600000000;
  if (!Number.isFinite(unixMicroseconds) || unixMicroseconds <= 0) {
    return 0;
  }
  return Math.floor(unixMicroseconds / 1000000);
}

function callbackArgs(...args) {
  return {
    __nativeCallbackArgs: args
  };
}

function normalizeCookieFilter(cookieFilter) {
  if (typeof cookieFilter === "string") {
    return cookieFilter ? { url: cookieFilter } : {};
  }
  if (!cookieFilter || typeof cookieFilter !== "object") {
    return {};
  }
  return {
    url: cookieFilter.url || cookieFilter.Url || undefined,
    name: cookieFilter.name || cookieFilter.Name || undefined,
    domain: cookieFilter.domain || cookieFilter.Domain || undefined,
    path: cookieFilter.path || cookieFilter.Path || undefined
  };
}

function toCookieRecord(cookie) {
  const protocol = cookie.secure ? "https" : "http";
  const host = String(cookie.domain || "").replace(/^\./, "");
  const url = cookie.url || (host ? `${protocol}://${host}${cookie.path || "/"}` : "");
  const domain = cookie.domain || "";
  const pathValue = cookie.path || "/";
  const name = cookie.name || "";
  const value = cookie.value || "";
  const httpOnly = Boolean(cookie.httpOnly);
  const secure = Boolean(cookie.secure);
  const session = Boolean(cookie.session);
  const expirationDate = cookie.expirationDate || 0;
  return {
    domain,
    path: pathValue,
    url,
    name,
    value,
    httpOnly,
    secure,
    session,
    expirationDate,
    Domain: domain,
    Path: pathValue,
    Url: url,
    Name: name,
    Value: value,
    HttpOnly: httpOnly,
    Secure: secure,
    Session: session,
    ExpirationDate: expirationDate
  };
}

function normalizeSetCookiePayload(cookie) {
  const next = cookie && typeof cookie === "object" ? { ...cookie } : {};
  const normalized = {
    url: next.url || next.Url || "",
    name: next.name || next.Name || "",
    value: next.value || next.Value || "",
    domain: next.domain || next.Domain || "",
    path: next.path || next.Path || "/",
    secure: Boolean(next.secure ?? next.Secure),
    httpOnly: Boolean(next.httpOnly ?? next.HttpOnly)
  };
  const expirationDate = Number(
    next.expirationDate ??
    next.ExpirationDate ??
    next.expires ??
    next.Expires ??
    0
  );
  if (Number.isFinite(expirationDate) && expirationDate > 0) {
    normalized.expirationDate = expirationDate;
  }
  const sameSite = String(next.sameSite || next.SameSite || "").toLowerCase();
  if (sameSite === "lax" || sameSite === "strict" || sameSite === "no_restriction") {
    normalized.sameSite = sameSite;
  }
  if (!normalized.url && normalized.domain) {
    const protocol = normalized.secure ? "https" : "http";
    normalized.url = `${protocol}://${String(normalized.domain).replace(/^\./, "")}${normalized.path}`;
  }
  return normalized;
}

function normalizeFetchPayload(payload) {
  if (typeof payload === "string") {
    return {
      url: payload,
      options: {}
    };
  }
  const next = payload && typeof payload === "object" ? payload : {};
  return {
    url: next.url || "",
    options: next.options && typeof next.options === "object" ? { ...next.options } : {}
  };
}

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

function rewriteRpcUrl(url) {
  const rewrites = [
    ["/eapi/comment/pc/song/mode/initial/carousel", "/api/comment/pc/song/mode/initial/carousel"],
    ["/eapi/resource-exposure/config", "/api/resource-exposure/config"],
    ["/eapi/link/position/show/resource", "/api/link/position/show/resource"],
    ["/eapi/pc/upgrade/get", "/api/pc/upgrade/get"],
    ["/eapi/pl/count", "/api/pl/count"]
  ];

  for (const [source, target] of rewrites) {
    if (url.includes(source)) {
      return url.replace(source, target);
    }
  }

  return url;
}

function decodeRpcBody(body) {
  if (typeof body !== "string" || !body.startsWith("params=")) {
    return null;
  }

  try {
    const decoded = decodeURIComponent(body.slice("params=".length));
    const parsed = JSON.parse(decoded);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return null;
    }
    const rawPayload = parsed[1];
    const payloadObject = typeof rawPayload === "string"
      ? safeJsonParse(rawPayload, null)
      : rawPayload && typeof rawPayload === "object"
        ? rawPayload
        : null;
    return {
      apiPath: typeof parsed[0] === "string" ? parsed[0] : "",
      payload: rawPayload,
      payloadObject
    };
  } catch {
    return null;
  }
}

function buildPublicApiFallbackRequest(url, rpcBody) {
  if (!url.includes("interfacepc.music.163.com")) {
    return null;
  }

  const apiPath = rpcBody && typeof rpcBody.apiPath === "string" ? rpcBody.apiPath : "";
  if (!apiPath.startsWith("/api/")) {
    return null;
  }

  const payloadObject = rpcBody && rpcBody.payloadObject && typeof rpcBody.payloadObject === "object"
    ? { ...rpcBody.payloadObject }
    : {};
  delete payloadObject.header;
  delete payloadObject.e_r;

  const requestBody = new URLSearchParams();
  for (const [key, value] of Object.entries(payloadObject)) {
    if (typeof value === "undefined" || value === null) {
      continue;
    }
    requestBody.set(key, typeof value === "string" ? value : String(value));
  }

  return {
    url: `https://music.163.com${apiPath}`,
    body: requestBody.toString()
  };
}

function buildCompatibilityFallbackRequest(apiPath, payloadObject = {}) {
  if (apiPath === "/api/playlist/v4/detail") {
    const requestBody = new URLSearchParams();
    for (const key of ["id", "n", "s"]) {
      const value = payloadObject[key];
      if (typeof value === "undefined" || value === null) {
        continue;
      }
      requestBody.set(key, typeof value === "string" ? value : String(value));
    }
    return {
      url: "https://music.163.com/api/v6/playlist/detail",
      body: requestBody.toString()
    };
  }

  return null;
}

function getRpcResponseCode(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const parsed = safeJsonParse(text, null);
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  return typeof parsed.code === "number" ? parsed.code : null;
}

function isSuccessfulRpcResponse(text) {
  const code = getRpcResponseCode(text);
  return code === null || code === 200;
}

function isJsonLikeRpcResponse(text) {
  if (!text || typeof text !== "string" || !text.trim()) {
    return false;
  }
  const parsed = safeJsonParse(text, null);
  return Boolean(parsed) && (Array.isArray(parsed) || typeof parsed === "object");
}

function isAuthOrVipApiPath(apiPath = "") {
  return [
    "/api/login/",
    "/api/sms/",
    "/api/register/anonimous",
    "/api/cellphone/existence/check",
    "/api/user/bindingCellphone",
    "/api/w/login",
    "/api/w/register/cellphone",
    "/api/w/nuser/account/get",
    "/api/w/v1/user/detail/",
    "/api/music-vip-membership/client/vip/info"
  ].some((prefix) => apiPath.startsWith(prefix));
}

function shouldForcePublicApiFallback(apiPath, text) {
  if (!isAuthOrVipApiPath(apiPath)) {
    return false;
  }
  const code = getRpcResponseCode(text);
  return code !== null && code >= 500;
}

function splitSetCookieHeader(headerValue) {
  if (!headerValue || typeof headerValue !== "string") {
    return [];
  }
  return headerValue.split(/,(?=\s*[^;,=\s]+=[^;,]*)/g).map((item) => item.trim()).filter(Boolean);
}

function parseSetCookieString(setCookieValue, responseUrl) {
  if (!setCookieValue || typeof setCookieValue !== "string") {
    return null;
  }

  const segments = setCookieValue.split(";").map((item) => item.trim()).filter(Boolean);
  const pair = segments.shift();
  if (!pair) {
    return null;
  }

  const equalsIndex = pair.indexOf("=");
  if (equalsIndex <= 0) {
    return null;
  }

  const name = pair.slice(0, equalsIndex).trim();
  const value = pair.slice(equalsIndex + 1);
  const cookie = {
    name,
    value,
    path: "/",
    secure: false,
    httpOnly: false
  };

  for (const segment of segments) {
    const attributeIndex = segment.indexOf("=");
    const rawKey = attributeIndex === -1 ? segment : segment.slice(0, attributeIndex);
    const rawValue = attributeIndex === -1 ? "" : segment.slice(attributeIndex + 1);
    const key = rawKey.trim().toLowerCase();
    const attributeValue = rawValue.trim();

    if (key === "path" && attributeValue) {
      cookie.path = attributeValue;
      continue;
    }
    if (key === "domain" && attributeValue) {
      cookie.domain = attributeValue;
      continue;
    }
    if (key === "max-age") {
      const maxAge = Number(attributeValue);
      if (Number.isFinite(maxAge)) {
        cookie.expirationDate =
          maxAge > 0 ? Math.floor(Date.now() / 1000) + maxAge : 1;
      }
      continue;
    }
    if (key === "expires") {
      const expirationDate = Math.floor(Date.parse(attributeValue) / 1000);
      if (Number.isFinite(expirationDate)) {
        cookie.expirationDate = expirationDate > 0 ? expirationDate : 1;
      }
      continue;
    }
    if (key === "secure") {
      cookie.secure = true;
      continue;
    }
    if (key === "httponly") {
      cookie.httpOnly = true;
      continue;
    }
    if (key === "samesite" && attributeValue) {
      const normalizedSameSite = attributeValue.toLowerCase().replace(/-/g, "_");
      if (
        normalizedSameSite === "lax" ||
        normalizedSameSite === "strict" ||
        normalizedSameSite === "none"
      ) {
        cookie.sameSite =
          normalizedSameSite === "none" ? "no_restriction" : normalizedSameSite;
      }
    }
  }

  let cookieUrl;
  try {
    const parsedUrl = new URL(responseUrl);
    const host = String(cookie.domain || parsedUrl.hostname).replace(/^\./, "");
    const protocol = cookie.secure ? "https:" : parsedUrl.protocol || "https:";
    cookieUrl = `${protocol}//${host}${cookie.path || "/"}`;
  } catch {
    cookieUrl = responseUrl;
  }
  cookie.url = cookieUrl;

  return normalizeSetCookiePayload(cookie);
}

function createEmptyRpcResponse(apiPath = "", url = "") {
  const response = {
    code: 200,
    message: "",
    data: {}
  };

  const pathHint = `${apiPath} ${url}`;

  if (/banner\/get/.test(pathHint)) {
    response.banners = [];
  }

  if (
    /personalized\/newsong/.test(pathHint) ||
    /discovery\/new\/songs/.test(pathHint)
  ) {
    response.result = [];
  }

  if (
    /personal\/page\/playlist\/rcmd/.test(pathHint) ||
    /playlist\/tag\/rcmd/.test(pathHint) ||
    /playlist\/list\/get/.test(pathHint)
  ) {
    response.playlists = [];
  }

  if (
    /voicelist\/rcmd\/list/.test(pathHint) ||
    /program\/recommend\/v2/.test(pathHint) ||
    /voice\/homepage\/block\/content/.test(pathHint)
  ) {
    response.data = {
      ...response.data,
      recommendVoiceVOS: []
    };
  }

  if (/search\/default\/keyword\/get/.test(pathHint)) {
    response.data = {
      ...response.data,
      showKeyword: "",
      realkeyword: ""
    };
  }

  if (/resource-exposure\/config/.test(pathHint)) {
    response.data = {
      ...response.data,
      resources: []
    };
  }

  if (/link\/position\/show\/resource/.test(pathHint)) {
    response.data = {
      ...response.data,
      resources: [],
      hasMore: false
    };
  }

  if (/pc\/version/.test(pathHint)) {
    response.data = {
      ...response.data,
      core: null,
      native: null,
      orpheus: null
    };
  }

  if (/pc\/upgrade\/get/.test(pathHint)) {
    response.data = {
      ...response.data,
      version: "",
      needUpdate: false
    };
  }

  if (Object.keys(response.data).length === 0) {
    response.data = {
      recommendVoiceVOS: []
    };
  }

  return response;
}

function escapeSqlString(value) {
  return String(value || "").replace(/'/g, "''");
}

async function applyResponseCookies(cookieStore, response, responseUrl, logger = console) {
  if (!response || !response.headers) {
    return;
  }

  let setCookieValues = [];
  if (typeof response.headers.getSetCookie === "function") {
    setCookieValues = response.headers.getSetCookie();
  } else {
    setCookieValues = splitSetCookieHeader(response.headers.get("set-cookie"));
  }

  for (const setCookieValue of setCookieValues) {
    const cookiePayload = parseSetCookieString(setCookieValue, responseUrl);
    if (!cookiePayload || !cookiePayload.name) {
      continue;
    }
    try {
      await cookieStore.set(cookiePayload);
    } catch (error) {
      logger.warn("[native:cookie:set-failed]", cookiePayload.name, error.message);
    }
  }
}

function createNativeApi(options) {
  const {
    app,
    mainWindowRef,
    logger = console,
    assetRoot,
    extractedRoot,
    createWindow = null,
    appVersion = "3.1.32.205206"
  } = options;

  const userDataRoot = app.getPath("userData");
  const stateRoot = path.join(userDataRoot, "orpheus-linux-port");
  const storageRoot = path.join(stateRoot, "storage");
  const cacheRoot = path.join(storageRoot, "cache");
  const tempRoot = path.join(storageRoot, "temp");
  const lyricsRoot = path.join(storageRoot, "lyrics");
  const localConfigPath = path.join(stateRoot, "local-config.json");
  const settingsPath = path.join(stateRoot, "settings.json");
  const generatedPath = path.join(stateRoot, "generated");
  const sqliteDbPath = path.join(stateRoot, "orpheus.sqlite3");
  const cookiesDbPath = path.join(userDataRoot, "Cookies");

  [
    stateRoot,
    storageRoot,
    cacheRoot,
    tempRoot,
    lyricsRoot,
    generatedPath
  ].forEach(ensureDirSync);

  let localConfig = {};
  let settings = {
    autoRun: false,
    hotkeys: {},
    deviceId: hashString(os.hostname() + "::" + os.userInfo().username)
  };
  let unknownCommands = new Set();
  let invocationWindow = null;
  let persistedHostCache = null;
  let persistentModelTableColumnsCache = null;
  const activeDownloads = new Map();
  const copyNcmSubscribers = new Set();

  if (fs.existsSync(localConfigPath)) {
    localConfig = safeJsonParse(fs.readFileSync(localConfigPath, "utf8"), {});
  }
  if (fs.existsSync(settingsPath)) {
    settings = {
      ...settings,
      ...safeJsonParse(fs.readFileSync(settingsPath, "utf8"), {})
    };
  }

  function getPersistentModelRecordSync(uniKey, options = {}) {
    const { normalize = true } = options;
    if (!fs.existsSync(sqliteDbPath)) {
      return null;
    }

    const selectResult = childProcess.spawnSync(
      "sqlite3",
      ["-json", sqliteDbPath, `select jsonStr from persistentModel where uniKey='${escapeSqlString(uniKey)}';`],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      }
    );
    if (selectResult.status !== 0 || !String(selectResult.stdout || "").trim()) {
      return null;
    }

    let rows = [];
    try {
      rows = JSON.parse(String(selectResult.stdout || "[]"));
    } catch {
      return null;
    }

    const rawJson = rows[0] && typeof rows[0].jsonStr === "string"
      ? String(rows[0].jsonStr)
      : "";
    if (!rawJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(normalize ? maybeRepairUtf8Mojibake(rawJson) : rawJson);
      return normalize ? normalizeDataValue(parsed) : parsed;
    } catch {
      return null;
    }
  }

  function getPersistentModelRawJsonSync(uniKey) {
    if (!fs.existsSync(sqliteDbPath)) {
      return "";
    }

    const selectResult = childProcess.spawnSync(
      "sqlite3",
      ["-json", sqliteDbPath, `select jsonStr from persistentModel where uniKey='${escapeSqlString(uniKey)}';`],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      }
    );
    if (selectResult.status !== 0 || !String(selectResult.stdout || "").trim()) {
      return "";
    }

    try {
      const rows = JSON.parse(String(selectResult.stdout || "[]"));
      return rows[0] && typeof rows[0].jsonStr === "string" ? String(rows[0].jsonStr) : "";
    } catch {
      return "";
    }
  }

  function getPersistentModelTableColumnsSync() {
    if (persistentModelTableColumnsCache) {
      return persistentModelTableColumnsCache;
    }
    if (!fs.existsSync(sqliteDbPath)) {
      return null;
    }

    const pragmaResult = childProcess.spawnSync(
      "sqlite3",
      ["-json", sqliteDbPath, "pragma table_info('persistentModel');"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      }
    );
    if (pragmaResult.status !== 0 || !String(pragmaResult.stdout || "").trim()) {
      return null;
    }

    try {
      const rows = JSON.parse(String(pragmaResult.stdout || "[]"));
      const columns = new Set(
        Array.isArray(rows)
          ? rows
            .map((row) => (row && typeof row.name === "string" ? row.name : ""))
            .filter(Boolean)
          : []
      );
      persistentModelTableColumnsCache = columns.size ? columns : null;
      return persistentModelTableColumnsCache;
    } catch {
      return null;
    }
  }

  function upsertPersistentModelRecordSync(uniKey, namespace, data, existingRecord = null) {
    const currentRecord = existingRecord || getPersistentModelRecordSync(uniKey);
    const now = Date.now();
    const nextRecord = {
      ...(currentRecord || {}),
      uniKey,
      namespace,
      strategy: currentRecord?.strategy || "",
      strategyKey: currentRecord?.strategyKey || "",
      time: now,
      expireTime: now + 60 * 60 * 1000,
      clearTime: now + 7 * 24 * 60 * 60 * 1000,
      buyedEvent: currentRecord?.buyedEvent || "",
      vipChangeEvent: currentRecord?.vipChangeEvent || "false,false,false,false,false,",
      data
    };
    const json = JSON.stringify(nextRecord);
    let tableColumns = getPersistentModelTableColumnsSync();
    if (!tableColumns) {
      childProcess.spawnSync(
        "sqlite3",
        [
          sqliteDbPath,
          [
            "create table if not exists persistentModel (time BIGINT NULL, clearTime BIGINT NULL, uniKey text primary key, namespace text, jsonStr text);",
            "create index if not exists index_time on persistentModel (time asc);",
            "create index if not exists index_clearTime on persistentModel (clearTime asc);"
          ].join("\n")
        ],
        {
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024
        }
      );
      persistentModelTableColumnsCache = null;
      tableColumns = getPersistentModelTableColumnsSync();
    }

    const assignments = [
      ["uniKey", uniKey],
      ["jsonStr", json]
    ];
    if (tableColumns && tableColumns.has("namespace")) {
      assignments.push(["namespace", namespace]);
    }
    if (tableColumns && tableColumns.has("time")) {
      assignments.push(["time", String(nextRecord.time)]);
    }
    if (tableColumns && tableColumns.has("clearTime")) {
      assignments.push(["clearTime", String(nextRecord.clearTime)]);
    }

    const columns = assignments.map(([column]) => column);
    const values = assignments.map(([column, value]) => {
      if (column === "time" || column === "clearTime") {
        return String(Number(value) || 0);
      }
      return `'${escapeSqlString(value)}'`;
    });
    const updates = assignments
      .filter(([column]) => column !== "uniKey")
      .map(([column]) => `${column}=excluded.${column}`);

    const writeResult = childProcess.spawnSync(
      "sqlite3",
      [
        sqliteDbPath,
        [
          `insert into persistentModel(${columns.join(", ")}) values(${values.join(", ")})`,
          `on conflict(uniKey) do update set ${updates.join(", ")};`
        ].join("\n")
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      }
    );
    if (writeResult.status !== 0) {
      logger.warn(
        "[native:persistentModel:upsert-failed]",
        String(writeResult.stderr || writeResult.stdout || "").trim().slice(0, 400)
      );
    }
    return nextRecord;
  }

  function getPersistedHostSnapshot() {
    if (persistedHostCache) {
      return persistedHostCache;
    }
    const record = getPersistentModelRecordSync("host");
    const hostData = record && record.data && typeof record.data === "object" ? record.data : null;
    if (hostData) {
      persistedHostCache = hostData;
    }
    return hostData;
  }

  function getPersistedMusicCookiesSync() {
    if (!fs.existsSync(cookiesDbPath)) {
      return [];
    }

    const result = childProcess.spawnSync(
      "sqlite3",
      [
        "-json",
        cookiesDbPath,
        [
          "select host_key, name, value, path, is_secure, is_httponly, expires_utc",
          "from cookies",
          "where host_key like '%music.163.com%'",
          "order by length(host_key) desc, name asc;"
        ].join(" ")
      ],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024
      }
    );
    if (result.status !== 0) {
      return [];
    }

    try {
      const rows = JSON.parse(String(result.stdout || "[]"));
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function buildCookieHeaderFromRows(cookieRows = []) {
    const cookieMap = new Map();
    for (const row of cookieRows) {
      const name = String(row?.name || "").trim();
      const value = String(row?.value || "");
      if (!name || !value) {
        continue;
      }
      cookieMap.set(name, value);
    }
    return Array.from(cookieMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  async function restoreSessionCookiesFromPersistentStore() {
    const cookieRows = getPersistedMusicCookiesSync();
    for (const row of cookieRows) {
      const domain = String(row.host_key || "");
      const host = domain.replace(/^\./, "");
      if (!host) {
        continue;
      }

      const cookiePayload = {
        url: `${Number(row.is_secure) ? "https" : "http"}://${host}${row.path || "/"}`,
        domain,
        path: String(row.path || "/"),
        name: String(row.name || ""),
        value: String(row.value || ""),
        secure: Boolean(Number(row.is_secure)),
        httpOnly: Boolean(Number(row.is_httponly))
      };
      const expirationDate = chromeCookieExpiresUtcToUnixSeconds(row.expires_utc);
      if (expirationDate > 0) {
        cookiePayload.expirationDate = expirationDate;
      }

      try {
        await session.defaultSession.cookies.set(normalizeSetCookiePayload(cookiePayload));
      } catch (error) {
        logger.warn("[native:cookie-restore]", cookiePayload.name, error.message);
      }
    }
  }

  function syncPersistentHost(host = {}) {
    const uid = String(host.uid || "");
    if (!uid) {
      return null;
    }

    const currentRecord = getPersistentModelRecordSync("host");
    const currentData = currentRecord && currentRecord.data && typeof currentRecord.data === "object"
      ? currentRecord.data
      : {};
    const nextData = normalizeDataValue({
      ...currentData,
      uid,
      userName: String(host.userName || currentData.userName || ""),
      nickName: String(host.nickName || currentData.nickName || ""),
      avatarUrl: String(host.avatarUrl || currentData.avatarUrl || ""),
      avatarImgId: host.avatarImgId || currentData.avatarImgId || "",
      accountType: host.accountType ?? currentData.accountType ?? "",
      userType: host.userType ?? currentData.userType ?? 0,
      cellphone: String(host.cellphone || currentData.cellphone || ""),
      rememberLogin: host.rememberLogin ?? currentData.rememberLogin ?? true,
      isAnonymous: false,
      createAnonimousFailed: true
    });
    upsertPersistentModelRecordSync("host", "host", nextData, currentRecord);
    persistedHostCache = nextData;
    return nextData;
  }

  function normalizeBootstrapCookieRecord(cookie = {}) {
    const sameSite = String(cookie.sameSite || "").toLowerCase();
    return normalizeDataValue({
      domain: cookie.domain || null,
      Domain: cookie.domain || null,
      expires: cookie.expirationDate || null,
      Expires: cookie.expirationDate || null,
      name: cookie.name || "",
      Name: cookie.name || "",
      value: cookie.value || "",
      Value: cookie.value || "",
      path: cookie.path || "/",
      Path: cookie.path || "/",
      sameSite: sameSite || "unspecified",
      SameSite: sameSite || "unspecified",
      secure: Boolean(cookie.secure),
      Secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      HttpOnly: Boolean(cookie.httpOnly),
      partitioned: false,
      url: cookie.url || ""
    });
  }

  function buildBootstrapCookieHeader(cookies = []) {
    return cookies
      .map((cookie) => {
        const name = String(cookie?.name || cookie?.Name || "").trim();
        const value = String(cookie?.value || cookie?.Value || "");
        return name && value ? `${name}=${value}` : "";
      })
      .filter(Boolean)
      .join("; ");
  }

  function extractVipInfoFromResponse(text) {
    const parsed = safeJsonParse(text, null);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const candidate =
      parsed.data && typeof parsed.data === "object"
        ? parsed.data
        : parsed;
    if (!candidate || typeof candidate !== "object") {
      return null;
    }

    const hasUsefulVipFields =
      Object.prototype.hasOwnProperty.call(candidate, "associator") ||
      Object.prototype.hasOwnProperty.call(candidate, "redplus") ||
      Object.prototype.hasOwnProperty.call(candidate, "musicPackage") ||
      Object.prototype.hasOwnProperty.call(candidate, "albumVip") ||
      Object.prototype.hasOwnProperty.call(candidate, "userId");
    if (!hasUsefulVipFields) {
      return null;
    }

    return normalizeDataValue(candidate);
  }

  async function fetchVipInfoByCookieHeader(cookieHeader, host = {}) {
    const userId = String(host.uid || "");
    if (!userId || !cookieHeader) {
      return null;
    }

    try {
      const response = await fetch("https://music.163.com/api/music-vip-membership/client/vip/info", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://music.163.com",
          Referer: "https://music.163.com/",
          "X-Real-IP": "118.88.88.88",
          "X-Forwarded-For": "118.88.88.88",
          Cookie: cookieHeader
        },
        body: `userId=${encodeURIComponent(userId)}`
      });
      return extractVipInfoFromResponse(await response.text());
    } catch (error) {
      logger.warn("[native:vip-bootstrap]", error.message);
      return null;
    }
  }

  async function fetchHostByCookieHeader(cookieHeader) {
    if (!cookieHeader || !/(^|;\s*)MUSIC_U=/.test(cookieHeader)) {
      return null;
    }

    try {
      const response = await fetch("https://music.163.com/api/w/nuser/account/get", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://music.163.com",
          Referer: "https://music.163.com/",
          "X-Real-IP": "118.88.88.88",
          "X-Forwarded-For": "118.88.88.88",
          Cookie: cookieHeader
        },
        body: ""
      });
      return buildHostFromAuthResponse("/api/w/nuser/account/get", await response.text());
    } catch (error) {
      logger.warn("[native:host-bootstrap]", error.message);
      return null;
    }
  }

  async function buildSessionBootstrapState() {
    await restoreSessionCookiesFromPersistentStore();

    let cookies = await readCookies({ url: "https://music.163.com/" });
    if (!Array.isArray(cookies) || !cookies.length) {
      cookies = getPersistedMusicCookiesSync().map((row) =>
        normalizeBootstrapCookieRecord({
          url: `${Number(row.is_secure) ? "https" : "http"}://${String(row.host_key || "").replace(/^\./, "")}${row.path || "/"}`,
          domain: row.host_key || "",
          path: row.path || "/",
          name: row.name || "",
          value: row.value || "",
          secure: Boolean(Number(row.is_secure)),
          httpOnly: Boolean(Number(row.is_httponly)),
          expirationDate: chromeCookieExpiresUtcToUnixSeconds(row.expires_utc)
        })
      );
    } else {
      cookies = cookies.map((cookie) => normalizeBootstrapCookieRecord(cookie));
    }

    const cookieHeader = buildBootstrapCookieHeader(cookies);
    let host = getPersistedHostSnapshot();
    if (!host?.uid) {
      host = await fetchHostByCookieHeader(cookieHeader);
      if (host) {
        host = syncPersistentHost(host);
      }
    }

    const vipInfo = host?.uid ? await fetchVipInfoByCookieHeader(cookieHeader, host) : null;
    return normalizeDataValue({
      host: host && host.uid ? host : null,
      cookies,
      vipInfo: vipInfo || null
    });
  }

  async function emitSessionBootstrapUpdated() {
    try {
      const bootstrap = await buildSessionBootstrapState();
      if (bootstrap?.host?.uid) {
        emitNativeEvent("session.bootstrap.updated", bootstrap);
      }
    } catch (error) {
      logger.warn("[native:session-bootstrap:emit]", error.message);
    }
  }

  function normalizePersistentHostModelRow() {
    const record = getPersistentModelRecordSync("host");
    if (!record) {
      return;
    }

    const currentData = record && typeof record.data === "object" ? record.data : {};
    if (currentData.uid) {
      persistedHostCache = currentData;
      return;
    }

    const nextData = {
      ...currentData,
      createAnonimousFailed: true
    };
    upsertPersistentModelRecordSync("host", "host", nextData, record);
  }

  function normalizePersistentModelRecordSync(uniKey) {
    const rawJson = getPersistentModelRawJsonSync(uniKey);
    if (!rawJson) {
      return;
    }
    const normalizedJson = normalizeJsonText(maybeRepairUtf8Mojibake(rawJson));
    if (!normalizedJson || normalizedJson === rawJson) {
      return;
    }
    let record;
    try {
      record = JSON.parse(normalizedJson);
    } catch {
      return;
    }
    if (!record || !record.data || typeof record.data !== "object") {
      return;
    }
    upsertPersistentModelRecordSync(uniKey, record.namespace || uniKey, record.data, record);
  }

  normalizePersistentHostModelRow();
  normalizePersistentModelRecordSync("page:audio");
  normalizePersistentModelRecordSync("homePageEcpm");

  const isHomePageEcpmStoragePath = (targetPath = "") =>
    typeof targetPath === "string" && /(^|\/)homePageEcpm$/.test(targetPath.replace(/\\/g, "/"));

  const maybeSanitizeHomePageEcpmStorageText = (targetPath, text) =>
    isHomePageEcpmStoragePath(targetPath) ? sanitizeHomePageEcpmCacheText(text) : text;

  function saveLocalConfig() {
    fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2));
  }

  function saveSettings() {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  }

  function emitNativeEvent(name, ...args) {
    const window = mainWindowRef();
    if (!window || window.isDestroyed()) {
      return;
    }
    window.webContents.send("native:event", { name, args });
  }

  function resolveOrpheusPath(inputPath) {
    const rawPath = String(inputPath || "");
    if (!rawPath) {
      return null;
    }

    if (path.isAbsolute(rawPath) && fs.existsSync(rawPath)) {
      return rawPath;
    }

    const normalized = rawPath.replace(/\\/g, "/");
    const withoutLeading = normalized.replace(/^\/+/, "");

    if (normalized.startsWith("/resource/") || normalized.startsWith("resource/")) {
      return path.join(extractedRoot, withoutLeading);
    }
    if (normalized.startsWith("/pub/") || normalized.startsWith("pub/")) {
      const relativeAssetPath = withoutLeading.replace(/^pub\//, "");
      return path.join(assetRoot, relativeAssetPath);
    }
    if (normalized.startsWith("/storage/") || normalized.startsWith("storage/")) {
      const relativeStoragePath = withoutLeading.replace(/^storage\//, "");
      return path.join(storageRoot, relativeStoragePath);
    }
    if (normalized.startsWith("/cache/") || normalized.startsWith("cache/")) {
      const relativeCachePath = withoutLeading.replace(/^cache\//, "");
      return path.join(cacheRoot, relativeCachePath);
    }

    return path.join(storageRoot, withoutLeading);
  }

  async function executeSqlite(sqlText) {
    await ensureDir(path.dirname(sqliteDbPath));
    const normalizedSqlText = normalizeSqlTextLiterals(sqlText);
    const result = childProcess.spawnSync(
      "sqlite3",
      ["-json", sqliteDbPath],
      {
        encoding: "utf8",
        input: normalizedSqlText,
        maxBuffer: 16 * 1024 * 1024
      }
    );

    if (result.error) {
      throw result.error;
    }

    const stderr = String(result.stderr || "").trim();
    if (result.status !== 0) {
      if (/no such table/i.test(stderr)) {
        return [];
      }
      throw new Error(stderr || `sqlite3 exited with status ${result.status}`);
    }

    const stdout = String(result.stdout || "").trim();
    if (!stdout) {
      return [];
    }

    try {
      const rows = JSON.parse(stdout);
      return Array.isArray(rows) ? normalizeDataValue(rows) : [];
    } catch (error) {
      logger.warn("[native:sqlite:parse-failed]", error, stdout.slice(0, 400));
      return [];
    }
  }

  async function runStorageSql(requestId, sqlText) {
    try {
      const rows = await executeSqlite(sqlText);
      if (requestId) {
        emitNativeEvent("storage.onexecsqldone", requestId, 0, rows);
      }
      return rows;
    } catch (error) {
      logger.error("[native:sqlite]", error);
      if (requestId) {
        emitNativeEvent("storage.onexecsqldone", requestId, 1, []);
      }
      throw error;
    }
  }

  function normalizeStorageTarget(targetPath) {
    const resolved = resolveOrpheusPath(targetPath);
    if (!resolved) {
      return null;
    }
    if (
      isSubPath(storageRoot, resolved) ||
      isSubPath(extractedRoot, resolved) ||
      isSubPath(assetRoot, resolved)
    ) {
      return resolved;
    }
    return resolved;
  }

  function currentWindow() {
    return invocationWindow || mainWindowRef();
  }

  function storageTargetFromPathMode(pathMode, targetPath) {
    if (pathMode === "abs") {
      return String(targetPath || "");
    }
    return normalizeStorageTarget(targetPath);
  }

  async function readTextFile(targetPath) {
    if (!(await pathExists(targetPath))) {
      return "";
    }
    const content = await fsp.readFile(targetPath, "utf8");
    return maybeRepairUtf8Mojibake(content);
  }

  async function writeTextFile(targetPath, contents) {
    await ensureDir(path.dirname(targetPath));
    const normalizedContents = maybeRepairUtf8Mojibake(String(contents || ""));
    await fsp.writeFile(targetPath, normalizedContents, "utf8");
    return normalizedContents;
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

  async function moveFileIfNeeded(sourcePath, targetPath) {
    if (!sourcePath || !targetPath || sourcePath === targetPath) {
      return targetPath || sourcePath || "";
    }
    await ensureDir(path.dirname(targetPath));
    await fsp.rename(sourcePath, targetPath);
    return targetPath;
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

  async function deleteTarget(targetPath) {
    if (!(await pathExists(targetPath))) {
      return true;
    }
    await fsp.rm(targetPath, { recursive: true, force: true });
    return true;
  }

  async function listTarget(targetPath) {
    if (!(await pathExists(targetPath))) {
      return [];
    }
    const entries = await fsp.readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDir: entry.isDirectory(),
      path: toForwardSlash(path.join(targetPath, entry.name))
    }));
  }

  async function readCookies(cookieFilter = {}) {
    const cookies = await session.defaultSession.cookies.get(
      normalizeCookieFilter(cookieFilter)
    );
    return cookies.map(toCookieRecord);
  }

  async function setCookie(cookie) {
    await session.defaultSession.cookies.set(normalizeSetCookiePayload(cookie));
    return true;
  }

  async function removeCookie(cookie) {
    const normalized = normalizeSetCookiePayload(cookie);
    const url = normalized.url || `https://${normalized.domain || "music.163.com"}`;
    await session.defaultSession.cookies.remove(url, normalized.name);
    return true;
  }

  function sanitizeUserName(userName, accountType) {
    const normalizedUserName = String(userName || "");
    const typePrefix = String(accountType ?? "");
    if (!typePrefix) {
      return normalizedUserName;
    }
    return normalizedUserName.replace(`${typePrefix}_`, "");
  }

  function extractCellphoneFromBindings(bindings = []) {
    for (const binding of Array.isArray(bindings) ? bindings : []) {
      if (binding?.type !== 1 || typeof binding.tokenJsonStr !== "string") {
        continue;
      }
      const token = safeJsonParse(binding.tokenJsonStr, null);
      if (token && typeof token.cellphone === "string" && token.cellphone) {
        return token.cellphone;
      }
    }
    return "";
  }

  function buildHostFromAuthResponse(apiPath, text, rpcBody = null) {
    if (!text || typeof text !== "string") {
      return null;
    }
    const parsed = safeJsonParse(text, null);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const account = parsed.account && typeof parsed.account === "object" ? parsed.account : {};
    const profile = parsed.profile && typeof parsed.profile === "object" ? parsed.profile : {};
    const userId = String(
      profile.userId ||
      profile.userID ||
      account.id ||
      parsed.userId ||
      ""
    );
    if (!userId) {
      return null;
    }

    const requestPayload = rpcBody && rpcBody.payloadObject && typeof rpcBody.payloadObject === "object"
      ? rpcBody.payloadObject
      : {};
    const accountType = account.type ?? profile.accountType ?? "";
    return normalizeDataValue({
      uid: userId,
      userName: sanitizeUserName(account.userName || profile.userName || "", accountType),
      rememberLogin: true,
      nickName: String(profile.nickname || parsed.nickname || ""),
      accountType,
      avatarUrl: String(profile.avatarUrl || ""),
      avatarImgId: profile.avatarImgId || "",
      userType: profile.userType || 0,
      cellphone:
        extractCellphoneFromBindings(parsed.bindings) ||
        String(requestPayload.cellphone || requestPayload.phone || ""),
      isAnonymous: false,
      createAnonimousFailed: true
    });
  }

  function patchCellphoneExistenceResponse(text, rpcBody = null) {
    const parsed = safeJsonParse(text, null);
    if (!parsed || typeof parsed !== "object" || parsed.exist !== -1) {
      return text;
    }
    const rememberedHost = getPersistedHostSnapshot();
    const requestPayload = rpcBody && rpcBody.payloadObject && typeof rpcBody.payloadObject === "object"
      ? rpcBody.payloadObject
      : {};
    const requestPhone = String(requestPayload.cellphone || requestPayload.phone || "");
    const rememberedPhone = String(
      rememberedHost?.cellphone || rememberedHost?.userName || ""
    );
    if (!requestPhone || !rememberedPhone || requestPhone !== rememberedPhone) {
      return text;
    }
    return JSON.stringify({
      ...parsed,
      exist: 1,
      hasPassword: parsed.hasPassword ?? true
    });
  }

  async function initializeSessionState() {
    normalizePersistentHostModelRow();
    normalizePersistentModelRecordSync("page:audio");
    await restoreSessionCookiesFromPersistentStore();
    const hostRecord = getPersistedHostSnapshot();
    if (hostRecord?.uid) {
      return;
    }

    const cookies = await session.defaultSession.cookies.get({ url: "https://music.163.com/" });
    let cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    if (!/(^|;\s*)MUSIC_U=/.test(cookieHeader)) {
      cookieHeader = buildCookieHeaderFromRows(getPersistedMusicCookiesSync());
    }
    const hasMusicU = /(^|;\s*)MUSIC_U=/.test(cookieHeader);
    if (!hasMusicU) {
      return;
    }

    try {
      const host = await fetchHostByCookieHeader(cookieHeader);
      if (host) {
        syncPersistentHost(host);
      }
    } catch (error) {
      logger.warn("[native:init-session-state]", error.message);
    }
  }

  async function fetchWithSessionCookies(payload = {}) {
    const request = normalizeFetchPayload(payload);
    const initialUrl = request.url.startsWith("/")
      ? `https://interfacepc.music.163.com${request.url}`
      : request.url;
    const url = rewriteRpcUrl(initialUrl);
    const rpcBody = decodeRpcBody(
      request.options && typeof request.options.body === "string"
        ? request.options.body
        : ""
    );
    const apiPath = rpcBody && rpcBody.apiPath ? rpcBody.apiPath : "";
    const shouldSyncCookies = isAuthOrVipApiPath(apiPath);
    const options = {
      ...request.options
    };
    const headers = {
      ...(options.headers && typeof options.headers === "object" ? options.headers : {})
    };

    if (/music\.163\.com|126\.net|netease\.com/.test(url)) {
      headers.Origin = headers.Origin || "https://music.163.com";
      headers.origin = headers.origin || "https://music.163.com";
      headers.Referer = headers.Referer || "https://music.163.com/";
      headers.referer = headers.referer || "https://music.163.com/";

      if (!headers.Cookie && !headers.cookie) {
        const cookies = await session.defaultSession.cookies.get({ url });
        if (cookies.length > 0) {
          headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
        }
      }
    }

    options.headers = headers;
    logger.log("[native:network.fetch]", options.method || "GET", url);
    logger.log(
      "[native:network.fetch:request]",
      JSON.stringify({
        url,
        method: options.method || "GET",
        bodyType: typeof options.body,
        bodyPreview:
          typeof options.body === "string"
            ? options.body.slice(0, 240)
            : options.body && typeof options.body === "object"
              ? String(options.body).slice(0, 240)
              : options.body ?? null
      })
    );
    let activeResponse = await fetch(url, options);
    if (shouldSyncCookies) {
      await applyResponseCookies(session.defaultSession.cookies, activeResponse, url, logger);
    }
    let text = await activeResponse.text();
    if (/interfacepc\.music\.163\.com/.test(url)) {
      const emptyPlaceholder = !text.trim()
        ? true
        : text.trim() === "{\"code\":200,\"data\":{},\"message\":\"\"}";
      const shouldFallback = emptyPlaceholder || shouldForcePublicApiFallback(apiPath, text);
      if (shouldFallback) {
        let resolvedText = "";
        let resolvedResponse = null;
        const publicApiFallback = buildPublicApiFallbackRequest(url, rpcBody);
        if (publicApiFallback) {
          const fallbackOptions = {
            ...options,
            body: publicApiFallback.body,
            headers: {
              ...headers,
              Host: "music.163.com"
            }
          };
          logger.log(
            "[native:network.fetch:fallback]",
            JSON.stringify({
              fromUrl: url,
              toUrl: publicApiFallback.url,
              apiPath,
              bodyPreview: publicApiFallback.body.slice(0, 240)
            })
          );
          const fallbackResponse = await fetch(publicApiFallback.url, fallbackOptions);
          if (shouldSyncCookies) {
            await applyResponseCookies(
              session.defaultSession.cookies,
              fallbackResponse,
              publicApiFallback.url,
              logger
            );
          }
          const fallbackText = await fallbackResponse.text();
          const compatibilityFallback = buildCompatibilityFallbackRequest(
            apiPath,
            rpcBody && rpcBody.payloadObject ? rpcBody.payloadObject : {}
          );
          if (isJsonLikeRpcResponse(fallbackText) && isSuccessfulRpcResponse(fallbackText)) {
            resolvedText = fallbackText;
            resolvedResponse = fallbackResponse;
          } else if (compatibilityFallback) {
            logger.log(
              "[native:network.fetch:compat]",
              JSON.stringify({
                fromUrl: url,
                toUrl: compatibilityFallback.url,
                apiPath,
                bodyPreview: compatibilityFallback.body.slice(0, 240)
              })
            );
            const compatibilityResponse = await fetch(compatibilityFallback.url, {
              ...options,
              body: compatibilityFallback.body
            });
            if (shouldSyncCookies) {
              await applyResponseCookies(
                session.defaultSession.cookies,
                compatibilityResponse,
                compatibilityFallback.url,
                logger
              );
            }
            const compatibilityText = await compatibilityResponse.text();
            if (isJsonLikeRpcResponse(compatibilityText)) {
              resolvedText = compatibilityText;
              resolvedResponse = compatibilityResponse;
            }
          } else if (isJsonLikeRpcResponse(fallbackText)) {
            resolvedText = fallbackText;
            resolvedResponse = fallbackResponse;
          }
        }
        if (resolvedResponse) {
          activeResponse = resolvedResponse;
        }
        text = resolvedText || JSON.stringify(createEmptyRpcResponse(apiPath, url));
      }
    }
    text = maybeRepairUtf8Mojibake(text);
    text = normalizeJsonText(text);
    if (apiPath === "/api/cellphone/existence/check") {
      text = patchCellphoneExistenceResponse(text, rpcBody);
    }

    const authHost = buildHostFromAuthResponse(apiPath, text, rpcBody);
    if (authHost) {
      syncPersistentHost(authHost);
      await emitSessionBootstrapUpdated();
    }

    logger.log(
      "[native:network.fetch:response]",
      JSON.stringify({
        url,
        apiPath,
        status: activeResponse.status,
        textPreview: text.slice(0, 240)
      })
    );
    return callbackArgs(
      text,
      activeResponse.status,
      Object.fromEntries(activeResponse.headers.entries())
    );
  }

  function getLocalConfigValue(namespace, key) {
    if (typeof namespace === "undefined") {
      return localConfig;
    }
    if (typeof key === "undefined") {
      return localConfig[namespace];
    }
    return localConfig[namespace] ? localConfig[namespace][key] : undefined;
  }

  function setLocalConfigValue(namespace, key, value) {
    if (typeof namespace === "object" && namespace !== null) {
      localConfig = {
        ...localConfig,
        ...namespace
      };
      saveLocalConfig();
      return true;
    }

    if (typeof namespace === "string" && typeof key === "string") {
      const current = localConfig[namespace];
      localConfig[namespace] =
        current && typeof current === "object"
          ? { ...current, [key]: value }
          : { [key]: value };
      saveLocalConfig();
      return true;
    }

    if (typeof namespace === "string") {
      localConfig[namespace] = value;
      saveLocalConfig();
      return true;
    }

    return false;
  }

  const handlers = {
    "app.log": async (message) => {
      logger.log("[native]", message);
      return true;
    },
    "app.getappstartcommand": async () => ({}),
    "app.getstartcommand": async () => ({}),
    "app.getappstarttime": async () => 0,
    "app.getlocalconfig": async (namespace, key) => getLocalConfigValue(namespace, key),
    "app.setlocalconfig": async (namespace, key, value) =>
      setLocalConfigValue(namespace, key, value),
    "app.featuresswitch": async () => ({}),
    "app.getabtestkeys": async () => [],
    "app.abtestswitch": async () => false,
    "app.abtestswitchv2": async () => false,
    "app.getnativedata": async () => ({}),
    "app.getcooperation": async () => ({
      main: "",
      sub: ""
    }),
    "app.initurls": async () => ({}),
    "app.loadskinpackets": async () => true,
    "app.getdefaultmusicplaypath": async () => app.getPath("music"),
    "app.getappstarttype": async () => "normal",
    "app.systemvoicehint": async () => true,
    "app.systemuihint": async () => true,
    "app.onbootfinish": async () => true,
    "app.appstartupend": async () => true,
    "app.statis": async () => true,
    "app.statisv2": async () => true,
    "app.sendstatis": async () => true,
    "app.report2bi": async () => true,
    "app.setthumbnail": async () => true,
    "app.exit": async () => {
      app.quit();
      return true;
    },
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
    "app.setautorun": async () => {
      settings.autoRun = true;
      saveSettings();
      return true;
    },
    "app.cancelautorun": async () => {
      settings.autoRun = false;
      saveSettings();
      return true;
    },
    "app.getautorunstate": async () => settings.autoRun,
    "app.registerdefaultclient": async () => false,
    "app.unregisterdefaultclient": async () => false,
    "app.isregisterdefaultclient": async () => false,
    "app.logins": async () => true,
    "app.login": async () => true,
    "app.getsessionbootstrap": async () => buildSessionBootstrapState(),
    "app.syncsessionhost": async (host = {}) => {
      const normalized = host && typeof host === "object" ? normalizeDataValue(host) : {};
      const syncedHost = syncPersistentHost(normalized);
      return syncedHost || null;
    },
    "storage.init": async (downloadPath, _capacity, cachePath) => {
      const resolvedDownloadPath =
        normalizeStorageTarget(downloadPath) || app.getPath("downloads");
      const resolvedCachePath = normalizeStorageTarget(cachePath) || cacheRoot;
      await ensureDir(resolvedDownloadPath);
      await ensureDir(resolvedCachePath);
      return callbackArgs(resolvedDownloadPath, resolvedCachePath);
    },
    "storage.readfromfile": async (requestIdOrPayload, targetPath, _alone, pathMode) => {
      if (
        typeof requestIdOrPayload === "string" &&
        typeof targetPath === "string" &&
        typeof pathMode === "string"
      ) {
        const resolvedTarget = storageTargetFromPathMode(pathMode, targetPath);
        const content = resolvedTarget ? await readTextFile(resolvedTarget) : "";
        const sanitizedContent = maybeSanitizeHomePageEcpmStorageText(targetPath, content);
        emitNativeEvent("storage.onreadfromfiledone", requestIdOrPayload, 0, sanitizedContent);
        return sanitizedContent;
      }
      const payload = requestIdOrPayload || {};
      const resolvedTarget = normalizeStorageTarget(payload.path);
      if (!resolvedTarget) {
        return "";
      }
      return maybeSanitizeHomePageEcpmStorageText(payload.path, await readTextFile(resolvedTarget));
    },
    "storage.savetofile": async (
      requestIdOrPayload,
      content,
      _mode,
      targetPath,
      _alone,
      pathMode
    ) => {
      if (
        typeof requestIdOrPayload === "string" &&
        typeof targetPath === "string" &&
        typeof pathMode === "string"
      ) {
        const resolvedTarget = storageTargetFromPathMode(pathMode, targetPath);
        if (!resolvedTarget) {
          emitNativeEvent("storage.onsavetofiledone", requestIdOrPayload, 1);
          return false;
        }
        await writeTextFile(
          resolvedTarget,
          maybeSanitizeHomePageEcpmStorageText(targetPath, content || "")
        );
        emitNativeEvent("storage.onsavetofiledone", requestIdOrPayload, 0);
        return true;
      }
      const payload = requestIdOrPayload || {};
      const resolvedTarget = normalizeStorageTarget(payload.path);
      if (!resolvedTarget) {
        return "";
      }
      return writeTextFile(
        resolvedTarget,
        maybeSanitizeHomePageEcpmStorageText(payload.path, payload.content || "")
      );
    },
    "storage.writefile": async (payload = {}) => {
      const targetPath = normalizeStorageTarget(payload.path);
      if (!targetPath) {
        return "";
      }
      return writeTextFile(
        targetPath,
        maybeSanitizeHomePageEcpmStorageText(payload.path, payload.content || "")
      );
    },
    "storage.readfile": async (payload = {}) => {
      const targetPath = normalizeStorageTarget(payload.path);
      if (!targetPath) {
        return "";
      }
      return maybeSanitizeHomePageEcpmStorageText(payload.path, await readTextFile(targetPath));
    },
    "storage.deletefile": async (
      requestIdOrPayload,
      pathMode,
      _unused,
      targetPath,
      _isDeleteEmptyFlolder
    ) => {
      if (
        typeof requestIdOrPayload === "string" &&
        typeof pathMode === "string" &&
        typeof targetPath === "string"
      ) {
        const resolvedTarget = storageTargetFromPathMode(pathMode, targetPath);
        const result = resolvedTarget ? await deleteTarget(resolvedTarget) : false;
        emitNativeEvent(
          "storage.ondeletefilesdone",
          requestIdOrPayload,
          result ? 0 : 1,
          resolvedTarget || targetPath
        );
        return result;
      }
      const payload = requestIdOrPayload || {};
      const resolvedTarget = normalizeStorageTarget(payload.path);
      return resolvedTarget ? deleteTarget(resolvedTarget) : false;
    },
    "storage.listfile": async (requestIdOrPayload, pathMode, _unused, targetPath) => {
      if (
        typeof requestIdOrPayload === "string" &&
        typeof pathMode === "string"
      ) {
        const resolvedTarget = storageTargetFromPathMode(pathMode, targetPath || "storage");
        const entries = resolvedTarget ? await listTarget(resolvedTarget) : [];
        emitNativeEvent(
          "storage.onlistfile",
          requestIdOrPayload,
          0,
          entries.map((entry) => ({
            type: entry.isDir ? "dir" : "file",
            path: entry.path
          }))
        );
        return entries;
      }
      const payload = requestIdOrPayload || {};
      const resolvedTarget = normalizeStorageTarget(payload.path || "storage");
      return resolvedTarget ? listTarget(resolvedTarget) : [];
    },
    "storage.getsystemdir": async (payload = {}) => {
      const typeValue =
        payload && typeof payload === "object" ? payload.type || payload.key : payload;
      const numericMap = {
        108: app.getPath("downloads"),
        5: app.getPath("music"),
        2: userDataRoot
      };
      if (typeof typeValue === "number" && numericMap[typeValue]) {
        return {
          path: numericMap[typeValue]
        };
      }
      const key = String(typeValue || "").toLowerCase();
      const dirMap = {
        download: app.getPath("downloads"),
        music: app.getPath("music"),
        cache: cacheRoot,
        temp: tempRoot,
        user_data: userDataRoot,
        userdata: userDataRoot,
        storage: storageRoot
      };
      return {
        path: dirMap[key] || storageRoot
      };
    },
    "storage.playcacheinfo": async () => ({
      cachePath: cacheRoot,
      cacheSize: 0
    }),
    "storage.clearcache": async (targetPath = "") => {
      const resolvedTarget = normalizeStorageTarget(targetPath || cacheRoot);
      if (resolvedTarget) {
        await deleteTarget(resolvedTarget);
        await ensureDir(resolvedTarget);
      }
      emitNativeEvent("storage.onclearcache", Boolean(resolvedTarget));
      return true;
    },
    "storage.updatetemp": async (cacheKey, content = "") => {
      const filePath = path.join(tempRoot, `${hashString(String(cacheKey))}.json`);
      await writeTextFile(filePath, content);
      return true;
    },
    "storage.gettempfile": async (cacheKey) => {
      const filePath = path.join(tempRoot, `${hashString(String(cacheKey))}.json`);
      if (!(await pathExists(filePath))) {
        emitNativeEvent("storage.ongettempfile", cacheKey, 1, "");
        return "";
      }
      const content = await readTextFile(filePath);
      emitNativeEvent("storage.ongettempfile", cacheKey, 0, content);
      return content;
    },
    "storage.setplaycacheconfig": async () => true,
    "storage.querycachetracks": async () => [],
    "storage.querynewcachetracks": async () => [],
    "storage.querynewcachetrack": async () => null,
    "storage.fetch": async (payload = {}) => {
      const response = await fetch(payload.url, payload.options || {});
      const text = normalizeJsonText(maybeRepairUtf8Mojibake(await response.text()));
      return {
        ok: response.ok,
        status: response.status,
        text
      };
    },
    "linuxport.prepareaudio": async (payload = {}) => {
      const rawUrl =
        payload && typeof payload === "object" ? payload.url || payload.musicurl || "" : "";
      const normalizedUrl = normalizeAssetUrl(String(rawUrl || ""));
      if (!/^https:\/\/[^/]+\.music\.126\.net(\/|$)/i.test(normalizedUrl)) {
        return "";
      }

      const cacheDir = path.join(tempRoot, "prepared-audio");
      await ensureDir(cacheDir);
      const extension = guessFileExtensionFromUrl(normalizedUrl, ".bin");
      const filePath = path.join(cacheDir, `${hashString(normalizedUrl)}${extension}`);

      try {
        const stat = await fsp.stat(filePath);
        if (stat.isFile() && stat.size > 0) {
          return filePath;
        }
      } catch {
        // ignore cache miss and re-download below
      }

      const headers = {
        Origin: "https://music.163.com",
        origin: "https://music.163.com",
        Referer: "https://music.163.com/",
        referer: "https://music.163.com/",
        Accept: "audio/*,*/*;q=0.9"
      };
      const cookies = await session.defaultSession.cookies.get({ url: normalizedUrl });
      if (cookies.length > 0) {
        headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      }

      const response = await fetch(normalizedUrl, {
        method: "GET",
        headers
      });
      if (!response.ok) {
        throw new Error(`prepareaudio failed: ${response.status}`);
      }

      const bytes = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(filePath, bytes);
      return filePath;
    },
    "storage.imagesinfo": async () => [],
    "storage.execsql": async (requestIdOrSql = "", sqlText = "") => {
      if (typeof requestIdOrSql === "string" && typeof sqlText === "string") {
        const rows = await runStorageSql(requestIdOrSql, sqlText);
        return rows;
      }
      const rawSql =
        typeof requestIdOrSql === "string"
          ? requestIdOrSql
          : requestIdOrSql && typeof requestIdOrSql === "object"
            ? requestIdOrSql.sql || requestIdOrSql.query || ""
            : "";
      return executeSqlite(rawSql);
    },
    "storage.exectransaction": async (requestId = "", sqlText = "") => {
      const rows = await runStorageSql(requestId, sqlText);
      return rows;
    },
    "storage.testwriteable": async (payload = {}) => {
      const targetPath = normalizeStorageTarget(payload.path || storageRoot);
      if (!targetPath) {
        return false;
      }
      await ensureDir(targetPath);
      return true;
    },
    "storage.checkfilesexist": async (...args) => {
      const { files, baseDir } = normalizeStorageCheckFilesExistArgs(args);
      const resolvedBaseDir = normalizeStorageTarget(baseDir) || baseDir;

      const results = [];
      for (const file of files) {
        const fileId = String(file?.id || "");
        const rawPath = String(file?.path || "");
        let candidatePath = resolveDownloadFilePath(resolvedBaseDir, rawPath);
        if (!candidatePath && path.isAbsolute(rawPath)) {
          candidatePath = rawPath;
        }
        if (!candidatePath && rawPath) {
          candidatePath = resolveDownloadFilePath(resolvedBaseDir, rawPath.replace(/^\/+/, ""));
        }
        const exist = candidatePath ? await pathExists(candidatePath) : false;
        results.push({
          id: fileId,
          path: rawPath,
          exist
        });
      }
      return results;
    },
    "storage.addid3": async (payload = {}) => {
      const downloadDir =
        normalizeStorageTarget(payload.downloadDir) ||
        normalizeStorageTarget(payload.basePath) ||
        app.getPath("downloads");
      const sourceRelativePath = normalizeRelativeDownloadPath(payload.path || "");
      const targetRelativePath = normalizeRelativeDownloadPath(
        payload.finalPath || payload.newRelativePath || payload.relativePath || payload.path || ""
      );
      const sourcePath = resolveDownloadFilePath(downloadDir, sourceRelativePath);
      const targetPath = resolveDownloadFilePath(downloadDir, targetRelativePath);

      if (!sourcePath) {
        return { status: false, path: payload.path || "" };
      }
      if (!(await pathExists(sourcePath))) {
        return { status: false, path: sourceRelativePath };
      }

      const finalPath = await moveFileIfNeeded(sourcePath, targetPath || sourcePath);
      return {
        status: true,
        path: normalizeRelativeDownloadPath(path.relative(downloadDir, finalPath))
      };
    },
    "storage.querydownloadingprocess": async (...args) => {
      const inputItems = normalizeDownloadProcessQueryArgs(args);
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
    },
    "storage.startscandownload": async (...args) => {
      const { path: baseDir, excludePath } = normalizeStartScanDownloadArgs(args);
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
    },
    "storage.subscribecopyncmprocess": async (payload = {}) => {
      if (typeof payload?.callback === "function") {
        copyNcmSubscribers.add(payload.callback);
      }
      return true;
    },
    "storage.copyncm": async (payload = {}) => {
      const srcFiles = Array.isArray(payload?.srcFiles) ? payload.srcFiles : [];
      const destFiles = Array.isArray(payload?.destFiles) ? payload.destFiles : [];
      const copied = [];
      for (let index = 0; index < Math.min(srcFiles.length, destFiles.length); index += 1) {
        const src = String(srcFiles[index] || "");
        const dst = String(destFiles[index] || "");
        if (!src || !dst) {
          continue;
        }
        await ensureDir(path.dirname(dst));
        await fsp.copyFile(src, dst);
        const eventPayload = { type: "copyncm", code: 0, src, dst };
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
    },
    "browser.getcookies": async (payload = {}) => readCookies(payload),
    "browser.getfullcookies": async (payload = {}) => readCookies(payload),
    "browser.setcookie": async (payload = {}) => setCookie(payload),
    "browser.removecookie": async (firstArg = {}, secondArg) => {
      if (typeof firstArg === "string") {
        return removeCookie({ url: firstArg, name: secondArg || "" });
      }
      return removeCookie(firstArg);
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
        return {
          x: 0,
          y: 0,
          width: 0,
          height: 0
        };
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
        win.setMinimumSize(payload.x || 480, payload.y || 320);
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
        win.setTitle(payload.title || payload || "NetEase Cloud Music");
      }
      return true;
    },
    "winhelper.setwindowiconfromlocalfile": async () => true,
    "winhelper.updatemenu": async () => true,
    "winhelper.setusemediakey": async () => true,
    "winhelper.registerhotkey": async (nameOrPayload = {}, keyCodes, isGlobal, meta = {}) => {
      if (typeof nameOrPayload === "string") {
        settings.hotkeys[nameOrPayload] = {
          keyCodes: Array.isArray(keyCodes) ? keyCodes : [],
          isGlobal: Boolean(isGlobal)
        };
        saveSettings();
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
    },
    "desktop.support": async () => false,
    "desktop.create": async () => false,
    "desktop.show": async () => false,
    "desktop.load": async () => false,
    "desktop.destroy": async () => true,
    "trayicon.install": async () => false,
    "trayicon.uninstall": async () => true,
    "trayicon.seticon": async () => false,
    "trayicon.settooltip": async () => true,
    "trayicon.wasinstall": async () => false,
    "trayicon.popballoon": async () => false,
    "trayicon.geticon": async () => null,
    "trayicon.gettooltip": async () => "",
    "network.init": async () => ({
      supportRPC: true,
      maxFailCount: 100,
      nativeReportPercent: 0,
      normalReportPercent: 0
    }),
    "network.fetch": async (payload = {}) => fetchWithSessionCookies(payload),
    "network.diagnostic": async () => ({ ok: true }),
    "network.getenv": async () => ({ offline: false }),
    "network.getnetworkquality": async () => ({ score: 100, label: "unknown" }),
    "download.start": async (payload = {}) => startNativeDownload(payload),
    "download.download": async (payload = {}) => startNativeDownload(payload),
    "download.pause": async (payload = {}) => {
      const task = getDownloadTaskByPayload(normalizeDownloadPayloadArgs(payload));
      if (!task) {
        return true;
      }
      task.status = "paused";
      task.abortController.abort();
      return true;
    },
    "download.cancel": async (payload = {}) => {
      const task = getDownloadTaskByPayload(normalizeDownloadPayloadArgs(payload));
      if (!task) {
        return true;
      }
      task.status = "cancelled";
      task.abortController.abort();
      return true;
    },
    "download.querydownloadshecdule": async (...args) => {
      const inputItems = normalizeDownloadProcessQueryArgs(args);
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
    },
    "download.downloadsync": async (payload = {}) => downloadFileOnce(payload),
    "download.querydownloadingprocess": async (...args) => {
      const inputItems = normalizeDownloadProcessQueryArgs(args);
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
    },
    "player.setsmtcenable": async () => true,
    "player.settextalign": async () => true,
    "player.setlinemode": async () => true,
    "player.setdesktoplyrictopmost": async () => true,
    "player.showtranslatelyric": async () => true,
    "player.setlrccolor": async () => true,
    "player.setoutlinecolor": async () => true,
    "player.setoutlineshadow": async () => true,
    "player.showhorizontallyric": async () => true,
    "player.setlrcfont": async () => true,
    "player.setlock": async () => true,
    "player.setfont": async () => true,
    "player.removeall": async () => true,
    "player.setlrcslogan": async () => true,
    "player.addlistelement": async () => true,
    "audioplayer.immersesurroundsupport": async () => false,
    "audioplayer.immersesurroundsupportwatch": async () => true,
    "audioplayer.isdevicemute": async () => false,
    "audioplayer.setvolume": async () => true,
    "os.isonline": async () => true,
    "os.queryosver": async () => os.release(),
    "os.getdeviceid": async () => settings.deviceId,
    "os.getaddeviceid": async () => settings.deviceId,
    "os.getdeviceinfo": async () => ({
      hostname: os.hostname(),
      username: os.userInfo().username,
      arch: os.arch(),
      platform: os.platform()
    }),
    "os.getalldisplayinfo": async () =>
      screen.getAllDisplays().map((display) => ({
        id: display.id,
        bounds: display.bounds,
        workArea: display.workArea,
        workAreaSize: display.workAreaSize,
        scaleFactor: display.scaleFactor
      })),
    "os.getsysteminfo": async () => ({
      workArea: screen.getPrimaryDisplay().workArea,
      workAreaSize: screen.getPrimaryDisplay().workAreaSize,
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem()
    }),
    "os.navigateexternal": async (target) => shell.openExternal(String(target || "")),
    "os.querysystemfonts": async () => [],
    "os.checknativesupportfonts": async () => [],
    "os.exitwindowsystemlefttime": async () => 0,
    "os.exitwindowsystem": async () => false,
    "os.isfileexist": async (target) => {
      const targetPath = normalizeStorageTarget(target);
      return targetPath ? pathExists(targetPath) : false;
    },
    "os.shellopen": async (target) => shell.openPath(String(target || "")),
    "os.shellexplor": async (target) => {
      const resolved = normalizeStorageTarget(target);
      if (resolved) {
        shell.showItemInFolder(resolved);
      }
      return true;
    },
    "os.getdiskspace": async () => ({
      freeBytes: 0,
      totalBytes: 0
    }),
    "os.issystemdarkthemeenabled": async () => nativeTheme.shouldUseDarkColors,
    "os.callsystemappwithparam": async (payload = {}) => {
      const target = payload.url || payload.path || payload.target;
      if (!target) {
        return false;
      }
      if (/^https?:\/\//.test(target)) {
        await shell.openExternal(target);
      } else {
        await shell.openPath(target);
      }
      return true;
    },
    "os.setpowerrequests": async () => true,
    "update.getversion": async () => appVersion,
    "update.getvisualversion": async () => appVersion,
    "update.getdownloadversion": async () => appVersion,
    "update.startupdate": async () => false,
    "update.setupdatestate": async () => true,
    "update.checkpatchupdate": async () => false,
    "update.getcachedinstallpackageversion": async () => "",
    "process.call": async () => ({ ok: false, reason: "disabled-in-linux-port" }),
    "ipcservers.start": async () => true,
    "ipcservers.stop": async () => true,
    "ipcservers.send": async () => true,
    "musiclibrary.observelibrary": async () => true,
    "musiclibrary.addlibrary": async () => true,
    "musiclibrary.removeobservelibrary": async () => true,
    "musiclibrary.removelibrary": async () => true,
    "musiclibrary.removelibraryitems": async () => true,
    "musiclibrary.execsql": async () => [],
    "musiclibrary.readmusicinfo": async () => null,
    "musiclibrary.parsecueinfo": async () => null,
    "musiclibrary.getlibrarypath": async () => [],
    "im.enter": async () => false,
    "im.leave": async () => true,
    "rtc.enter": async () => false,
    "rtc.leave": async () => true,
    "nimsys.enter": async () => false,
    "nimsys.leave": async () => true,
    "audioplayer.play": async () => false,
    "audioplayer.load": async () => false,
    "audioplayer.pause": async () => true,
    "audioplayer.stop": async () => true,
    "audioplayer.seek": async () => true,
    "audioplayer.preload": async () => true,
    "audioplayer.setrefresfsongurlresult": async () => true,
    "audioplayer.setaudiostrategy": async () => true,
    "audioplayer.getsystemmastervolume": async () => 100,
    "audioplayer.getsystemaudioenhance": async () => false,
    "audioplayer.getsystemspatialsound": async () => false,
    "audioplayer.setcover": async () => true,
    "audioplayer.setdesktoplyrictranslatemode": async () => true,
    "audioplayer.setfont": async () => true,
    "audioplayer.setlock": async () => true,
    "audioplayer.switcheffect": async () => true,
    "audioplayer.subscribeDeskLyric": async () => true,
    "audioplayer.subscribedeskmousewheel": async () => true,
    "audioplayer.subscribedesklyricfontsize": async () => true,
    "audioplayer.subscribeminimodecloseapp": async () => true,
    "storage.downloadscanner": async () => []
  };

  async function invoke(command, args = [], context = {}) {
    const key = String(command || "").toLowerCase();
    invocationWindow = context.window || null;
    try {
      if (handlers[key]) {
        return handlers[key](...(Array.isArray(args) ? args : [args]));
      }

      if (!unknownCommands.has(key)) {
        unknownCommands.add(key);
        logger.warn("[native:stub]", "Unhandled command:", command, args);
      }

      if (key.startsWith("audioplayer.") || key.startsWith("desktop.") || key.startsWith("trayicon.")) {
        return false;
      }
      if (key.startsWith("player.")) {
        return true;
      }
      if (key.startsWith("musiclibrary.") || key.startsWith("download.") || key.startsWith("browser.")) {
        return [];
      }
      if (key.startsWith("os.") || key.startsWith("update.") || key.startsWith("app.")) {
        return null;
      }
      return null;
    } finally {
      invocationWindow = null;
    }
  }

  return {
    appVersion,
    assetRoot,
    cacheRoot,
    extractedRoot,
    generatedPath,
    initialize: initializeSessionState,
    invoke,
    emitNativeEvent,
    resolveOrpheusPath,
    storageRoot
  };
}

module.exports = {
  createNativeApi
};
