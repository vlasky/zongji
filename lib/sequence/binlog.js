import { EventEmitter } from 'events';
import initBinlogPacketClass from '../packet/binlog.js';
import { Parser } from '../reader.js';

const BINLOG_DUMP_COMMAND = 0x12;

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
        'serverId', 'position', 'filename', 'nonBlock',
      ]);
      const binlogPos = options.position || 4;
      const serverId = options.serverId || 1;
      const flags = options.nonBlock ? 1 : 0;
      const filename = options.filename || '';

      const length = 16 + Buffer.byteLength(filename, 'utf8');
      const outPacket = new SimplePacket(length);
      outPacket.writeInt8(BINLOG_DUMP_COMMAND);
      outPacket.writeInt32(binlogPos);
      outPacket.writeInt16(flags);
      outPacket.writeInt32(serverId);
      outPacket.writeNullTerminatedString(filename, 'utf8');
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
        // themselves are excluded by includeEvents
        const isGtidEvent =
          eventName === 'gtid' || eventName === 'anonymousgtid';
        if (isGtidEvent) {
          try {
            event = binlogPacket.getEvent();
            // Anonymous transactions have no usable GTID; do not let a
            // previous transaction's GTID leak onto their events
            zongji._currentGtid =
              eventName === 'gtid' ? event.gtid : undefined;
          } catch (err) {
            zongji._currentGtid = undefined;
            error = err;
          }
        }

        if (zongji._skipEvent(eventName)) {
          return Binlog.prototype.binlogData;
        }

        if (!isGtidEvent && !error) {
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
