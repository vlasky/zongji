// A MySQL GTID set: which transactions (per source) are already
// executed. String form matches @@gtid_executed / Previous_gtids, e.g.
//   3E11FA47-71CA-11E1-9E33-C80AA9429562:1-5:11-18,
//   2C256447-3F0D-431B-9A25-BDDF1F1F6EF6:1-27
// MySQL 8.3+ GTIDs may carry a tag; a (uuid, tag) pair is its own
// source, printed merged into the uuid's block after the untagged
// intervals: 'uuid:1-5:tag_a:1:tag_b:1' (tags lowercase, sorted).
// Intervals are stored internally as [start, end] inclusive BigInts, kept
// sorted and coalesced, so the full GNO range MySQL allows (1 to 2^63-1)
// is handled exactly; the public API stays strings in, strings and
// booleans out.
class GtidSet {
  constructor() {
    // uuid (lowercase, dashed) -> Map of tag ('' = untagged) ->
    // array of [start, end] inclusive
    this._sids = new Map();
  }

  // Accepts '', 'uuid:1-5', 'uuid:1-5:8,uuid2:3',
  // 'uuid:1-5:tag_a:1:tag_b:2-3' (whitespace tolerated). Within a uuid
  // block a non-numeric item is a tag naming the source of the interval
  // items that follow it, per the Gtid_set::add_gtid_text grammar.
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
      let tag = '';
      let intervals = 0;
      // A tag names the interval items that follow it, so a tag section
      // with none is malformed (the leading untagged section may be
      // empty: 'uuid:tag_a:1' has no untagged intervals)
      let sectionEmpty = false;
      for (const item of parts.slice(1)) {
        const trimmed = item.trim();
        if (TAG_REGEX.test(trimmed)) {
          if (sectionEmpty) {
            throw new Error(`GTID tag without intervals: '${entry.trim()}'`);
          }
          tag = trimmed.toLowerCase();
          sectionEmpty = true;
          continue;
        }
        const bounds = trimmed.split('-');
        const start = parsePositiveInt(bounds[0], entry);
        const end = bounds.length > 1 ?
          parsePositiveInt(bounds[1], entry) : start;
        if (bounds.length > 2 || end < start) {
          throw new Error(`Invalid GTID interval: '${entry.trim()}'`);
        }
        set._addInterval(uuid, tag, start, end);
        sectionEmpty = false;
        intervals++;
      }
      if (intervals === 0 || sectionEmpty) {
        throw new Error(`Invalid GTID set entry: '${entry.trim()}'`);
      }
    }
    return set;
  }

  // Adds a single transaction from a 'uuid:gno' or 'uuid:tag:gno' string
  add(gtid) {
    const { uuid, tag, gno } = parseSingleGtid(gtid);
    this._addInterval(uuid, tag, gno, gno);
  }

  // Whether a single transaction ('uuid:gno' or 'uuid:tag:gno', e.g. an
  // event.gtid) is already contained in the set. null/undefined (an
  // anonymous transaction's event.gtid) is never contained; a malformed
  // string throws, as it would corrupt rather than answer.
  contains(gtid) {
    if (gtid === undefined || gtid === null) {
      return false;
    }
    const { uuid, tag, gno } = parseSingleGtid(gtid);
    const tags = this._sids.get(uuid);
    const intervals = tags && tags.get(tag);
    if (!intervals) {
      return false;
    }
    return intervals.some(([start, end]) => gno >= start && gno <= end);
  }

  // Adds [start, end] inclusive for a (uuid, tag) source, keeping
  // intervals sorted and coalesced
  _addInterval(uuid, tag, start, end) {
    let tags = this._sids.get(uuid);
    if (!tags) {
      tags = new Map();
      this._sids.set(uuid, tags);
    }
    const existing = tags.get(tag) || [];
    existing.push([start, end]);
    // BigInt bounds: a subtraction comparator would hand sort() a BigInt,
    // which ToNumber rejects
    existing.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const merged = [existing[0]];
    for (let i = 1; i < existing.length; i++) {
      const last = merged[merged.length - 1];
      const next = existing[i];
      if (next[0] <= last[1] + 1n) {
        if (next[1] > last[1]) {
          last[1] = next[1];
        }
      } else {
        merged.push(next);
      }
    }
    tags.set(tag, merged);
  }

  isEmpty() {
    return this._sids.size === 0;
  }

  // Sorted (uuid, then tag, untagged first) flat list of
  // [uuid, tag, intervals] entries: the order both the text form and
  // the wire encoding require
  _sortedEntries() {
    return [...this._sids.entries()]
      .sort((a, b) => a[0] < b[0] ? -1 : 1)
      .flatMap(([uuid, tags]) => [...tags.entries()]
        .sort((a, b) => a[0] < b[0] ? -1 : 1)
        .map(([tag, intervals]) => [uuid, tag, intervals]));
  }

  toString() {
    let text = '';
    let lastUuid = null;
    for (const [uuid, tag, intervals] of this._sortedEntries()) {
      const ranges = intervals
        .map(([start, end]) => start === end ? `${start}` : `${start}-${end}`)
        .join(':');
      if (uuid === lastUuid) {
        text += `:${tag}:${ranges}`;
      } else {
        text += (text ? ',' : '') + uuid +
          (tag ? `:${tag}` : '') + `:${ranges}`;
        lastUuid = uuid;
      }
    }
    return text;
  }

  // Wire encoding used by COM_BINLOG_DUMP_GTID (and Previous_gtids).
  // Untagged sets use the classic layout accepted by every server
  // version: n_sids u64le, then per sid: 16-byte binary UUID,
  // n_intervals u64le, then per interval: start u64le, end-exclusive
  // u64le. A set containing any tagged source switches the whole
  // payload to the tagged format (MySQL 8.3+, sql/rpl_gtid_set.cc
  // encode_nsids_format): the first u64 becomes
  // (1 << 56) | (n_entries << 8) | 1, and every entry carries a tag
  // field (one length byte = length << 1, then the lowercase tag
  // bytes; 0x00 for untagged) between the UUID and the interval count.
  // Servers before 8.3 reject the tagged format as malformed.
  encode() {
    const entries = this._sortedEntries();
    const tagged = entries.some(([, tag]) => tag !== '');
    let length = 8;
    for (const [, tag, intervals] of entries) {
      length += 16 + (tagged ? 1 + tag.length : 0) + 8 +
        intervals.length * 16;
    }
    const buffer = Buffer.alloc(length);
    let offset = 0;
    const nSidsField = tagged ?
      (1n << 56n) | (BigInt(entries.length) << 8n) | 1n :
      BigInt(entries.length);
    offset = buffer.writeBigUInt64LE(nSidsField, offset);
    for (const [uuid, tag, intervals] of entries) {
      offset += Buffer.from(uuid.replace(/-/g, ''), 'hex')
        .copy(buffer, offset);
      if (tagged) {
        offset = buffer.writeUInt8(tag.length << 1, offset);
        offset += buffer.write(tag, offset, 'ascii');
      }
      offset = buffer.writeBigUInt64LE(BigInt(intervals.length), offset);
      for (const [start, end] of intervals) {
        offset = buffer.writeBigUInt64LE(start, offset);
        offset = buffer.writeBigUInt64LE(end + 1n, offset);
      }
    }
    return buffer;
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Tag grammar per libs/mysql/gtid/tag.cpp: a letter or underscore, then
// letters, digits or underscores, at most 32 characters, case-folded to
// lowercase. Cannot be confused with an interval (those start with a
// digit).
const TAG_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,31}$/;

