import * as Common from './common.js';

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
      const ranges = entry.intervals.map(interval => `${interval.start}-${interval.end - 1}`);
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
      // ignore the rest
    }
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
  Unknown
};
