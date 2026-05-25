export function mergePull(pulls = [], pull) {
  if (!pull?.id) return pulls;
  const exists = pulls.some((item) => item.id === pull.id);
  if (!exists) return [...pulls, pull];
  return pulls.map((item) => (item.id === pull.id ? { ...item, ...pull } : item));
}

export function applyPrReviewEvent(pulls = [], event = {}) {
  const prId = event.prId || event.pullId || event.pr_id;
  if (!prId) return pulls;
  return pulls.map((pull) => {
    if (pull.id !== prId && String(pull.number) !== String(prId)) return pull;
    return {
      ...pull,
      realtimeCompliance: {
        ...(pull.realtimeCompliance || {}),
        ...(event.complianceDelta || event.compliance || {}),
      },
    };
  });
}
