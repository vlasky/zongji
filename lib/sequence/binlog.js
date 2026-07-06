import { EventEmitter } from 'events';
import initBinlogPacketClass from '../packet/binlog.js';
import { Parser } from '../reader.js';
import { GtidSet } from '../gtid_set.js';

const BINLOG_DUMP_COMMAND = 0x12;
// Auto-position dump: the server locates the starting binlog itself and
// skips transactions already in the supplied GTID set (requires
// gtid_mode=ON server-side)
const BINLOG_DUMP_GTID_COMMAND = 0x1e;

class Command extends EventEmitter {
  constructor() {
    super();
    this.next = null;
  }

  execute(packet, connection) {
    if (!this.next) {
      // @ts-ignore - start is defined in subclass
      this.next = this.start;
      connection._resetSequenceId();
    }
    if (packet && packet.isError && packet.isError()) {
      const err = packet.asError(connection.clientEncoding);
      // @ts-ignore - onResult is an optional callback property
      if (this.onResult) {
        // @ts-ignore
        this.onResult(err);
        this.emit('end');
      } else {
        this.emit('error', err);
        this.emit('end');
      }
      return true;
    }
    this.next = this.next(packet, connection);
    if (this.next) {
      return false;
    }
    this.emit('end');
    return true;
  }
}

class SimplePacket {
  constructor(length) {
    this.buffer = Buffer.allocUnsafe(length);
    this.offset = 4;
  }

  length() {
    return this.buffer.length;
  }

  writeInt8(value) {
    this.buffer.writeUInt8(value, this.offset);
    this.offset += 1;
  }

  writeInt16(value) {
    this.buffer.writeUInt16LE(value, this.offset);
    this.offset += 2;
  }

  writeInt24(value) {
    this.buffer.writeUIntLE(value, this.offset, 3);
    this.offset += 3;
  }

  writeInt32(value) {
    this.buffer.writeUInt32LE(value, this.offset);
    this.offset += 4;
  }

  writeNullTerminatedString(value, encoding) {
    const buf = Buffer.from(value, encoding);
    buf.copy(this.buffer, this.offset);
    this.offset += buf.length;
    this.writeInt8(0);
  }

  writeUInt64(value) {
    this.buffer.writeBigUInt64LE(BigInt(value), this.offset);
    this.offset += 8;
  }

  writeBuffer(value) {
    value.copy(this.buffer, this.offset);
    this.offset += value.length;
  }

  writeHeader(sequenceId) {
    const offset = this.offset;
    this.offset = 0;
    this.writeInt24(this.buffer.length - 4);
    this.writeInt8(sequenceId);
    this.offset = offset;
  }
}

