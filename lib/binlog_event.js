import * as Common from './common.js';
import { collationToCharset, charsetMaxLength } from './charset_map.js';

// TABLE_MAP_EVENT optional metadata field type codes (MySQL 8.0+).
// binlog_row_metadata=MINIMAL writes SIGNEDNESS, the charset fields and
// GEOMETRY_TYPE; FULL adds COLUMN_NAME, SET/ENUM_STR_VALUE, the primary
// key fields and COLUMN_VISIBILITY.
const OptionalMetadataTypes = {
  SIGNEDNESS: 1,
  DEFAULT_CHARSET: 2,
  COLUMN_CHARSET: 3,
  COLUMN_NAME: 4,
  SET_STR_VALUE: 5,
  ENUM_STR_VALUE: 6,
  GEOMETRY_TYPE: 7,
  SIMPLE_PRIMARY_KEY: 8,
  PRIMARY_KEY_WITH_PREFIX: 9,
  ENUM_AND_SET_DEFAULT_CHARSET: 10,
  ENUM_AND_SET_COLUMN_CHARSET: 11,
  COLUMN_VISIBILITY: 12,
};

// Column classification used by the optional metadata bitmaps and lists,
// matching the server's is_numeric_type/is_character_type (sql/log_event.cc).
// The SIGNEDNESS bitmap covers numeric columns (YEAR included); the charset
// lists cover string columns (binary ones appear with collation 63), with
// ENUM and SET columns covered by their own ENUM_AND_SET_* fields.
const NUMERIC_METADATA_TYPES = new Set([
  Common.MysqlTypes.DECIMAL,
  Common.MysqlTypes.TINY,
  Common.MysqlTypes.SHORT,
  Common.MysqlTypes.INT24,
  Common.MysqlTypes.LONG,
  Common.MysqlTypes.LONGLONG,
  Common.MysqlTypes.NEWDECIMAL,
  Common.MysqlTypes.FLOAT,
  Common.MysqlTypes.DOUBLE,
  Common.MysqlTypes.YEAR,
]);
const CHARACTER_METADATA_TYPES = new Set([
  Common.MysqlTypes.VARCHAR,
  Common.MysqlTypes.VAR_STRING,
  Common.MysqlTypes.STRING,
  Common.MysqlTypes.BLOB,
  Common.MysqlTypes.TINY_BLOB,
  Common.MysqlTypes.MEDIUM_BLOB,
  Common.MysqlTypes.LONG_BLOB,
  // MariaDB COMPRESSED columns count as character columns in the charset
  // lists (verified against a live 11.8 FULL-metadata TableMap)
  Common.MysqlTypes.BLOB_COMPRESSED,
  Common.MysqlTypes.VARCHAR_COMPRESSED,
]);
const BINARY_COLLATION_ID = 63;

const withPrecision = function(typeName, decimals) {
  return decimals ? `${typeName}(${decimals})` : typeName;
};

// Field_geom::geometry_type values from the GEOMETRY_TYPE metadata field
const GEOMETRY_TYPE_NAMES = [
  'geometry', 'point', 'linestring', 'polygon',
  'multipoint', 'multilinestring', 'multipolygon', 'geomcollection',
];

// The BLOB length prefix width distinguishes the four TEXT/BLOB sizes
const BLOB_TYPE_NAMES = {
  1: ['tinyblob', 'tinytext'],
  2: ['blob', 'text'],
  3: ['mediumblob', 'mediumtext'],
  4: ['longblob', 'longtext'],
};

// ENUM/SET value strings arrive as raw bytes in the column's own charset
const decodeEnumSetValues = function(buffers, charsetName) {
  if (!buffers) return [];
  return buffers.map(buffer => {
    const decoded = Common.decodeTextColumn(buffer, charsetName);
    // The value list must contain strings; on an unknown charset (the
    // helper returns the buffer unchanged) fall back to utf8
    return typeof decoded === 'string' ? decoded : buffer.toString('utf8');
  });
};

//TODO get rid parser from binlog event class
// probably a factory to create them
class BinlogEvent {
  constructor(parser, options) {
    this.timestamp = options.timestamp;
    this.nextPosition = options.nextPosition;
    this.size = options.size;
  }

  getEventName() {
    return this.getTypeName().toLowerCase();
  }

  getTypeName() {
    return this.constructor.name;
  }

  dump() {
    console.log('=== %s ===', this.getTypeName());
    console.log('Date: %s', new Date(this.timestamp));
    console.log('Next log position: %d', this.nextPosition);
    console.log('Event size:', this.size);
  }

  _readTableId(parser) {
    this.tableId = Common.parseUInt48(parser);
  }
}

/* Change MySQL bin log file
 * Attributes:
 *   position: Position inside next binlog
 *   binlogName: Name of next binlog file
 */

class Rotate extends BinlogEvent {
  constructor(parser, options) {
    super(parser, options);
    this.position = Common.parseUInt64(parser);
    this.binlogName = parser.parseString(this.size - 8);
  }

  dump() {
    console.log('=== %s ===', this.getTypeName());
    console.log('Event size: %d', (this.size));
    console.log('Position: %d', this.position);
    console.log('Next binlog file: %s', this.binlogName);
  }
}

class Format extends BinlogEvent {
  constructor(parser, options) {
    super(parser, options);
  }
}

const formatUuid = Common.formatUuid;

// MariaDB log_bin_compress=ON event code (the rows variants live in
// rows_event.js)
const QUERY_COMPRESSED_EVENT = 0xa5;

const skipEventRemainder = function(parser, zongji) {
  const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
  const target = parser._packetEnd - checksumBytes;
  if (parser._offset < target) {
    parser._offset = target;
  }
};

// MySQL 8.3+ GTID_TAGGED_LOG_EVENT; the classic code is 33
const GTID_TAGGED_LOG_EVENT = 42;

