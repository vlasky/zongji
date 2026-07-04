import iconv from 'iconv-lite';
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
    switch (charsetName) {
      case null:
      case 'utf8mb3':
      case 'utf8mb4':
      case 'ascii':
        return buffer.toString('utf8');
      default:
        try {
          return iconv.decode(buffer, charsetName);
        } catch {
          return buffer.toString('utf8');
        }
    }
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

const formatUuid = function(buffer) {
  const hex = buffer.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-');
};

const skipEventRemainder = function(parser, zongji) {
  const checksumBytes = zongji && zongji.useChecksum ? 4 : 0;
  const target = parser._packetEnd - checksumBytes;
  if (parser._offset < target) {
    parser._offset = target;
  }
};

class Gtid extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    this.flags = parser.parseUnsignedNumber(1);
    this.sid = formatUuid(parser.parseBuffer(16));
    this.gno = parser.parseUnsignedNumber(8);
    this.gtid = this.sid + ':' + this.gno;
    skipEventRemainder(parser, zongji);
  }
}

class AnonymousGtid extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    this.flags = parser.parseUnsignedNumber(1);
    this.sid = formatUuid(parser.parseBuffer(16));
    this.gno = parser.parseUnsignedNumber(8);
    this.gtid = this.sid + ':' + this.gno;
    skipEventRemainder(parser, zongji);
  }
}

class PreviousGtids extends BinlogEvent {
  constructor(parser, options, zongji) {
    super(parser, options);
    const sidCount = parser.parseUnsignedNumber(8);
    const sids = [];
    for (let i = 0; i < sidCount; i++) {
      const sid = formatUuid(parser.parseBuffer(16));
      const intervalCount = parser.parseUnsignedNumber(8);
      const intervals = [];
      for (let j = 0; j < intervalCount; j++) {
        const start = parser.parseUnsignedNumber(8);
        const end = parser.parseUnsignedNumber(8);
        intervals.push({ start, end });
      }
      sids.push({ sid, intervals });
    }
    this.sids = sids;
    this.gtidSet = sids.map(entry => {
      const ranges = entry.intervals.map(interval =>
        interval.start === interval.end - 1 ?
          `${interval.start}` :
          `${interval.start}-${interval.end - 1}`);
      return `${entry.sid}:${ranges.join(':')}`;
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
  constructor(parser, options) {
    super(parser, options);

    this.slaveProxyId = parser.parseUnsignedNumber(4);
    this.executionTime = parser.parseUnsignedNumber(4);
    this.schemaLength = parser.parseUnsignedNumber(1);
    this.errorCode = parser.parseUnsignedNumber(2);
    this.statusVarsLength = parser.parseUnsignedNumber(2);

    this.statusVars = parser.parseString(this.statusVarsLength);
    this.schema = parser.parseString(this.schemaLength);
    parser.parseUnsignedNumber(1);

    // all the left is the query
    this.query = parser.parseString(this.size - 13 - this.statusVarsLength - this.schemaLength - 1);
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
    this.binlogName = parser.parseString(
      parser._packetEnd - checksumBytes - parser._offset);
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
  Unknown
};