export default function initBinlogClass(zongji) {
  const BinlogPacket = initBinlogPacketClass(zongji);

  class Binlog extends Command {
    constructor(callback) {
      super();
      this._callback = callback;
    }

    start(packet, connection) {
      const options = zongji.get([
        'serverId', 'position', 'filename', 'nonBlock', 'gtidSet',
        'requestAnnotateRows',
      ]);
      const serverId = options.serverId || 1;
      // Only BINLOG_DUMP_NON_BLOCK (0x01) exists server-side; the
      // BINLOG_THROUGH_* flags from the retired protocol docs were never
      // read by any MySQL server, and 0x02 now means "send v2 heartbeats"
      let flags = options.nonBlock ? 1 : 0;
      // MariaDB reuses 0x02 as BINLOG_SEND_ANNOTATE_ROWS_EVENT: without
      // it a capability>=2 client never receives ANNOTATE_ROWS events.
      // Never set it for MySQL, where the same bit requests v2 heartbeats
      if (zongji.isMariaDb && options.requestAnnotateRows) {
        flags |= 2;
      }

      let outPacket;
      // MariaDB has no COM_BINLOG_DUMP_GTID (it answers 0x1e with
      // ER_UNKNOWN_COM_ERROR): its GTID resume state was already sent via
      // SET @slave_connect_state, and the plain dump below then has its
      // filename/position ignored by the server
      if (options.gtidSet != null && !zongji.isMariaDb) {
        // COM_BINLOG_DUMP_GTID: empty filename and position 4 tell the
        // server to locate the first binlog file not fully contained in
        // the set; transactions in the set are skipped server-side.
        // Layout (all integers little-endian): flags(2), serverId(4),
        // filename length(4) + filename, position(8), set length(4) +
        // encoded set. An empty set encodes as eight zero bytes and
        // requests the server's complete history.
        const gtidData = GtidSet.parse(options.gtidSet).encode();
        outPacket = new SimplePacket(4 + 1 + 2 + 4 + 4 + 8 + 4 +
          gtidData.length);
        outPacket.writeInt8(BINLOG_DUMP_GTID_COMMAND);
        outPacket.writeInt16(flags);
        outPacket.writeInt32(serverId);
        outPacket.writeInt32(0); // empty filename
        outPacket.writeUInt64(4);
        outPacket.writeInt32(gtidData.length);
        outPacket.writeBuffer(gtidData);
      } else {
        const binlogPos = options.position || 4;
        const filename = options.filename || '';

        outPacket = new SimplePacket(
          16 + Buffer.byteLength(filename, 'utf8'));
        outPacket.writeInt8(BINLOG_DUMP_COMMAND);
        outPacket.writeInt32(binlogPos);
        outPacket.writeInt16(flags);
        outPacket.writeInt32(serverId);
        outPacket.writeNullTerminatedString(filename, 'utf8');
      }
      connection.writePacket(outPacket);
      return Binlog.prototype.binlogData;
    }

    binlogData(packet, connection) {
      if (packet.isEOF()) {
        this.emit('eof');
        return null;
      }

      if (packet.isError()) {
        const err = packet.asError(connection.clientEncoding);
        if (this._callback) {
          this._callback.call(this, err);
        } else {
          this.emit('error', err);
        }
        return null;
      }

      const parser = new Parser(packet);
      const binlogPacket = new BinlogPacket();
      binlogPacket.parse(parser);

      if (this._callback) {
        const eventName = binlogPacket.eventName
          ? binlogPacket.eventName.toLowerCase()
          : 'unknown';

        let event;
        let error;

        // Guards resume-pair bookkeeping below against a stale Command:
        // after stop()+start() a packet buffered on the old connection
        // must not mutate the new stream's options
        const isCurrent = !zongji.stopped && zongji.connection === connection;

        // Track the current transaction GTID before event filtering, so
        // subsequent events can carry event.gtid even when 'gtid' events
        // themselves are excluded by includeEvents. When executed-set
        // tracking is active, commit markers and Previous_gtids also need
        // parsing before filtering. Rotate events are parsed pre-filter
        // too: the (filename, position) resume pair must stay coherent
        // even when 'rotate' is excluded by includeEvents, otherwise
        // later filtered events would advance the position into the new
        // file while the filename still named the old one.
        const isGtidEvent = eventName === 'gtid' ||
          eventName === 'anonymousgtid' || eventName === 'mariadbgtid';
        const isRotate = eventName === 'rotate';
        // Commit markers are always parsed pre-filter: they detach the
        // in-flight GTID from subsequent events and end the resume
        // position freeze below, whatever includeEvents says
        const isCommitCandidate = eventName === 'xid' ||
          eventName === 'query' || eventName === 'xaprepare';
        const isTrackedEvent = isGtidEvent || isRotate ||
          isCommitCandidate ||
          ((zongji._executedGtids !== null || zongji._seedGtidsFromStream) &&
            (eventName === 'previousgtids' ||
              eventName === 'mariadbgtidlist'));

        if (isCurrent && eventName === 'tablemap') {
          // A multi-table statement writes all its TableMaps before
          // any row event, so no position between the first TableMap
          // and the commit marker is safe to resume from: with the
          // later TableMaps unseen, their rows would be silently
          // dropped. Freeze the resume position here; the commit
          // marker (or, defensively, the next transaction's GTID
          // event or a rotate, once parsed) unfreezes it, so a
          // persisted position always replays whole transactions
          // (at-least-once).
          zongji._positionFrozen = true;
        }

        // Set when this event definitively closes the current transaction;
        // its GTID is detached only after the event itself is delivered
        let closesTransaction = false;
        if (isTrackedEvent) {
          try {
            event = binlogPacket.getEvent();
            // All GTID/position bookkeeping is gated on isCurrent: after
            // stop()+start() a stale packet must not fold a previous
            // stream's GTID (possibly of the other server flavour) into
            // the new tracker state
            if (isCurrent) {
              if (isGtidEvent || isRotate) {
                // A successfully parsed group start or file boundary
                // means any open transaction ended; a parse failure
                // leaves the position freeze in place (stale positions
                // are recoverable, premature advances drop rows)
                zongji._positionFrozen = false;
              }
              if (isGtidEvent) {
                // Anonymous transactions have no usable GTID; do not let
                // a previous transaction's GTID leak onto their events
                zongji._currentGtid =
                  eventName === 'anonymousgtid' ? undefined : event.gtid;
              }
              if (isRotate) {
                // The payload position is the first event of the NEW
                // file: the only value coherent with binlogName (the
                // header nextPosition refers to the OLD file, 0 for the
                // artificial rotate at dump start)
                zongji.options.filename = event.binlogName;
                zongji.options.position = event.position;
              }
              closesTransaction =
                zongji._trackGtidProgress(eventName, event);
              if (closesTransaction) {
                // Unfrozen before the position updates below, so the
                // commit event's own end position is adopted
                zongji._positionFrozen = false;
              }
            }
          } catch (err) {
            // A GTID that cannot be parsed must not label other events;
            // an unparseable commit marker may have ended the current
            // transaction, so its GTID must not linger either. The
            // position freeze deliberately stays: the failed event might
            // equally be mid-transaction, and a frozen position is safe
            // (extra redelivery) where a premature advance drops rows
            if (isCurrent && (isGtidEvent || isCommitCandidate)) {
              zongji._currentGtid = undefined;
            }
            error = err;
          }
        }

        // A parse failure in a tracked event corrupts GTID/position
        // bookkeeping, so it must surface even when the event itself is
        // filtered out
        if (zongji._skipEvent(eventName) && !error) {
          // Filtered events must still advance the resume position, under
          // the same rules as delivered ones (never inside a frozen
          // transaction span, never from a rotate header, never adopting
          // MariaDB's zero end_log_pos). On MariaDB only commits and
          // standalone events carry a real end position, so filtering out
          // 'xid'/'query' would otherwise freeze options.position at the
          // start point.
          if (isCurrent && eventName !== 'tablemap' && !isRotate &&
              !zongji._positionFrozen && binlogPacket.nextPosition > 0) {
            zongji.options.position = binlogPacket.nextPosition;
          }
          if (closesTransaction) {
            zongji._currentGtid = undefined;
          }
          return Binlog.prototype.binlogData;
        }

        if (!isTrackedEvent && !error) {
          try {
            event = binlogPacket.getEvent();
          } catch (err) {
            error = err;
          }
        }
        // The commit event itself still carries the transaction's GTID;
        // whatever follows before the next GTID event belongs to no
        // transaction. The finally preserves that invariant even if a
        // 'binlog' handler throws while the commit event is delivered
        try {
          this._callback.call(this, error, event);
        } finally {
          if (closesTransaction) {
            zongji._currentGtid = undefined;
          }
        }
      }

      return Binlog.prototype.binlogData;
    }
  }

  return Binlog;
};
