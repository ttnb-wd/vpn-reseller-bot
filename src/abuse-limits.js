function createWindowLimiter({ windowMs, max, maxEntries = 10000 }) {
  const entries = new Map();
  return (key, now = Date.now()) => {
    if (key === undefined || key === null) return false;
    if (entries.size >= maxEntries) {
      for (const [id, entry] of entries) if (entry.until <= now) entries.delete(id);
      if (entries.size >= maxEntries && !entries.has(String(key))) entries.delete(entries.keys().next().value);
    }
    const id = String(key);
    const entry = entries.get(id);
    if (!entry || entry.until <= now) {
      entries.set(id, { count: 1, until: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
  };
}

module.exports = { createWindowLimiter };
