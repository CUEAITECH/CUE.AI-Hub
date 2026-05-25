export function updateLlmStats(state, llm) {
  return { ...state, llm };
}

export function updateEvents(state, events) {
  return { ...state, events: Array.isArray(events) ? events : [] };
}

export function updateSyncHealth(state, syncHealth) {
  return { ...state, syncHealth };
}
