export function normalizeGroupedEvents(payload = {}) {
  const safe    = payload || {};
  const grouped = safe.grouped || {};
  return {
    totalEvents: Number(safe.totalEvents || 0),
    actors: Object.entries(grouped).map(([actor, events]) => ({
      actor,
      events: Array.isArray(events) ? events : [],
    })),
  };
}
