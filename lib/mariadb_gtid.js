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
    // domainId (number) -> { domainId, serverId, seqNo }; seqNo is a
    // BigInt so the full u64 sequence range stays exact
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
      const { domainId, serverId, seqNo } = parseSingleGtid(entry);
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
      // event.seqNo follows the Number-or-exact-string convention for
      // 64-bit values; BigInt accepts both and stays exact beyond 2^53
      seqNo: BigInt(gtid.seqNo),
    });
  }

  // Whether a transaction ('domain-server-sequence', e.g. an event.gtid)
  // is covered by this position. A position names the last transaction
  // processed per domain, and within a domain the binlog order is total,
  // so any earlier sequence number from the same server is covered.
  //
  // inclusive (default true) decides whether the position's own last
  // transaction counts as covered. A recorded position means that
  // transaction completed, so snapshot-barrier checks ("did my snapshot
  // already include this commit?") want the default. Redelivery
  // watermarks must pass { inclusive: false }: all events of a
  // transaction share one GTID, so an inclusive check would treat the
  // watermark transaction's own replayed events as already seen and drop
  // every one after the first.
  //
  // A server-id mismatch within a domain reports NOT covered even for a
  // lower sequence number: after a failover, sequence numbers can regress
  // under the new server id, so ordering against another server's
  // watermark is not meaningful; for at-least-once consumers an
  // idempotent redelivery is recoverable where a skip is not. An unknown
  // domain is likewise not covered. null/undefined (an event.gtid seen
  // before the stream's first GTID event) is never covered; a malformed
  // string throws, as it would corrupt rather than answer.
  covers(gtid, { inclusive = true } = {}) {
    if (gtid === undefined || gtid === null) {
      return false;
    }
    const { domainId, serverId, seqNo } = parseSingleGtid(gtid);
    const last = this._domains.get(domainId);
    if (!last || last.serverId !== serverId) {
      return false;
    }
    return inclusive ? seqNo <= last.seqNo : seqNo < last.seqNo;
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

function parseSingleGtid(gtid) {
  const entry = String(gtid).trim();
  const parts = entry.split('-');
  if (parts.length !== 3) {
    throw new Error(`Invalid MariaDB GTID: '${entry}'`);
  }
  return {
    domainId: parseUInt32(parts[0], entry),
    serverId: parseUInt32(parts[1], entry),
    seqNo: parseSeqNo(parts[2], entry),
  };
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
  // Decimal digits only: BigInt() alone would also accept '0x10' or '0b1'
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid MariaDB GTID in '${context}': '${text}'`);
  }
  // seq_no is u64; BigInt keeps it exact beyond 2^53
  const value = BigInt(text);
  if (value > 0xffffffffffffffffn) {
    throw new Error(`Invalid MariaDB GTID in '${context}': '${text}'`);
  }
  return value;
}

export { MariadbGtidPosition };
