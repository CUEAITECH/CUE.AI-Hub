export async function dispatchRoutes(routes, req, res, url) {
  for (const route of routes) {
    if (await route(req, res, url)) return true;
  }
  return false;
}
