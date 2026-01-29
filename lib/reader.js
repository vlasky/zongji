// Constants for variable length encoded binary
export const NULL_COLUMN = 251;
export const UNSIGNED_CHAR_COLUMN = 251;
export const UNSIGNED_SHORT_COLUMN = 252;
export const UNSIGNED_INT24_COLUMN = 253;
export const UNSIGNED_INT64_COLUMN = 254;

const padWith = function(val, length) {
  const bits = val.split('');
  if (bits.length < length) {
    const left = length - bits.length;
    for (let j = left - 1; j >= 0; j--) {
      bits.unshift('0');
    }
    val = bits.join('');
  }

  return val;
};

class BufferReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.position = 0;
  }

  readUInt8() {
    const pos = this.position;
    this.position += 1;

    return this.buffer.readUInt8(pos);
  }

  readUInt16() {
    const pos = this.position;
    this.position += 2;

    return this.buffer.readUInt16LE(pos);
  }

  readUInt32() {
    const pos = this.position;
    this.position += 4;

    return this.buffer.readUInt32LE(pos);
  }

  readUInt24() {
    const low = this.readUInt16();
    const high = this.readUInt8();
    return (high << 16) + low;
  }

  readUInt64() {
    const pos = this.position;
    this.position += 8;

    // from http://stackoverflow.com/questions/17687307/convert-a-64bit-little-endian-integer-to-number
    return this.buffer.readInt32LE(pos) +
      0x100000000 * this.buffer.readUInt32LE(pos + 4);
  }

  readString() {
    const strBuf = this.buffer.slice(this.position);
    this.position = this.buffer.length;

    return strBuf.toString('ascii');
  }

  readStringInBytes(length) {
    const strBuf = this.buffer.slice(this.position, this.position + length);
    this.position += length;

    return strBuf.toString('ascii');
  }

  readHexInBytes(length) {
    const buf = this.buffer.slice(this.position, this.position + length);
    this.position += length;

    return buf.toString('hex');
  }

  readBytesArray(length) {
    const result = [];
    const hexString = this.readHexInBytes(length);
    for (let i = 0; i < hexString.length; i = i + 2) {
      result.push(parseInt(hexString.substr(i, 2), 16));
    }
    return result;
  }

  // Read a variable-length "Length Coded Binary" integer. This is derived
  // from the MySQL protocol, and re-used in the binary log format. This
  // format uses the first byte to alternately store the actual value for
  // integer values <= 250, or to encode the number of following bytes
  // used to store the actual value, which can be 2, 3, or 8. It also
  // includes support for SQL NULL as a special case.
  readVariant() {
    let result = null;
    const firstByte = this.readUInt8();

    if (firstByte < UNSIGNED_CHAR_COLUMN) {
      result = firstByte;
    } else if (firstByte === NULL_COLUMN) {
      result = null;
    } else if (firstByte === UNSIGNED_SHORT_COLUMN) {
      result = this.readUInt16();
    } else if (firstByte === UNSIGNED_INT24_COLUMN) {
      result = this.readUInt24();
    } else if (firstByte === UNSIGNED_INT64_COLUMN) {
      result = this.readUInt64();
    } else {
      throw new Error('Invalid variable-length integer');
    }

    return result;
  }

  // Read an arbitrary-length bitmap, provided its length.
  // Returns an array of true/false values.
  readBitArray(length) {
    const size = Math.floor((length + 7) / 8);

    const bytes = [];
    for (let i = size - 1; i >= 0; i--) {
      bytes.unshift(this.readUInt8());
    }

    const bitmap = [];
    const bitmapStr = bytes.map(function(aByte) {
      return padWith(aByte.toString(2), 8);
    }).join('');

    for (let k = bitmapStr.length - 1; k >= 0; k--) {
      bitmap.push(bitmapStr[k] === '1');
    }

    return bitmap.slice(0, length);
  }
}

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

export { BufferReader, Parser };