class Gtid extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    if (options.eventType === GTID_TAGGED_LOG_EVENT) {
      this._parseTagged(parser, zongji);
    } else {
      this.flags = parser.parseUnsignedNumber(1);
      this.sid = formatUuid(parser.parseBuffer(16));
      // Number within the safe range, exact string beyond it (like BIGINT
      // values), so a colossal GNO degrades to a parse error downstream
      // instead of silently corrupting the executed set
      this.gno = Common.parseUInt64(parser);
      this.gtid = this.sid + ':' + this.gno;
    }
    skipEventRemainder(parser, zongji);
  }

  // Tagged GTID events (written iff the transaction's GTID carries a
  // tag) have no fixed layout: the body is one mysql::serialization
  // message of varint-id-prefixed fields in ascending id order, with
  // absent fields taking defaults (libs/mysql/binlog/event/
  // control_events.h Gtid_event::define_fields, MySQL 8.4). Only the
  // fields the classic event also exposes are kept; the rest
  // (timestamps, logical clock, transaction length, server versions,
  // commit group ticket) are skipped via the message's encoded size.
  _parseTagged(parser, zongji) {
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    const end = parser._packetEnd - checksumBytes;
    const bodyStart = parser._offset;
    const what = 'tagged GTID event';
    const version = Common.parseSerializationVarint(parser, end, what);
    if (version !== 1n) {
      throw new Error(
        `Unsupported tagged GTID serialization version ${version}`);
    }
    const encodedSize =
      Number(Common.parseSerializationVarint(parser, end, what));
    // The encoded size spans the whole message from the version varint;
    // all further reads are bounded by it so a corrupt size cannot make
    // field data leak in from beyond the message
    const messageEnd = Math.min(bodyStart + encodedSize, end);
    const varint = () =>
      Common.parseSerializationVarint(parser, messageEnd, what);
    const lastNonIgnorableId = varint();
    if (lastNonIgnorableId > 12n) {
      throw new Error('Tagged GTID event requires unknown field ' +
        `${lastNonIgnorableId - 1n}`);
    }
    // Field ids up to 11 always encode as one byte (id << 1), so the
    // next field's id can be peeked without consuming it
    const nextFieldIs = (id) =>
      parser._offset < messageEnd &&
      parser._buffer[parser._offset] === id << 1;

    this.flags = 0;
    if (nextFieldIs(0)) {
      parser.parseUnsignedNumber(1);
      this.flags = Number(varint());
    }
    if (!nextFieldIs(1)) {
      throw new Error('Tagged GTID event without a source UUID');
    }
    parser.parseUnsignedNumber(1);
    // The 16 UUID bytes are serialized as 16 individual varints
    // (1-2 wire bytes each), not as a raw byte string
    const uuid = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      uuid[i] = Number(varint());
    }
    this.sid = formatUuid(uuid);
    if (!nextFieldIs(2)) {
      throw new Error('Tagged GTID event without a GNO');
    }
    parser.parseUnsignedNumber(1);
    const gno =
      Common.parseSerializationVarintSigned(parser, messageEnd, what);
    this.gno = gno >= BigInt(Number.MIN_SAFE_INTEGER) &&
      gno <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(gno) : String(gno);
    this.tag = '';
    if (nextFieldIs(3)) {
      parser.parseUnsignedNumber(1);
      const tagLength = Number(varint());
      if (tagLength > 32 || parser._offset + tagLength > messageEnd) {
        throw new Error('Invalid tagged GTID tag length ' + tagLength);
      }
      this.tag = parser.parseString(tagLength);
    }
    this.gtid = this.tag ?
      `${this.sid}:${this.tag}:${this.gno}` : `${this.sid}:${this.gno}`;
    // Remaining fields (ids 4-11 and any future additions) are skipped
    if (parser._offset < messageEnd) {
      parser._offset = messageEnd;
    }
  }
}

class AnonymousGtid extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    this.flags = parser.parseUnsignedNumber(1);
    this.sid = formatUuid(parser.parseBuffer(16));
    this.gno = Common.parseUInt64(parser);
    this.gtid = this.sid + ':' + this.gno;
    skipEventRemainder(parser, zongji);
  }
}

class PreviousGtids extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    // The first u64 packs a format code in its top byte (sql/
    // rpl_gtid_set.cc encode_nsids_format, MySQL 8.3+). Format 0 is the
    // classic encoding, where the whole u64 is the sid count. Format 1
    // (written once the server has ever executed a tagged GTID) keeps
    // the sid count in bits 8-55 and adds a tag field to every sid
    // entry; a (uuid, tag) pair is its own entry, repeating the uuid.
    const eventEnd = parser._packetEnd -
      (zongji && zongji.useChecksum ? 4 : 0);
    requireEventBytes(parser, eventEnd, 8, 'PreviousGtids');
    let nSidsField = 0n;
    for (let i = 0; i < 8; i++) {
      nSidsField |= BigInt(parser.parseUnsignedNumber(1)) << BigInt(8 * i);
    }
    const format = nSidsField >> 56n;
    let sidCount;
    if (format === 0n) {
      sidCount = Number(nSidsField);
    } else if (format === 1n) {
      sidCount = Number((nSidsField >> 8n) & 0xffffffffffffn);
    } else {
      throw new Error(`Unknown GTID set encoding format ${format}`);
    }
    const tagged = format === 1n;
    const sids = [];
    for (let i = 0; i < sidCount; i++) {
      requireEventBytes(parser, eventEnd, 16, 'PreviousGtids');
      const sid = formatUuid(parser.parseBuffer(16));
      let tag = '';
      if (tagged) {
        const tagLength = Number(Common.parseSerializationVarint(
          parser, eventEnd, 'PreviousGtids tag'));
        if (tagLength > 32) {
          throw new Error(`Invalid GTID tag length ${tagLength}`);
        }
        requireEventBytes(parser, eventEnd, tagLength, 'PreviousGtids');
        tag = parser.parseString(tagLength);
      }
      requireEventBytes(parser, eventEnd, 8, 'PreviousGtids');
      const intervalCount = parser.parseUnsignedNumber(8);
      requireEventBytes(parser, eventEnd, intervalCount * 16,
        'PreviousGtids');
      const intervals = [];
      for (let j = 0; j < intervalCount; j++) {
        const start = parser.parseUnsignedNumber(8);
        const end = parser.parseUnsignedNumber(8);
        intervals.push({ start, end });
      }
      sids.push(tagged ? { sid, tag, intervals } : { sid, intervals });
    }
    this.sids = sids;
    // Entries sharing a uuid print as one block with the untagged
    // intervals first: 'uuid:1-5:tag_a:1:tag_b:1', matching
    // @@gtid_executed. The server writes entries in that order already;
    // grouping here keeps the text parseable even if a non-canonical
    // producer does not
    const blocks = new Map();
    for (const entry of sids) {
      const group = blocks.get(entry.sid) || [];
      group.push(entry);
      blocks.set(entry.sid, group);
    }
    this.gtidSet = [...blocks.entries()].map(([sid, group]) => {
      group.sort((a, b) => (a.tag || '') < (b.tag || '') ? -1 : 1);
      return sid + group.map(entry => {
        const ranges = entry.intervals.map(interval =>
          interval.start === interval.end - 1 ?
            `${interval.start}` :
            `${interval.start}-${interval.end - 1}`);
        return (entry.tag ? `:${entry.tag}` : '') + `:${ranges.join(':')}`;
      }).join('');
    }).join(',');
    skipEventRemainder(parser, zongji);
  }
}

