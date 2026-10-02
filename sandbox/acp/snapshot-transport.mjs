// A bounded reconnect window, not an event log. Revisions are opaque across
// process restarts. JSON splices preserve all fields without schema-specific
// merge rules (notably deleted permissions and optional lifecycle fields).
export function createSnapshotTransport(limit = 4) {
  const history = new Map();
  let latest;
  return {
    read(snapshot, base) {
      const serialized = JSON.stringify(snapshot);
      if (!latest || latest.serialized !== serialized) {
        latest = { revision: crypto.randomUUID(), serialized };
        history.set(latest.revision, serialized);
        while (history.size > limit)
          history.delete(history.keys().next().value);
      }
      const full = { revision: latest.revision, snapshot };
      const previous = history.get(base);
      if (previous === undefined) return full;
      if (previous === serialized)
        return {
          revision: latest.revision,
          base,
          start: 0,
          remove: 0,
          insert: "",
        };
      let start = 0;
      // Native substring comparisons avoid one JS iteration per historical
      // character on long sessions; inspect individual chars only at the edge.
      while (
        start + 1024 <= Math.min(previous.length, serialized.length) &&
        previous.slice(start, start + 1024) ===
          serialized.slice(start, start + 1024)
      )
        start += 1024;
      while (
        start < previous.length &&
        start < serialized.length &&
        previous[start] === serialized[start]
      )
        start++;
      let end = 0;
      while (
        end + 1024 <= Math.min(previous.length, serialized.length) - start &&
        previous.slice(previous.length - end - 1024, previous.length - end) ===
          serialized.slice(
            serialized.length - end - 1024,
            serialized.length - end,
          )
      )
        end += 1024;
      while (
        end < previous.length - start &&
        end < serialized.length - start &&
        previous[previous.length - 1 - end] ===
          serialized[serialized.length - 1 - end]
      )
        end++;
      const delta = {
        revision: latest.revision,
        base,
        start,
        remove: previous.length - start - end,
        insert: serialized.slice(start, serialized.length - end),
      };
      return JSON.stringify(delta).length < serialized.length ? delta : full;
    },
  };
}

export function readSnapshotUpdate(previous, wire) {
  if ("snapshot" in wire)
    return {
      revision: wire.revision,
      serialized: JSON.stringify(wire.snapshot),
      snapshot: wire.snapshot,
    };
  if (!previous || previous.revision !== wire.base)
    throw Error("Stale conversation revision. Read a full snapshot.");
  if (
    !Number.isInteger(wire.start) ||
    !Number.isInteger(wire.remove) ||
    wire.start < 0 ||
    wire.remove < 0 ||
    wire.start + wire.remove > previous.serialized.length
  )
    throw Error("Invalid conversation delta.");
  if (
    wire.revision === previous.revision &&
    wire.remove === 0 &&
    wire.insert === ""
  )
    return previous;
  const serialized =
    previous.serialized.slice(0, wire.start) +
    wire.insert +
    previous.serialized.slice(wire.start + wire.remove);
  return {
    revision: wire.revision,
    serialized,
    snapshot: JSON.parse(serialized),
  };
}
