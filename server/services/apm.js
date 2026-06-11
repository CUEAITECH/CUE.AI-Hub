/**
 * apm.js — HTTP 请求级 APM 指标（in-memory，随进程重启清零）
 *
 * 记录每条 HTTP 请求的 method / 路由模式 / 状态码 / 耗时，
 * 供 GET /v2/observability/http 端点消费。
 *
 * 路由模式化：把 /api/tasks/task_abc123 → /api/tasks/:id，
 * 避免高基数 key 爆内存。
 */

const MAX_ROUTES = 200;

// { routeKey → { count, errorCount, totalMs, p50Samples } }
const _buckets = new Map();
let _totalRequests = 0;
let _totalErrors = 0;
let _startedAt = Date.now();

function normalizeRoute(method, pathname) {
  const clean = pathname
    .replace(/\/task_[a-z0-9_]+/g,  '/:id')   // task IDs
    .replace(/\/fix_[a-z0-9_]+/g,   '/:id')
    .replace(/\/rev_[a-z0-9_]+/g,   '/:id')
    .replace(/\/[0-9a-f]{8,}/g,     '/:id')   // hex IDs
    .replace(/\/\d+/g,              '/:n')    // numeric segments
    .replace(/\?.*$/, '');                    // strip query string
  return `${method} ${clean}`;
}

export function recordRequest(method, pathname, statusCode, latencyMs) {
  _totalRequests++;
  if (statusCode >= 400) _totalErrors++;

  const key = normalizeRoute(method, pathname);
  if (!_buckets.has(key)) {
    if (_buckets.size >= MAX_ROUTES) return; // prevent unbounded growth
    _buckets.set(key, { count: 0, errorCount: 0, totalMs: 0, samples: [] });
  }
  const b = _buckets.get(key);
  b.count++;
  if (statusCode >= 400) b.errorCount++;
  b.totalMs += latencyMs;
  b.samples.push(latencyMs);
  if (b.samples.length > 100) b.samples.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export function getMetrics() {
  const uptimeSec = Math.round((Date.now() - _startedAt) / 1000);
  const routes = [];

  for (const [key, b] of _buckets) {
    const sorted = [...b.samples].sort((a, c) => a - c);
    routes.push({
      route:      key,
      count:      b.count,
      errorCount: b.errorCount,
      errorRate:  b.count ? Math.round(b.errorCount / b.count * 100) : 0,
      avgMs:      b.count ? Math.round(b.totalMs / b.count) : 0,
      p50Ms:      percentile(sorted, 50),
      p95Ms:      percentile(sorted, 95),
      p99Ms:      percentile(sorted, 99),
    });
  }

  routes.sort((a, b) => b.count - a.count);

  return {
    uptimeSec,
    totalRequests: _totalRequests,
    totalErrors:   _totalErrors,
    errorRate:     _totalRequests ? Math.round(_totalErrors / _totalRequests * 100) : 0,
    routes,
    collectedAt:   new Date().toISOString(),
  };
}

export function resetMetrics() {
  _buckets.clear();
  _totalRequests = 0;
  _totalErrors = 0;
  _startedAt = Date.now();
}
