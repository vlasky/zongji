// A MySQL GTID set: which transactions (per source UUID) are already
// executed. String form matches @@gtid_executed / Previous_gtids, e.g.
//   3E11FA47-71CA-11E1-9E33-C80AA9429562:1-5:11-18,
//   2C256447-3F0D-431B-9A25-BDDF1F1F6EF6:1-27
// Intervals are stored internally as [start, end] inclusive, kept sorted
// and coalesced. GNOs are JavaScript Numbers: MySQL allows up to 2^63-1,
// but real-world transaction counts sit comfortably inside 2^53.
class GtidSet {
  constructor() {
    // uuid (lowercase, dashed) -> array of [start, end] inclusive
    this._sids = new Map();
  }

  // Accepts '', 'uuid:1-5', 'uuid:1-5:8,uuid2:3' (whitespace tolerated)
  static parse(text) {
    const set = new GtidSet();
    if (!text) {
      return set;
    }
    for (const entry of String(text).split(',')) {
      const parts = entry.trim().split(':');
      if (parts.length < 2) {
        throw new Error(`Invalid GTID set entry: '${entry.trim()}'`);
      }
      const uuid = normaliseUuid(parts[0]);
      for (const range of parts.slice(1)) {
        const bounds = range.split('-');
        const start = parsePositiveInt(bounds[0], entry);
        const end = bounds.length > 1 ?
          parsePositiveInt(bounds[1], entry) : start;
        if (bounds.length > 2 || end < start) {
          throw new Error(`Invalid GTID interval: '${entry.trim()}'`);
        }
        set._addInterval(uuid, start, end);
      }
    }
    return set;
  }

  // Adds a single transaction from a 'uuid:gno' string
  add(gtid) {
    const splitAt = gtid.lastIndexOf(':');
    if (splitAt === -1) {
      throw new Error(`Invalid GTID: '${gtid}'`);
    }
    const gno = parsePositiveInt(gtid.slice(splitAt + 1), gtid);
    this._addInterval(normaliseUuid(gtid.slice(0, splitAt)), gno, gno);
  }

  // Adds [start, end] inclusive for a uuid, keeping intervals sorted and
  // coalesced
  _addInterval(uuid, start, end) {
    const existing = this._sids.get(uuid) || [];
    existing.push([start, end]);
    existing.sort((a, b) => a[0] - b[0]);
    const merged = [existing[0]];
    for (let i = 1; i < existing.length; i++) {
      const last = merged[merged.length - 1];
      const next = existing[i];
      if (next[0] <= last[1] + 1) {
        last[1] = Math.max(last[1], next[1]);
      } else {
        merged.push(next);
      }
    }
    this._sids.set(uuid, merged);
  }

  isEmpty() {
    return this._sids.size === 0;
  }

  toString() {
    return [...this._sids.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .map(([uuid, intervals]) =>
        uuid + ':' + intervals
          .map(([start, end]) => start === end ? `${start}` : `${start}-${end}`)
          .join(':'))
      .join(',');
  }

  // Wire encoding used by COM_BINLOG_DUMP_GTID (and Previous_gtids):
  // n_sids u64le, then per sid: 16-byte binary UUID, n_intervals u64le,
  // then per interval: start u64le, end-exclusive u64le
  encode() {
    let length = 8;
    for (const intervals of this._sids.values()) {
      length += 16 + 8 + intervals.length * 16;
    }
    const buffer = Buffer.alloc(length);
    let offset = 0;
    offset = buffer.writeBigUInt64LE(BigInt(this._sids.size), offset);
    for (const [uuid, intervals] of this._sids.entries()) {
      offset += Buffer.from(uuid.replace(/-/g, ''), 'hex')
        .copy(buffer, offset);
      offset = buffer.writeBigUInt64LE(BigInt(intervals.length), offset);
      for (const [start, end] of intervals) {
        offset = buffer.writeBigUInt64LE(BigInt(start), offset);
        offset = buffer.writeBigUInt64LE(BigInt(end) + 1n, offset);
      }
    }
    return buffer;
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function normaliseUuid(text) {
  const uuid = text.trim().toLowerCase();
  if (!UUID_REGEX.test(uuid)) {
    throw new Error(`Invalid GTID source UUID: '${text.trim()}'`);
  }
  return uuid;
}

function parsePositiveInt(text, context) {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid GTID number in '${context}': '${text}'`);
  }
  return value;
}

export { GtidSet };