function parseSingleGtid(gtid) {
  const parts = String(gtid).split(':');
  if (parts.length !== 2 && parts.length !== 3) {
    throw new Error(`Invalid GTID: '${gtid}'`);
  }
  const uuid = normaliseUuid(parts[0]);
  let tag = '';
  if (parts.length === 3) {
    const candidate = parts[1].trim();
    if (!TAG_REGEX.test(candidate)) {
      throw new Error(`Invalid GTID tag in '${gtid}'`);
    }
    tag = candidate.toLowerCase();
  }
  const gno = parsePositiveInt(parts[parts.length - 1].trim(), gtid);
  return { uuid, tag, gno };
}

function normaliseUuid(text) {
  const uuid = text.trim().toLowerCase();
  if (!UUID_REGEX.test(uuid)) {
    throw new Error(`Invalid GTID source UUID: '${text.trim()}'`);
  }
  return uuid;
}

function parsePositiveInt(text, context) {
  // Decimal digits only, per the MySQL GTID grammar: BigInt() alone would
  // also accept '0x10' or '0b1' and silently reinterpret them
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid GTID number in '${context}': '${text}'`);
  }
  const value = BigInt(text);
  // GNOs are signed 64-bit on the server and start at 1
  // (GNO_END = 2^63 - 1)
  if (value < 1n || value > 0x7fffffffffffffffn) {
    throw new Error(`Invalid GTID number in '${context}': '${text}'`);
  }
  return value;
}

export { GtidSet };
