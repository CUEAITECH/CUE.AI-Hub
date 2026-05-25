export function normalizeGroupedEvents(payload = {}) {
  const grouped = payload.grouped || {};
  return {
    totalEvents: Number(payload.totalEvents || 0),
    actors: Object.entries(grouped).map(([actor, events]) => ({
      actor,
      events: Array.isArray(events) ? events : [],
    })),
  };
}