/* A COMMIT event
 * Attributes:
 *   xid: Transaction ID for 2PC
 */

class Xid extends BinlogEvent {
  constructor(parser, options) {
    super(parser, options);
    this.xid = Common.parseUInt64(parser);
  }
}

/*
 * Attributes:
 *  (post-header)
 *    slaveProxyId
 *    executionTime
 *    schemaLength
 *    errorCode
 *    statusVarsLength
 *
 *  (payload)
 *    statusVars
 *    schema
 *    [00]
 *    query
 */

class Query extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);

    this.slaveProxyId = parser.parseUnsignedNumber(4);
    this.executionTime = parser.parseUnsignedNumber(4);
    this.schemaLength = parser.parseUnsignedNumber(1);
    this.errorCode = parser.parseUnsignedNumber(2);
    this.statusVarsLength = parser.parseUnsignedNumber(2);

    this.statusVars = parser.parseString(this.statusVarsLength);
    this.schema = parser.parseString(this.schemaLength);
    parser.parseUnsignedNumber(1);

    if (options.eventType === QUERY_COMPRESSED_EVENT) {
      // MariaDB log_bin_compress=ON: identical to a plain Query event up
      // to and including the schema name's NUL; the query text is
      // replaced by a compressed-payload envelope
      const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
      const envelope = parser.parseBuffer(
        parser._packetEnd - checksumBytes - parser._offset);
      this.query =
        Common.uncompressBinlogEventPayload(envelope).toString();
      skipEventRemainder(parser, zongji);
    } else {
      // all the left is the query
      this.query = parser.parseString(this.size - 13 - this.statusVarsLength - this.schemaLength - 1);
    }
  }

  dump() {
    console.log('=== %s ===', this.getTypeName());
    console.log('Date: %s', new Date(this.timestamp));
    console.log('Next log position: %d', this.nextPosition);
    console.log('Schema: %s', this.schema);
    console.log('Execution time: %d', this.executionTime);
    console.log('Query: %s', this.query);
  }
}

/**
 * Integer Variable Event
 * Attributes:
 *   type: variable type (1=LAST_INSERT_ID, 2=INSERT_ID)
 *   value: integer value
 */
const INTVAR_TYPES = ['INVALID_INT', 'LAST_INSERT_ID', 'INSERT_ID'];

class IntVar extends BinlogEvent {
  constructor(parser, options) {
    super(parser, options);
    this.type = parser.parseUnsignedNumber(1);
    this.value = Common.parseUInt64(parser);
  }

  getIntTypeName() {
    return INTVAR_TYPES[this.type] || 'INVALID_INT';
  }

  dump() {
    console.log('=== %s ===', this.getTypeName());
    console.log('Date: %s', new Date(this.timestamp));
    console.log('Next log position: %d', this.nextPosition);
    console.log('Type: %s (%s)', this.type, this.getIntTypeName());
    console.log('Value: %s', this.value);
  }
}

/**
 * This event describes the structure of a table.
 * It's sent before a change occurs on a table.
 * A end user of the lib should have no usage of this
 *
 * see http://dev.mysql.com/doc/internals/en/table-map-event.html
 **/

