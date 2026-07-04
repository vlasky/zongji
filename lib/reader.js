// Minimal parser over a mysql2 packet (or a bare buffer via append()),
// providing the subset of the node-mysql Parser interface that the binlog
// event classes consume.
class Parser {
  constructor(packet) {
    this.packet = null;
    this._buffer = null;
    this._offsetValue = 0;
    this._packetEndValue = 0;

    if (packet) {
      this.setPacket(packet);
    }
  }

  get _offset() {
    return this.packet ? this.packet.offset : this._offsetValue;
  }

  set _offset(value) {
    if (this.packet) {
      this.packet.offset = value;
    } else {
      this._offsetValue = value;
    }
  }

  get _packetEnd() {
    return this.packet ? this.packet.end : this._packetEndValue;
  }

  set _packetEnd(value) {
    if (this.packet) {
      this.packet.end = value;
    } else {
      this._packetEndValue = value;
    }
  }

  setPacket(packet) {
    this.packet = packet;
    this._buffer = packet.buffer;
  }

  append(buffer) {
    this.packet = null;
    this._buffer = buffer;
    this._offsetValue = 0;
    this._packetEndValue = buffer.length;
  }

  parseUnsignedNumber(bytes) {
    const offset = this._offset;
    this._offset += bytes;

    if (bytes <= 6) {
      return this._buffer.readUIntLE(offset, bytes);
    }

    if (bytes === 8) {
      const low = this._buffer.readUInt32LE(offset);
      const high = this._buffer.readUInt32LE(offset + 4);
      return (high * 0x100000000) + low;
    }

    throw new Error('Invalid unsigned integer size: ' + bytes);
  }

  parseLengthCodedNumber() {
    const first = this.parseUnsignedNumber(1);
    if (first < 251) return first;
    if (first === 251) return null;
    if (first === 252) return this.parseUnsignedNumber(2);
    if (first === 253) return this.parseUnsignedNumber(3);
    if (first === 254) return this.parseUnsignedNumber(8);
    throw new Error('Invalid length coded number');
  }

  parseBuffer(length) {
    if (length === undefined) {
      length = this._packetEnd - this._offset;
    }
    const start = this._offset;
    this._offset += length;
    return this._buffer.slice(start, start + length);
  }

  parseString(length) {
    const buffer = this.parseBuffer(length);
    return buffer.toString('utf8');
  }

  parsePacketTerminatedString() {
    return this.parseString(this._packetEnd - this._offset);
  }

  parseLengthCodedString() {
    const length = this.parseLengthCodedNumber();
    if (length === null) return null;
    return this.parseString(length);
  }

  reachedPacketEnd() {
    return this._offset >= this._packetEnd;
  }
}

export { Parser };
