// A MariaDB GTID position: the last transaction processed per replication
// domain. String form matches @@gtid_binlog_pos / @@gtid_current_pos /
// @slave_connect_state, e.g. '0-1-1234,1-3-45'. Unlike MySQL GTID sets
// there are no intervals: within a domain the binlog order is total, so a
// single domain-server-sequence triple identifies everything before it,
// and a position holds at most one entry per domain. The server resumes a
// client by skipping event groups in each listed domain until it passes
// the given sequence number from the given server id; domains not listed
// are streamed from the beginning.
class MariadbGtidPosition {
  constructor() {
    // domainId (number) -> { domainId, serverId, seqNo }
    this._domains = new Map();
  }

  // Accepts '' or 'D-S-N[,D-S-N...]' (whitespace tolerated). Rejects two
  // entries for one domain, as the server would (ER_DUPLICATE_GTID_DOMAIN)
  static parse(text) {
    const position = new MariadbGtidPosition();
    if (!text) {
      return position;
    }
    for (const entry of String(text).split(',')) {
      const parts = entry.trim().split('-');
      if (parts.length !== 3) {
        throw new Error(`Invalid MariaDB GTID: '${entry.trim()}'`);
      }
      const domainId = parseUInt32(parts[0], entry);
      const serverId = parseUInt32(parts[1], entry);
      const seqNo = parseSeqNo(parts[2], entry);
      if (position._domains.has(domainId)) {
        throw new Error(
          `Duplicate replication domain ${domainId} in GTID position ` +
          `'${text}'`);
      }
      position._domains.set(domainId, { domainId, serverId, seqNo });
    }
    return position;
  }

  // Builds the position implied by a GTID_LIST_EVENT: the event may hold
  // several entries per domain (one per server id); the last entry of a
  // domain's run is the most recent, so plain per-domain overwrite in
  // event order yields the right watermark
  static fromGtidList(entries) {
    const position = new MariadbGtidPosition();
    for (const entry of entries) {
      position.add(entry);
    }
    return position;
  }

  // Records { domainId, serverId, seqNo } as the last transaction
  // processed in its domain. Deliberately an overwrite, not a max: after
  // a failover within a domain the newest transaction can carry a lower
  // sequence number under a different server id, and "last processed" is
  // what the server's skip rule keys on
  add(gtid) {
    this._domains.set(gtid.domainId, {
      domainId: gtid.domainId,
      serverId: gtid.serverId,
      seqNo: gtid.seqNo,
    });
  }

  isEmpty() {
    return this._domains.size === 0;
  }

  toString() {
    return [...this._domains.values()]
      .sort((a, b) => a.domainId - b.domainId)
      .map(({ domainId, serverId, seqNo }) =>
        `${domainId}-${serverId}-${seqNo}`)
      .join(',');
  }
}

function parseUInt32(text, context) {
  // Decimal digits only: Number() alone would also accept '1e3' or '0x10'
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid MariaDB GTID in '${context}': '${text}'`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > 0xffffffff) {
    throw new Error(`Invalid MariaDB GTID in '${context}': '${text}'`);
  }
  return value;
}

function parseSeqNo(text, context) {
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid MariaDB GTID in '${context}': '${text}'`);
  }
  // seq_no is u64; keep the Number-or-exact-string convention used for
  // other 64-bit values
  const value = Number(text);
  if (Number.isSafeInteger(value)) {
    return value;
  }
  if (BigInt(text) > 0xffffffffffffffffn) {
    throw new Error(`Invalid MariaDB GTID in '${context}': '${text}'`);
  }
  return text;
}

export { MariadbGtidPosition };