class TableMap extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    this.tableMap = zongji.tableMap;

    // post-header
    this._readTableId(parser);
    this.flags = parser.parseUnsignedNumber(2);

    // payload
    const schemaNameLength = parser.parseUnsignedNumber(1);
    this.schemaName = parser.parseString(schemaNameLength);
    parser.parseUnsignedNumber(1);

    const tableNameLength = parser.parseUnsignedNumber(1);
    this.tableName = parser.parseString(tableNameLength);

    if (zongji._skipSchema(this.schemaName, this.tableName)) {
      // This event has been filtered out because of its database/table
      parser._offset = parser._packetEnd;
      this._filtered = true;
      // Removed cached data so that row events do not emit either
      delete this.tableMap[this.tableId];
    }
    else {
      parser.parseUnsignedNumber(1);

      this.columnCount = parser.parseLengthCodedNumber();
      this.columnTypes = Common.parseBytesArray(parser, this.columnCount);
      // column meta data length
      parser.parseLengthCodedNumber();
      this._readColumnMetadata(parser);
      try {
        this._readOptionalMetadata(parser, zongji);
      } catch {
        // A malformed or unrecognised optional metadata block must not
        // break the stream: without it we simply keep using the
        // INFORMATION_SCHEMA metadata path, as before MySQL 8.0.
        this.columnNames = undefined;
        this.signedness = undefined;
        this.primaryKey = undefined;
        this.columnVisibility = undefined;
        this.geometryTypes = undefined;
        this._columnCharsetIds = undefined;
        this._enumSetValues = undefined;
      }
    }
  }

  // The column type byte for ENUM and SET columns is STRING; their real
  // type arrives in the per-column metadata (see _readColumnMetadata).
  _effectiveColumnType(index) {
    const metadata = this.columnsMetadata[index];
    return (metadata && metadata.type) || this.columnTypes[index];
  }

  // Parses the optional metadata TLV block that MySQL 8.0+ appends to
  // TABLE_MAP_EVENT (binlog_row_metadata=MINIMAL or FULL). Absent on older
  // servers, in which case this reads nothing.
  _readOptionalMetadata(parser, zongji) {
    // One nullability bit per column sits between the per-column metadata
    // and the optional metadata block
    parser.parseBuffer(Math.floor((this.columnCount + 7) / 8));

    const end = parser._packetEnd - (zongji && zongji.useChecksum ? 4 : 0);
    if (parser._offset >= end) {
      return;
    }

    // Optional metadata bitmaps and lists cover column subsets classified
    // by real type, in table-definition order
    const numericIndexes = [];
    const characterIndexes = [];
    const enumSetIndexes = [];
    const enumIndexes = [];
    const setIndexes = [];
    const geometryIndexes = [];
    for (let i = 0; i < this.columnCount; i++) {
      const type = this._effectiveColumnType(i);
      if (NUMERIC_METADATA_TYPES.has(type)) {
        numericIndexes.push(i);
      } else if (type === Common.MysqlTypes.ENUM) {
        enumSetIndexes.push(i);
        enumIndexes.push(i);
      } else if (type === Common.MysqlTypes.SET) {
        enumSetIndexes.push(i);
        setIndexes.push(i);
      } else if (CHARACTER_METADATA_TYPES.has(type)) {
        characterIndexes.push(i);
      } else if (type === Common.MysqlTypes.GEOMETRY) {
        geometryIndexes.push(i);
      }
    }

    // MSB-first bitmap with one bit per entry of `indexes`; distributes the
    // bit values back to full-table column positions
    const readBitmap = (indexes, target) => {
      const bytes = parser.parseBuffer(Math.floor((indexes.length + 7) / 8));
      indexes.forEach((columnIndex, i) => {
        target[columnIndex] = (bytes[i >> 3] & (0x80 >> (i % 8))) !== 0;
      });
    };

    // DEFAULT_CHARSET layout: default collation id, then pairs of
    // (position among `indexes`, collation id) for columns that differ
    const readDefaultCharset = (fieldEnd, indexes, target) => {
      const defaultCollation = parser.parseLengthCodedNumber();
      indexes.forEach(columnIndex => {
        target[columnIndex] = defaultCollation;
      });
      while (parser._offset < fieldEnd) {
        const position = parser.parseLengthCodedNumber();
        const collation = parser.parseLengthCodedNumber();
        if (position < indexes.length) {
          target[indexes[position]] = collation;
        }
      }
    };

    // COLUMN_CHARSET layout: one collation id per entry of `indexes`
    const readColumnCharsets = (fieldEnd, indexes, target) => {
      for (let i = 0; parser._offset < fieldEnd; i++) {
        const collation = parser.parseLengthCodedNumber();
        if (i < indexes.length) {
          target[indexes[i]] = collation;
        }
      }
    };

    // SET_STR_VALUE/ENUM_STR_VALUE layout, per column of that type: value
    // count, then that many length-coded strings (raw bytes in the column's
    // own charset; decoded in buildColumnSchemas once charsets are known)
    const readTypeValues = (fieldEnd, indexes, target) => {
      for (let i = 0; parser._offset < fieldEnd; i++) {
        const count = parser.parseLengthCodedNumber();
        const values = [];
        for (let j = 0; j < count; j++) {
          values.push(parser.parseBuffer(parser.parseLengthCodedNumber()));
        }
        if (i < indexes.length) {
          target[indexes[i]] = values;
        }
      }
    };

    const charsetIds = new Array(this.columnCount);
    const Types = OptionalMetadataTypes;

    while (parser._offset < end) {
      const type = parser.parseUnsignedNumber(1);
      const length = parser.parseLengthCodedNumber();
      const fieldEnd = parser._offset + length;
      if (length === null || fieldEnd > end) {
        throw new Error('Malformed TABLE_MAP_EVENT optional metadata');
      }

      let handled = true;
      switch (type) {
        case Types.SIGNEDNESS:
          this.signedness = new Array(this.columnCount);
          readBitmap(numericIndexes, this.signedness);
          break;
        case Types.DEFAULT_CHARSET:
          readDefaultCharset(fieldEnd, characterIndexes, charsetIds);
          break;
        case Types.COLUMN_CHARSET:
          readColumnCharsets(fieldEnd, characterIndexes, charsetIds);
          break;
        case Types.COLUMN_NAME: {
          const names = [];
          while (parser._offset < fieldEnd) {
            names.push(parser.parseString(parser.parseLengthCodedNumber()));
          }
          this.columnNames = names;
          break;
        }
        case Types.SET_STR_VALUE:
          this._enumSetValues = this._enumSetValues || new Array(this.columnCount);
          readTypeValues(fieldEnd, setIndexes, this._enumSetValues);
          break;
        case Types.ENUM_STR_VALUE:
          this._enumSetValues = this._enumSetValues || new Array(this.columnCount);
          readTypeValues(fieldEnd, enumIndexes, this._enumSetValues);
          break;
        case Types.ENUM_AND_SET_DEFAULT_CHARSET:
          readDefaultCharset(fieldEnd, enumSetIndexes, charsetIds);
          break;
        case Types.ENUM_AND_SET_COLUMN_CHARSET:
          readColumnCharsets(fieldEnd, enumSetIndexes, charsetIds);
          break;
        case Types.SIMPLE_PRIMARY_KEY: {
          const primaryKey = [];
          while (parser._offset < fieldEnd) {
            primaryKey.push(parser.parseLengthCodedNumber());
          }
          this.primaryKey = primaryKey;
          break;
        }
        case Types.PRIMARY_KEY_WITH_PREFIX: {
          const primaryKey = [];
          while (parser._offset < fieldEnd) {
            const columnIndex = parser.parseLengthCodedNumber();
            // Prefix length in characters; 0 means the whole column
            parser.parseLengthCodedNumber();
            primaryKey.push(columnIndex);
          }
          this.primaryKey = primaryKey;
          break;
        }
        case Types.GEOMETRY_TYPE: {
          this.geometryTypes = new Array(this.columnCount);
          for (let i = 0; parser._offset < fieldEnd; i++) {
            const geometryType = parser.parseLengthCodedNumber();
            if (i < geometryIndexes.length) {
              this.geometryTypes[geometryIndexes[i]] = geometryType;
            }
          }
          break;
        }
        case Types.COLUMN_VISIBILITY:
          this.columnVisibility = new Array(this.columnCount).fill(false);
          readBitmap(
            Array.from({ length: this.columnCount }, (value, i) => i),
            this.columnVisibility);
          break;
        default:
          // Unknown future fields (e.g. VECTOR dimensionality in MySQL 9)
          // are skipped via fieldEnd below
          handled = false;
      }

      // Every known field type consumes its declared length exactly; a
      // mismatch in either direction means the block is corrupt, so treat
      // all optional metadata as unusable rather than trusting partially
      // garbled values (handled by the caller's catch)
      if (handled ? parser._offset !== fieldEnd : parser._offset > fieldEnd) {
        throw new Error('Malformed TABLE_MAP_EVENT optional metadata');
      }
      parser._offset = fieldEnd;
    }

    this._columnCharsetIds = charsetIds;
  }

  // True when the event carries binlog_row_metadata=FULL metadata, i.e.
  // enough to decode rows without consulting INFORMATION_SCHEMA
  hasSelfDescribingMetadata() {
    return this.columnNames !== undefined &&
      this.columnNames.length === this.columnCount;
  }

  // Classic temporal type codes are ambiguous on MariaDB: a 5.3-era
  // "hires" column (fractional seconds, different byte order and width)
  // is binlogged under the same codes with the same (zero) metadata as a
  // classic column, and even FULL optional metadata carries nothing to
  // tell them apart. Only the table definition can, so tables containing
  // these codes must use the INFORMATION_SCHEMA path.
  hasAmbiguousTemporalColumns() {
    return this.columnTypes.some(type =>
      type === Common.MysqlTypes.TIMESTAMP ||
      type === Common.MysqlTypes.TIME ||
      type === Common.MysqlTypes.DATETIME);
  }

  // Builds INFORMATION_SCHEMA.COLUMNS-shaped rows from the event's own
  // metadata, so the rest of the pipeline works identically with either
  // metadata source. Only meaningful when hasSelfDescribingMetadata().
  buildColumnSchemas() {
    const schemas = [];
    for (let i = 0; i < this.columnCount; i++) {
      const type = this._effectiveColumnType(i);
      const metadata =
        /** @type {Record<string, any>} */ (this.columnsMetadata[i] || {});
      const charsetId = this._columnCharsetIds && this._columnCharsetIds[i];
      const binary = charsetId === BINARY_COLLATION_ID;
      const charsetName = charsetId === undefined || binary ?
        null : collationToCharset(charsetId);
      const unsigned = this.signedness && this.signedness[i];

      const schema = {
        COLUMN_NAME: this.columnNames[i],
        COLLATION_NAME: null,
        CHARACTER_SET_NAME: charsetName,
        COLUMN_COMMENT: '',
        COLUMN_TYPE: '',
      };

      const Mysql = Common.MysqlTypes;
      switch (type) {
        case Mysql.TINY: schema.COLUMN_TYPE = 'tinyint'; break;
        case Mysql.SHORT: schema.COLUMN_TYPE = 'smallint'; break;
        case Mysql.INT24: schema.COLUMN_TYPE = 'mediumint'; break;
        case Mysql.LONG: schema.COLUMN_TYPE = 'int'; break;
        case Mysql.LONGLONG: schema.COLUMN_TYPE = 'bigint'; break;
        case Mysql.FLOAT: schema.COLUMN_TYPE = 'float'; break;
        case Mysql.DOUBLE: schema.COLUMN_TYPE = 'double'; break;
        case Mysql.DECIMAL:
        case Mysql.NEWDECIMAL:
          schema.COLUMN_TYPE =
            `decimal(${metadata.precision},${metadata.decimals})`;
          break;
        case Mysql.YEAR: schema.COLUMN_TYPE = 'year'; break;
        case Mysql.STRING:
        case Mysql.VARCHAR:
        case Mysql.VAR_STRING: {
          // Binlog metadata stores byte widths; character widths follow
          // from the charset's maximum bytes per character
          const isChar = type === Mysql.STRING;
          if (binary) {
            schema.COLUMN_TYPE =
              (isChar ? 'binary' : 'varbinary') +
              `(${metadata['max_length']})`;
          } else {
            const chars =
              metadata['max_length'] / charsetMaxLength(charsetName);
            schema.COLUMN_TYPE = (isChar ? 'char' : 'varchar') +
              `(${Math.floor(chars)})`;
          }
          break;
        }
        case Mysql.TINY_BLOB:
        case Mysql.MEDIUM_BLOB:
        case Mysql.LONG_BLOB:
        case Mysql.BLOB:
          schema.COLUMN_TYPE = (BLOB_TYPE_NAMES[metadata['length_size']] ||
            BLOB_TYPE_NAMES[2])[binary ? 0 : 1];
          break;
        case Mysql.BLOB_COMPRESSED:
          // Same I_S form MariaDB itself reports for COMPRESSED columns
          schema.COLUMN_TYPE = (BLOB_TYPE_NAMES[metadata['length_size']] ||
            BLOB_TYPE_NAMES[2])[binary ? 0 : 1] + ' /*M!100301 COMPRESSED*/';
          break;
        case Mysql.VARCHAR_COMPRESSED: {
          // max_length reserves one byte for the compression header
          const byteLength = metadata['max_length'] - 1;
          if (binary) {
            schema.COLUMN_TYPE =
              `varbinary(${byteLength}) /*M!100301 COMPRESSED*/`;
          } else {
            const chars = byteLength / charsetMaxLength(charsetName);
            schema.COLUMN_TYPE =
              `varchar(${Math.floor(chars)}) /*M!100301 COMPRESSED*/`;
          }
          break;
        }
        case Mysql.ENUM:
        case Mysql.SET: {
          const values = decodeEnumSetValues(
            this._enumSetValues && this._enumSetValues[i], charsetName);
          if (type === Mysql.ENUM) {
            schema.ENUM_VALUES = values;
          } else {
            schema.SET_VALUES = values;
          }
          const keyword = type === Mysql.ENUM ? 'enum' : 'set';
          schema.COLUMN_TYPE = keyword + '(' +
            values.map(value => `'${value.replace(/'/g, "''")}'`).join(',') +
            ')';
          break;
        }
        case Mysql.BIT: schema.COLUMN_TYPE = `bit(${metadata.bits})`; break;
        case Mysql.JSON: schema.COLUMN_TYPE = 'json'; break;
        case Mysql.GEOMETRY:
          schema.COLUMN_TYPE = GEOMETRY_TYPE_NAMES[
            this.geometryTypes && this.geometryTypes[i]] || 'geometry';
          break;
        case Mysql.TIMESTAMP:
        case Mysql.TIMESTAMP2:
          schema.COLUMN_TYPE = withPrecision('timestamp', metadata.decimals);
          break;
        case Mysql.DATETIME:
        case Mysql.DATETIME2:
          schema.COLUMN_TYPE = withPrecision('datetime', metadata.decimals);
          break;
        case Mysql.TIME:
        case Mysql.TIME2:
          schema.COLUMN_TYPE = withPrecision('time', metadata.decimals);
          break;
        case Mysql.DATE:
        case Mysql.NEWDATE:
          schema.COLUMN_TYPE = 'date';
          break;
      }

      if (unsigned !== undefined && NUMERIC_METADATA_TYPES.has(type)) {
        schema.UNSIGNED = unsigned;
        if (unsigned && type !== Mysql.YEAR) {
          schema.COLUMN_TYPE += ' unsigned';
        }
      }

      schemas.push(schema);
    }
    return schemas;
  }

  updateColumnInfo() {
    const columnsMetadata = this.columnsMetadata;
    for (let i = 0; i < this.columnCount; i++) {
      if (columnsMetadata[i] && columnsMetadata[i].type) {
        this.columnTypes[i] = columnsMetadata[i].type;
        delete columnsMetadata[i].type;
      }
    }
    const tableMap = this.tableMap[this.tableId];

    const columnSchemas = tableMap.columnSchemas;
    // Schema drift: the table was altered between this binlog event being
    // written and the metadata fetch. Fail diagnosably rather than with a
    // bare TypeError from indexing missing columns.
    if (!columnSchemas || columnSchemas.length < this.columnCount) {
      throw new Error(
        `Table ${this.schemaName}.${this.tableName} schema changed between ` +
        `binlog event and metadata fetch: the event has ${this.columnCount} ` +
        'columns, fetched metadata has ' +
        `${columnSchemas ? columnSchemas.length : 0}`);
    }

    // Even under binlog_row_metadata=MINIMAL the binlog carries exact
    // signedness as of the event's write time; it always wins over
    // inference from the INFORMATION_SCHEMA column definition (see
    // parseAnyInt in common.js)
    if (this.signedness && columnSchemas.length === this.columnCount) {
      for (let i = 0; i < this.columnCount; i++) {
        if (this.signedness[i] !== undefined) {
          columnSchemas[i].UNSIGNED = this.signedness[i];
        }
      }
    }
    const columns = [];
    for (let j = 0; j < this.columnCount; j++) {
      columns.push({
        name: columnSchemas[j].COLUMN_NAME,
        charset: columnSchemas[j].CHARACTER_SET_NAME,
        type: this.columnTypes[j],
        // nullable:
        metadata: columnsMetadata[j]
      });
    }

    tableMap.columns = columns;
  }

  _readColumnMetadata(parser) {
    this.columnsMetadata = this.columnTypes.map(function(code) {
      let result;

      switch (code) {
        case Common.MysqlTypes.FLOAT:
        case Common.MysqlTypes.DOUBLE:
          result = {
            size: parser.parseUnsignedNumber(1)
          };
          break;
        case Common.MysqlTypes.VARCHAR:
        case Common.MysqlTypes.VARCHAR_COMPRESSED:
          result = {
            'max_length': parser.parseUnsignedNumber(2)
          };
          break;
        case Common.MysqlTypes.BIT: {
          const bits = parser.parseUnsignedNumber(1);
          const bytes = parser.parseUnsignedNumber(1);
          result = {
            bits: bytes * 8 + bits
          };
          break;
        }
        case Common.MysqlTypes.NEWDECIMAL:
          result = {
            precision: parser.parseUnsignedNumber(1),
            decimals: parser.parseUnsignedNumber(1),
          };
          break;
        case Common.MysqlTypes.BLOB:
        case Common.MysqlTypes.BLOB_COMPRESSED:
        case Common.MysqlTypes.GEOMETRY:
        case Common.MysqlTypes.JSON:
          result = {
            'length_size': parser.parseUnsignedNumber(1)
          };
          break;
        case Common.MysqlTypes.STRING:
        case Common.MysqlTypes.VAR_STRING: {
          // The STRING type sets a 'real_type' field to indicate the
          // actual type which is fundamentally incompatible with STRING
          // parsing. Setting a 'type' key in this hash will cause
          // TableMap event to override the main field 'type' with the
          // provided 'type' here.
          const metadata = (parser.parseUnsignedNumber(1) << 8) + parser.parseUnsignedNumber(1);
          const realType = metadata >> 8;
          if (realType === Common.MysqlTypes.ENUM
              || realType === Common.MysqlTypes.SET) {
            result = {
              type: realType,
              size: metadata & 0x00ff
            };
          } else {
            result = {
              'max_length': ((
                (metadata >> 4) & 0x300) ^ 0x300) + (metadata & 0x00ff)
            };
          }
          break;
        }
        case Common.MysqlTypes.TIMESTAMP2:
        case Common.MysqlTypes.DATETIME2:
        case Common.MysqlTypes.TIME2:
          result = {
            decimals: parser.parseUnsignedNumber(1)
          };
          break;
      }

      return result;
    });
  }

  dump() {
    super.dump();
    console.log('Table id: %d', this.tableId);
    console.log('Schema: %s', this.schemaName);
    console.log('Table: %s', this.tableName);
    console.log('Columns: %s', this.columnCount);
    console.log('Column types:', this.columnTypes);
  }
}

