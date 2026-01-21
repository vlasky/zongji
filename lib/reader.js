// Constants for variable length encoded binary
const NULL_COLUMN = 251;
const UNSIGNED_CHAR_COLUMN = 251;
const UNSIGNED_SHORT_COLUMN = 252;
const UNSIGNED_INT24_COLUMN = 253;
const UNSIGNED_INT64_COLUMN = 254;

function BufferReader(buffer) {
  this.buffer = buffer;
  this.position = 0;
}

BufferReader.prototype.readUInt8 = function() {
  const pos = this.position;
  this.position += 1;

  return this.buffer.readUInt8(pos);
};

BufferReader.prototype.readUInt16 = function() {
  const pos = this.position;
  this.position += 2;

  return this.buffer.readUInt16LE(pos);
};

BufferReader.prototype.readUInt32 = function() {
  const pos = this.position;
  this.position += 4;

  return this.buffer.readUInt32LE(pos);
};

BufferReader.prototype.readUInt24 = function() {
  const low = this.readUInt16();
  const high = this.readUInt8();
  return (high << 16) + low;
};

BufferReader.prototype.readUInt64 = function() {
  const pos = this.position;
  this.position += 8;

  // from http://stackoverflow.com/questions/17687307/convert-a-64bit-little-endian-integer-to-number
  return this.buffer.readInt32LE(pos) +
    0x100000000 * this.buffer.readUInt32LE(pos + 4);
};

BufferReader.prototype.readString = function() {
  const strBuf = this.buffer.slice(this.position);
  this.position = this.buffer.length;

  return strBuf.toString('ascii');
};

BufferReader.prototype.readStringInBytes = function(length) {
  const strBuf = this.buffer.slice(this.position, this.position + length);
  this.position += length;

  return strBuf.toString('ascii');
};

BufferReader.prototype.readHexInBytes = function(length) {
  const buf = this.buffer.slice(this.position, this.position + length);
  this.position += length;

  return buf.toString('hex');
};

BufferReader.prototype.readBytesArray = function(length) {
  const result = [];
  const hexString = this.readHexInBytes(length);
  for (let i = 0; i < hexString.length; i = i + 2) {
    result.push(parseInt(hexString.substr(i, 2), 16));
  }
  return result;
};

// Read a variable-length "Length Coded Binary" integer. This is derived
// from the MySQL protocol, and re-used in the binary log format. This
// format uses the first byte to alternately store the actual value for
// integer values <= 250, or to encode the number of following bytes
// used to store the actual value, which can be 2, 3, or 8. It also
// includes support for SQL NULL as a special case.
BufferReader.prototype.readVariant = function() {
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
};

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

// Read an arbitrary-length bitmap, provided its length.
// Returns an array of true/false values.
BufferReader.prototype.readBitArray = function(length) {
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
};

exports.BufferReader = BufferReader;

function Parser(packet) {
  this.packet = null;
  this._buffer = null;
  this._offsetValue = 0;
  this._packetEndValue = 0;

  if (packet) {
    this.setPacket(packet);
  }
}

Object.defineProperty(Parser.prototype, '_offset', {
  get: function() {
    return this.packet ? this.packet.offset : this._offsetValue;
  },
  set: function(value) {
    if (this.packet) {
      this.packet.offset = value;
    } else {
      this._offsetValue = value;
    }
  }
});

Object.defineProperty(Parser.prototype, '_packetEnd', {
  get: function() {
    return this.packet ? this.packet.end : this._packetEndValue;
  },
  set: function(value) {
    if (this.packet) {
      this.packet.end = value;
    } else {
      this._packetEndValue = value;
    }
  }
});

Parser.prototype.setPacket = function(packet) {
  this.packet = packet;
  this._buffer = packet.buffer;
};

Parser.prototype.append = function(buffer) {
  this.packet = null;
  this._buffer = buffer;
  this._offsetValue = 0;
  this._packetEndValue = buffer.length;
};

Parser.prototype.parseUnsignedNumber = function(bytes) {
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
};

Parser.prototype.parseLengthCodedNumber = function() {
  const first = this.parseUnsignedNumber(1);
  if (first < 251) return first;
  if (first === 251) return null;
  if (first === 252) return this.parseUnsignedNumber(2);
  if (first === 253) return this.parseUnsignedNumber(3);
  if (first === 254) return this.parseUnsignedNumber(8);
  throw new Error('Invalid length coded number');
};

Parser.prototype.parseBuffer = function(length) {
  if (length === undefined) {
    length = this._packetEnd - this._offset;
  }
  const start = this._offset;
  this._offset += length;
  return this._buffer.slice(start, start + length);
};

Parser.prototype.parseString = function(length) {
  const buffer = this.parseBuffer(length);
  return buffer.toString('utf8');
};

Parser.prototype.parsePacketTerminatedString = function() {
  return this.parseString(this._packetEnd - this._offset);
};

Parser.prototype.parseLengthCodedString = function() {
  const length = this.parseLengthCodedNumber();
  if (length === null) return null;
  return this.parseString(length);
};

Parser.prototype.reachedPacketEnd = function() {
  return this._offset >= this._packetEnd;
};

exports.Parser = Parser;
