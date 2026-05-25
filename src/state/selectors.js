export function findById(items = [], id) {
  return items.find((item) => item.id === id) || null;
}

export function rowsForOwner(rows = [], owner) {
  return rows.filter((row) => row.owner === owner || row.actor === owner);
}