class Unknown extends BinlogEvent {
  constructor(parser, options) {
    super(parser, options);
  }
}

/* Sent by the server instead of real events: while the connection idles
 * (when a heartbeat period is configured), and after transactions were
 * skipped server-side during a GTID dump, so the client's position can
 * advance past them. Carries the current binlog filename; nextPosition
 * holds the advanced position.
 */
class Heartbeat extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    // MariaDB: when the heartbeat position exceeds 4 GiB the header
    // log_pos is 0 and a u64 position sub-header precedes the file name
    // (sql/sql_repl.cc send_heartbeat_event, HB_SUB_HEADER_LEN)
    if (zongji && zongji.isMariaDb && options.nextPosition === 0 &&
        parser._packetEnd - checksumBytes - parser._offset >= 8) {
      this.position = Common.parseUInt64(parser);
    }
    this.binlogName = parser.parseString(
      parser._packetEnd - checksumBytes - parser._offset);
    skipEventRemainder(parser, zongji);
  }
}

/* MariaDB GTID_EVENT (code 162): replaces the BEGIN Query event of a
 * transaction (FL_STANDALONE clear) or marks a standalone group such as a
 * DDL statement (FL_STANDALONE set). The GTID itself is
 * domain_id - server_id - seq_no, where server_id comes from the common
 * event header. Layout: sql/log_event.cc Gtid_log_event; fields after
 * flags2 are conditional and the data area is zero-padded to the 19-byte
 * post-header length when shorter.
 */
