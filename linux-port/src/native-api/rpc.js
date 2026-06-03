"use strict";

function safeJsonParse(contents, fallbackValue) {
  try {
    return JSON.parse(contents);
  } catch {
    return fallbackValue;
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
  const shouldKeepRpcEnvelope = apiPath.startsWith("/api/listen/together/");
  if (!shouldKeepRpcEnvelope) {
    delete payloadObject.header;
    delete payloadObject.e_r;
  }

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
    requestBody.set(key, typeof value === "string" ? value : JSON.stringify(value));
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

module.exports = {
  buildCompatibilityFallbackRequest,
  buildPublicApiFallbackRequest,
  createEmptyRpcResponse,
  decodeRpcBody,
  getRpcResponseCode,
  isAuthOrVipApiPath,
  isJsonLikeRpcResponse,
  isSuccessfulRpcResponse,
  rewriteRpcUrl,
  safeJsonParse,
  shouldForcePublicApiFallback
};
