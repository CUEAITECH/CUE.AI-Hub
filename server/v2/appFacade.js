const V2_APP_PREFIX = '/v2/app';

export function isV2AppPath(urlOrPath) {
  const pathname = typeof urlOrPath === 'string' ? urlOrPath : urlOrPath?.pathname;
  return pathname === V2_APP_PREFIX || pathname?.startsWith(`${V2_APP_PREFIX}/`);
}

export function toLegacyApiUrl(url) {
  const next = new URL(url.href);
  if (next.pathname === V2_APP_PREFIX) {
    next.pathname = '/api';
    return next;
  }
  next.pathname = `/api${next.pathname.slice(V2_APP_PREFIX.length)}`;
  return next;
}

export async function handleV2AppRequest({
  req,
  res,
  url,
  requiresApiKey,
  hasValidApiKey,
  hasValidSession,
  sendError,
  handleApi,
}) {
  const legacyUrl = toLegacyApiUrl(url);

  if (
    requiresApiKey(req, legacyUrl) &&
    !hasValidApiKey(req) &&
    !hasValidSession(req)
  ) {
    sendError(res, 401, 'invalid API key or session required');
    return true;
  }

  await handleApi(req, res, legacyUrl);
  return true;
}