const MARIADB_GTID_FLAGS2 = {
  FL_STANDALONE: 0x01,
  FL_GROUP_COMMIT_ID: 0x02,
  FL_TRANSACTIONAL: 0x04,
  FL_ALLOW_PARALLEL: 0x08,
  FL_WAITED: 0x10,
  FL_DDL: 0x20,
  FL_PREPARED_XA: 0x40,
  FL_COMPLETED_XA: 0x80,
};
const MARIADB_GTID_FLAGS_EXTRA = {
  FL_EXTRA_MULTI_ENGINE: 0x01,
  FL_START_ALTER: 0x02,
  FL_COMMIT_ALTER: 0x04,
  FL_ROLLBACK_ALTER: 0x08,
  FL_EXTRA_THREAD_ID: 0x10,
};

// The parser's own bounds run to the packet end INCLUDING the trailing
// CRC32, so a truncated event body could silently consume checksum bytes
// as field data; every fixed or length-prefixed read must be bounded by
// the checksum-excluded end instead
const requireEventBytes = function(parser, end, bytes, typeName) {
  if (parser._offset + bytes > end) {
    throw new Error(
      `Truncated ${typeName} event: ${bytes} bytes needed, ` +
      `${end - parser._offset} available`);
  }
};

class MariadbGtid extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    const end = parser._packetEnd - checksumBytes;

    requireEventBytes(parser, end, 13, 'MariadbGtid');
    this.seqNo = Common.parseUInt64(parser);
    this.domainId = parser.parseUnsignedNumber(4);
    this.serverId = options.serverId;
    this.flags2 = parser.parseUnsignedNumber(1);
    this.standalone =
      (this.flags2 & MARIADB_GTID_FLAGS2.FL_STANDALONE) !== 0;
    this.transactional =
      (this.flags2 & MARIADB_GTID_FLAGS2.FL_TRANSACTIONAL) !== 0;
    this.isDdl = (this.flags2 & MARIADB_GTID_FLAGS2.FL_DDL) !== 0;
    this.preparedXa =
      (this.flags2 & MARIADB_GTID_FLAGS2.FL_PREPARED_XA) !== 0;
    this.completedXa =
      (this.flags2 & MARIADB_GTID_FLAGS2.FL_COMPLETED_XA) !== 0;

    if (this.flags2 & MARIADB_GTID_FLAGS2.FL_GROUP_COMMIT_ID) {
      requireEventBytes(parser, end, 8, 'MariadbGtid');
      this.commitId = Common.parseUInt64(parser);
    }
    if (this.preparedXa || this.completedXa) {
      requireEventBytes(parser, end, 6, 'MariadbGtid');
      this.xidFormatId = parser.parseUnsignedNumber(4);
      const gtridLength = parser.parseUnsignedNumber(1);
      const bqualLength = parser.parseUnsignedNumber(1);
      requireEventBytes(parser, end, gtridLength + bqualLength,
        'MariadbGtid');
      this.xidGtrid = parser.parseBuffer(gtridLength);
      this.xidBqual = parser.parseBuffer(bqualLength);
    }
    // Remaining bytes (if any) start with flags_extra; a zero pad byte
    // reads as flags_extra = 0, adding nothing
    if (parser._offset < end) {
      this.flagsExtra = parser.parseUnsignedNumber(1);
      if (this.flagsExtra & MARIADB_GTID_FLAGS_EXTRA.FL_EXTRA_MULTI_ENGINE) {
        requireEventBytes(parser, end, 1, 'MariadbGtid');
        this.extraEngines = parser.parseUnsignedNumber(1);
      }
      if (this.flagsExtra & (MARIADB_GTID_FLAGS_EXTRA.FL_COMMIT_ALTER |
          MARIADB_GTID_FLAGS_EXTRA.FL_ROLLBACK_ALTER)) {
        requireEventBytes(parser, end, 8, 'MariadbGtid');
        this.saSeqNo = Common.parseUInt64(parser);
      }
      if ((this.flagsExtra & MARIADB_GTID_FLAGS_EXTRA.FL_EXTRA_THREAD_ID) &&
          parser._offset + 4 <= end) {
        this.threadId = parser.parseUnsignedNumber(4);
      }
    }

    this.gtid = `${this.domainId}-${this.serverId}-${this.seqNo}`;
    skipEventRemainder(parser, zongji);
  }
}

