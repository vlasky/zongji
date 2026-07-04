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
      ]);
      const serverId = options.serverId || 1;
      // Only BINLOG_DUMP_NON_BLOCK (0x01) exists server-side; the
      // BINLOG_THROUGH_* flags from the retired protocol docs were never
      // read by any MySQL server, and 0x02 now means "send v2 heartbeats"
      const flags = options.nonBlock ? 1 : 0;

      let outPacket;
      if (options.gtidSet != null) {
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

        // Track the current transaction GTID before event filtering, so
        // subsequent events can carry event.gtid even when 'gtid' events
        // themselves are excluded by includeEvents. When executed-set
        // tracking is active, commit markers and Previous_gtids also need
        // parsing before filtering.
        const isGtidEvent =
          eventName === 'gtid' || eventName === 'anonymousgtid';
        const isTrackedEvent = isGtidEvent ||
          ((zongji._executedGtids !== null || zongji._seedGtidsFromStream) &&
            (eventName === 'xid' || eventName === 'query' ||
              eventName === 'previousgtids'));
        if (isTrackedEvent) {
          try {
            event = binlogPacket.getEvent();
            if (isGtidEvent) {
              // Anonymous transactions have no usable GTID; do not let a
              // previous transaction's GTID leak onto their events
              zongji._currentGtid =
                eventName === 'gtid' ? event.gtid : undefined;
            }
            zongji._trackGtidProgress(eventName, event);
          } catch (err) {
            if (isGtidEvent) {
              zongji._currentGtid = undefined;
            }
            error = err;
          }
        }

        // A parse failure in a tracked event corrupts GTID/position
        // bookkeeping, so it must surface even when the event itself is
        // filtered out
        if (zongji._skipEvent(eventName) && !error) {
          return Binlog.prototype.binlogData;
        }

        if (!isTrackedEvent && !error) {
          try {
            event = binlogPacket.getEvent();
          } catch (err) {
            error = err;
          }
        }
        this._callback.call(this, error, event);
      }

      return Binlog.prototype.binlogData;
    }
  }

  return Binlog;
};
