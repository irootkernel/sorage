export function hashQuery() {
  const qIdx = location.hash.indexOf("?");
  return qIdx === -1 ? "" : location.hash.slice(qIdx + 1);
}

export function decodeHashSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}