/* MariaDB GTID_LIST_EVENT (code 163): written at the start of every binlog
 * file with the last GTID per (domain, server) seen so far - MariaDB's
 * analogue of MySQL's Previous_gtids. Also sent as an artificial event on
 * GTID connects that seek mid-file. A domain may have several entries (one
 * per server_id); the last entry of a domain's run is the most recent.
 */
class MariadbGtidList extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    const end = parser._packetEnd - checksumBytes;
    requireEventBytes(parser, end, 4, 'MariadbGtidList');
    const val = parser.parseUnsignedNumber(4);
    this.count = val & 0x0fffffff;
    // Bit 28: FLAG_UNTIL_REACHED (fake events only); bit 29: FLAG_IGN_GTIDS
    this.flags = val >>> 28;
    this.gtids = [];
    for (let i = 0; i < this.count; i++) {
      requireEventBytes(parser, end, 16, 'MariadbGtidList');
      const domainId = parser.parseUnsignedNumber(4);
      const serverId = parser.parseUnsignedNumber(4);
      const seqNo = Common.parseUInt64(parser);
      this.gtids.push({
        domainId,
        serverId,
        seqNo,
        gtid: `${domainId}-${serverId}-${seqNo}`,
      });
    }
    skipEventRemainder(parser, zongji);
  }
}

/* MariaDB BINLOG_CHECKPOINT_EVENT (code 161): an XA-recovery marker naming
 * the oldest binlog file that may still be needed for crash recovery. Not
 * used in replication; exposed for observability only.
 */
class BinlogCheckpoint extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    const end = parser._packetEnd - checksumBytes;
    requireEventBytes(parser, end, 4, 'BinlogCheckpoint');
    const length = parser.parseUnsignedNumber(4);
    requireEventBytes(parser, end, length, 'BinlogCheckpoint');
    this.binlogName = parser.parseString(length);
    skipEventRemainder(parser, zongji);
  }
}

/* MariaDB ANNOTATE_ROWS_EVENT (code 160): the SQL statement text for the
 * row events that follow, MariaDB's analogue of MySQL's
 * ROWS_QUERY_LOG_EVENT. Only sent when the dump requests it (the
 * BINLOG_SEND_ANNOTATE_ROWS_EVENT flag).
 */
class AnnotateRows extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    this.statement = parser.parseString(
      parser._packetEnd - checksumBytes - parser._offset);
    skipEventRemainder(parser, zongji);
  }
}

/* MySQL ROWS_QUERY_LOG_EVENT (code 29): the SQL statement text for the
 * row events that follow, sent to every consumer while the server runs
 * with binlog_rows_query_log_events=ON. The body starts with one length
 * byte that only holds the statement length mod 256; readers ignore it
 * and take the text to the end of the event
 * (sql/log_event.cc Rows_query_log_event).
 */
class RowsQuery extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    const end = parser._packetEnd - checksumBytes;
    requireEventBytes(parser, end, 1, 'RowsQuery');
    parser.parseUnsignedNumber(1);
    this.statement = parser.parseString(end - parser._offset);
    skipEventRemainder(parser, zongji);
  }
}

/* MariaDB START_ENCRYPTION_EVENT (code 164): sent once after the format
 * description event when the binlog file on disk is encrypted. The dump
 * thread decrypts server-side, so the stream itself is cleartext and this
 * event is informational; it arrives flagged LOG_EVENT_IGNORABLE_F.
 */
class StartEncryption extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    requireEventBytes(parser, parser._packetEnd - checksumBytes, 17,
      'StartEncryption');
    this.scheme = parser.parseUnsignedNumber(1);
    this.keyVersion = parser.parseUnsignedNumber(4);
    this.nonce = parser.parseBuffer(12);
    skipEventRemainder(parser, zongji);
  }
}

/* XA_PREPARE_LOG_EVENT (code 38): terminates an XA-prepared event group
 * (MySQL 5.7+ and MariaDB share the layout). one_phase distinguishes
 * XA COMMIT ... ONE PHASE, which commits immediately.
 */
class XaPrepare extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
    const end = parser._packetEnd - checksumBytes;
    requireEventBytes(parser, end, 13, 'XaPrepare');
    this.onePhase = parser.parseUnsignedNumber(1) !== 0;
    this.xidFormatId = parser.parseUnsignedNumber(4);
    const gtridLength = parser.parseUnsignedNumber(4);
    const bqualLength = parser.parseUnsignedNumber(4);
    requireEventBytes(parser, end, gtridLength + bqualLength, 'XaPrepare');
    this.xidGtrid = parser.parseBuffer(gtridLength);
    this.xidBqual = parser.parseBuffer(bqualLength);
    skipEventRemainder(parser, zongji);
  }
}


/* MySQL 8.0.20+ wraps whole transactions in a single compressed event when
 * binlog_transaction_compression=ON. The embedded row events are
 * zstd-compressed and zongji cannot decode them, so the row changes they
 * carry would be silently lost. The first occurrence emits an error via
 * ZongJi#_warnUnsupportedEvent (see unsupportedReason below).
 */
class TransactionPayload extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    skipEventRemainder(parser, zongji);
  }

  static unsupportedReason =
    'Server sent a TRANSACTION_PAYLOAD_EVENT (binlog_transaction_compression=ON). ' +
    'zongji cannot decode compressed transactions, so their row events are NOT ' +
    'being emitted. Set binlog_transaction_compression=OFF on the server to ' +
    'receive these changes.';
}

/* MySQL 8.0+ emits partial JSON row updates when
 * binlog_row_value_options=PARTIAL_JSON. The JSON diff format is not
 * decodable by zongji, so these updates would be silently lost. The first
 * occurrence emits an error via ZongJi#_warnUnsupportedEvent.
 */
class PartialUpdateRows extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    skipEventRemainder(parser, zongji);
  }

  static unsupportedReason =
    'Server sent a PARTIAL_UPDATE_ROWS_EVENT (binlog_row_value_options=PARTIAL_JSON). ' +
    'zongji cannot decode partial JSON updates, so these UPDATE row events are ' +
    'NOT being emitted. Clear binlog_row_value_options on the server to receive ' +
    'these changes.';
}

export {
  BinlogEvent,
  Rotate,
  Format,
  Query,
  IntVar,
  Xid,
  TableMap,
  Gtid,
  AnonymousGtid,
  PreviousGtids,
  TransactionPayload,
  PartialUpdateRows,
  Heartbeat,
  MariadbGtid,
  MariadbGtidList,
  BinlogCheckpoint,
  AnnotateRows,
  RowsQuery,
  StartEncryption,
  XaPrepare,
  Unknown
};
