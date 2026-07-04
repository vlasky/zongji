import mysql from 'mysql2';
import { EventEmitter } from 'events';
import initBinlogClass from './lib/sequence/binlog.js';

const ConnectionConfigMap = {
  'Connection': obj => obj.config,
  'Pool': obj => obj.config.connectionConfig,
};

const TableInfoQuery = `SELECT
  COLUMN_NAME, COLLATION_NAME, CHARACTER_SET_NAME,
  COLUMN_COMMENT, COLUMN_TYPE
  FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
  ORDER BY ORDINAL_POSITION`;

class ZongJi extends EventEmitter {
  constructor(dsn) {
    super();

    this._pendingErrors = [];
    this._pendingErrorTimer = null;
    this.on('newListener', (event) => {
      if (event !== 'error' || this._pendingErrors.length === 0) {
        return;
      }
      const pending = this._pendingErrors.slice();
      this._pendingErrors.length = 0;
      process.nextTick(() => {
        pending.forEach(err => this.emit('error', err));
      });
    });

    this._options({});
    this._filters({});
    this.ctrlCallbacks = [];
    this.tableMap = {};
    this._warnedUnsupported = new Set();
    this.ready = false;
    this.stopped = false;
    this._starting = false;
    this.useChecksum = false;

    this._dsn = dsn;
    this.ctrlConnection = null;
    this.connection = null;
    this.ctrlConnectionOwner = false;
  }

  // dsn - can be one instance of Connection or Pool / object / url string
  _establishConnection(dsn) {
    const createConnection = (options) => {
      const emitError = (err) => {
        if (this.listenerCount('error') === 0) {
          // Buffer errors that fire before the caller attaches a listener
          // (typically within the same tick as construction/start). If no
          // listener ever appears, fall back to EventEmitter's default
          // behaviour (throw) rather than swallowing failures silently.
          this._pendingErrors.push(err);
          this._schedulePendingErrorCheck();
          return;
        }
        this.emit('error', err);
      };
      let connection = mysql.createConnection(options);
      connection.on('error', emitError);
      // don't need to call connection.connect() here
      // we use implicitly established connection
      // see https://github.com/mysqljs/mysql#establishing-connections
      return connection;
    };

    const configFunc = ConnectionConfigMap[dsn.constructor.name];
    let binlogDsn;
    const sanitizeConnectionOptions = (options) => {
      if (!options) return options;
      const cleaned = Object.assign({}, options);
      delete cleaned.maxPacketSize;
      delete cleaned.clientFlags;
      return cleaned;
    };

    if (typeof dsn === 'object' && configFunc) {
      // dsn is a pool or connection object
      let conn = dsn; // reuse as ctrlConnection
      this.ctrlConnection = conn;
      this.ctrlConnectionOwner = false;
      binlogDsn = sanitizeConnectionOptions(configFunc(conn));
    }

    if (!binlogDsn) {
      // assuming that the object passed is the connection settings
      this.ctrlConnectionOwner = true;
      this.ctrlConnection = createConnection(dsn);
      binlogDsn = dsn;
    }

    this.connection = createConnection(binlogDsn);
  }

  _schedulePendingErrorCheck() {
    if (this._pendingErrorTimer) {
      return;
    }
    this._pendingErrorTimer = setImmediate(() => {
      this._pendingErrorTimer = null;
      if (this.listenerCount('error') > 0 || this._pendingErrors.length === 0) {
        return;
      }
      const pending = this._pendingErrors.slice();
      this._pendingErrors.length = 0;
      // No 'error' listener was attached within a macrotask; re-emit so
      // Node's unhandled 'error' semantics apply (throws)
      pending.forEach(err => this.emit('error', err));
    });
  }

  _isChecksumEnabled(next) {
    const SelectChecksumParamSql = 'select @@GLOBAL.binlog_checksum as checksum';
    const SetChecksumSql = 'set @master_binlog_checksum=@@global.binlog_checksum';

    let done = false;
    const finish = (err, enabled) => {
      if (done) return;
      done = true;
      next(err, enabled);
    };

    const isConnectionReady = (conn) => {
      return conn &&
        conn.state !== 'disconnected' &&
        !conn._fatalError &&
        !conn._protocolError &&
        !conn._closing;
    };

    const query = (conn, sql) => {
      if (!isConnectionReady(conn)) {
        return Promise.resolve(null);
      }
      return new Promise(
        (resolve, reject) => {
          try {
            conn.query(sql, (err, result) => {
            if (err) {
              reject(err);
            }
            else {
              resolve(result);
            }
            });
          } catch (err) {
            reject(err);
          }
        }
      );
    };

    let checksumEnabled = true;

    query(this.ctrlConnection, SelectChecksumParamSql)
      .then(rows => {
        if (!rows) {
          checksumEnabled = false;
          return null;
        }
        if (rows[0].checksum === 'NONE') {
          checksumEnabled = false;
          return query(this.connection, 'SELECT 1');
        }

        if (checksumEnabled) {
          return query(this.connection, SetChecksumSql);
        }
      })
      .catch(err => {
        if (err.toString().match(/ER_UNKNOWN_SYSTEM_VARIABLE/)) {
          checksumEnabled = false;
          // a simple query to open this.connection
          return query(this.connection, 'SELECT 1');
        }
        else {
          return finish(err);
        }
      })
      .then(() => {
        finish(null, checksumEnabled);
      })
      .catch(err => {
        finish(err);
      });
  }

  _findBinlogEnd(next) {
    this.ctrlConnection.query('SHOW BINARY LOGS', (err, rows) => {
      if (err) {
        // Errors should be emitted
        next(err);
      }
      else {
        next(null, rows.length > 0 ? rows[rows.length - 1] : null);
      }
    });
  }

  _fetchTableInfo(tableMapEvent, next) {
    if (!this.ctrlConnection ||
        this.ctrlConnection.state === 'disconnected' ||
        this.ctrlConnection._fatalError ||
        this.ctrlConnection._protocolError ||
        this.ctrlConnection._closing) {
      // The binlog connection stays paused, so processing has halted.
      // During stop() that is expected; otherwise it must not be silent.
      if (!this.stopped) {
        this.emit('error', new Error(
          'Control connection unavailable while fetching column metadata ' +
          'for ' + tableMapEvent.schemaName + '.' + tableMapEvent.tableName +
          '. Binlog processing has halted; call stop() then start() to resume.'));
      }
      return;
    }

    const params = [tableMapEvent.schemaName, tableMapEvent.tableName];
    try {
      // execute() uses a server-side prepared statement: parameters are sent
      // out-of-band (never spliced into SQL text) and the statement is cached
      // per connection, so repeated metadata lookups avoid re-parsing.
      this.ctrlConnection.execute(TableInfoQuery, params, (err, rows) => {
      if (err) {
        // Errors should be emitted
        this.emit('error', err);
        // This is a fatal error, no additional binlog events will be
        // processed since next() will never be called
        return;
      }

      if (rows.length === 0) {
        this.emit('error', new Error(
          'Insufficient permissions to access: ' +
          tableMapEvent.schemaName + '.' + tableMapEvent.tableName));
        // This is a fatal error, no additional binlog events will be
        // processed since next() will never be called
        return;
      }

      this.tableMap[tableMapEvent.tableId] = {
        columnSchemas: rows,
        parentSchema: tableMapEvent.schemaName,
        tableName: tableMapEvent.tableName
      };

      next();
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  // #_options will reset all the options.
  /** @param {object} [options] */
  _options({
    serverId,
    filename,
    position,
    startAtEnd,
  } = {}) {
    this.options = {
      serverId,
      filename,
      position,
      startAtEnd,
    };
  }

  // #_filters will reset all the filters.
  /** @param {object} [options] */
  _filters({
    includeEvents,
    excludeEvents,
    includeSchema,
    excludeSchema,
  } = {}) {
    this.filters = {
      includeEvents,
      excludeEvents,
      includeSchema,
      excludeSchema,
    };

    // Precompiled lookups so per-event filtering is O(1). Only own keys of
    // the schema objects are considered (no prototype leakage).
    const compileSchemaFilter = (schema) => {
      if (schema === undefined || schema === null) {
        return undefined;
      }
      const compiled = new Map();
      for (const database of Object.keys(schema)) {
        const tables = schema[database];
        compiled.set(database, tables === true ?
          true : new Set(Array.isArray(tables) ? tables : []));
      }
      return compiled;
    };

    this._includeEventsSet = includeEvents === undefined ?
      undefined : new Set(Array.isArray(includeEvents) ? includeEvents : []);
    this._excludeEventsSet =
      new Set(Array.isArray(excludeEvents) ? excludeEvents : []);
    this._includeSchemaMap = compileSchemaFilter(includeSchema);
    this._excludeSchemaMap = compileSchemaFilter(excludeSchema) || new Map();
  }

  get(name) {
    let result;
    if (typeof name === 'string') {
      result = this.options[name];
    }
    else if (Array.isArray(name)) {
      result = name.reduce(
        (acc, cur) => {
          acc[cur] = this.options[cur];
          return acc;
        },
        {}
      );
    }

    return result;
  }

  // @options contains a list options
  // - `serverId` unique identifier
  // - `filename`, `position` the position of binlog to begin with
  // - `startAtEnd` if true, will update filename / position automatically
  // - `includeEvents`, `excludeEvents`, `includeSchema`, `excludeSchema` filter different binlog events bubbling
  start(options = {}) {
    // If already running, just update filters (for pause/resume) and return
    if (this.ready && !this.stopped) {
      this._filters(options);
      return;
    }

    // A start() is already initialising; a second concurrent call would
    // enqueue a duplicate binlog dump command on the same connection
    if (this._starting) {
      return;
    }
    this._starting = true;

    this.stopped = false;

    if (!this.connection || !this.ctrlConnection) {
      this._establishConnection(this._dsn);
    }

    this._options(options);
    this._filters(options);

    const testChecksum = (resolve, reject) => {
      this._isChecksumEnabled((err, checksumEnabled) => {
        if (err) {
          reject(err);
        }
        else {
          this.useChecksum = checksumEnabled;
          resolve();
        }
      });
    };


    const findBinlogEnd = (resolve, reject) => {
      this._findBinlogEnd((err, result) => {
        if (err) {
          return reject(err);
        }

        if (result) {
          this._options(
            Object.assign({}, options, {
              filename: result.Log_name,
              position: result.File_size,
            })
          );
        }

        resolve();
      });
    };

    const binlogHandler = (error, event) => {
      if (error) {
        return this.emit('error', error);
      }

      // Ignore events if connection has been stopped
      if (this.stopped || !this.connection) return;

      // Do not emit events that have been filtered out
      if (event === undefined || event._filtered === true) return;

      switch (event.getTypeName()) {
        case 'TableMap': {
          const tableMap = this.tableMap[event.tableId];
          if (!tableMap || tableMap.tableName !== event.tableName || tableMap.columns.length !== event.columnCount) {
            if (!this.connection) return;
            this.connection.pause();
            this._fetchTableInfo(event, () => {
              // merge the column info with metadata
              event.updateColumnInfo();
              this.emit('binlog', event);
              if (this.connection) this.connection.resume();
            });
            return;
          }
          break;
        }
        case 'Rotate':
          if (this.options.filename !== event.binlogName) {
            this.options.filename = event.binlogName;
          }
          break;
      }
      this.options.position = event.nextPosition;
      this.emit('binlog', event);
    };

    let promises = [new Promise(testChecksum)];

    if (this.options.startAtEnd) {
      promises.push(new Promise(findBinlogEnd));
    }

    Promise.all(promises)
      .then(() => {
        this._starting = false;
        // Check if stop() was called while promises were pending
        if (this.stopped) {
          return;
        }

        this.BinlogClass = initBinlogClass(this);
        this.ready = true;
        this.emit('ready');

        // Final check right before addCommand - connection may have been destroyed
        if (this.stopped) {
          return;
        }

        // When compression is enabled, patch handlePacket to sync sequence ID.
        // MySQL resets inner packet sequence IDs within compressed chunks for
        // binlog streams, causing mysql2's sequence validation to emit warnings.
        // By syncing the expected sequence ID to match the incoming packet, we
        // prevent these harmless warnings. This is safe because binlog events
        // track position independently (binlog file + position / GTID).
        // Only applied when compression is enabled to preserve normal error
        // detection for uncompressed connections.
        if (this.connection.config && this.connection.config.compress) {
          // @ts-ignore - internal mysql2 API
          const originalHandlePacket = this.connection.handlePacket.bind(this.connection);
          // @ts-ignore - internal mysql2 API
          this.connection.handlePacket = function(packet) {
            if (packet && typeof packet.sequenceId !== 'undefined') {
              this.sequenceId = packet.sequenceId;
            }
            return originalHandlePacket(packet);
          };
        }

        // @ts-ignore - internal mysql2 API
        this.connection.addCommand(new this.BinlogClass(binlogHandler));
      })
      .catch(err => {
        this._starting = false;
        this.emit('error', err);
      });

  }

  stop() {
    this.stopped = true;
    this.ready = false;

    if (!this.connection && !this.ctrlConnection) {
      this.emit('stopped');
      return;
    }

    // Binary log connection does not end with destroy()
    let connectionThreadId = null;
    if (this.connection) {
      connectionThreadId = this.connection.threadId;
      this.connection.destroy();
      // @ts-ignore - internal mysql2 API
      if (this.connection.stream && typeof this.connection.stream.unref === 'function') {
        // @ts-ignore - internal mysql2 API
        this.connection.stream.unref();
      }
      this.connection = null;
    }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (this.ctrlConnectionOwner && this.ctrlConnection) {
        this.ctrlConnection.destroy();
        // @ts-ignore - internal mysql2 API
        if (this.ctrlConnection.stream && typeof this.ctrlConnection.stream.unref === 'function') {
          // @ts-ignore - internal mysql2 API
          this.ctrlConnection.stream.unref();
        }
        this.ctrlConnection = null;
      }
      this.emit('stopped');
    };

    if (!this.ctrlConnection ||
        this.ctrlConnection.state === 'disconnected' ||
        this.ctrlConnection._fatalError ||
        this.ctrlConnection._protocolError ||
        this.ctrlConnection._closing) {
      this.ctrlConnection = null;
      return finish();
    }

    if (!connectionThreadId) {
      return finish();
    }

    const killTimeout = setTimeout(finish, 1000);
    try {
      this.ctrlConnection.query(
        'KILL ' + connectionThreadId,
        () => {
          clearTimeout(killTimeout);
          finish();
        }
      );
    } catch {
      clearTimeout(killTimeout);
      finish();
    }
  }

  // Emit an error the first time an undecodable event type arrives so that
  // dropped row changes (e.g. compressed transactions) are never silent.
  _warnUnsupportedEvent(EventClass) {
    if (this._warnedUnsupported.has(EventClass.name)) {
      return;
    }
    this._warnedUnsupported.add(EventClass.name);
    this.emit('error', new Error(EventClass.unsupportedReason));
  }

  // It includes every events by default.
  _skipEvent(name) {
    if (this._excludeEventsSet.has(name)) {
      return true;
    }
    return this._includeEventsSet !== undefined &&
      !this._includeEventsSet.has(name);
  }

  // It doesn't skip any schema by default.
  _skipSchema(database, table) {
    const excludeEntry = this._excludeSchemaMap.get(database);
    if (excludeEntry === true ||
        (excludeEntry instanceof Set && excludeEntry.has(table))) {
      return true;
    }

    if (this._includeSchemaMap === undefined) {
      return false;
    }
    const includeEntry = this._includeSchemaMap.get(database);
    const included = includeEntry === true ||
      (includeEntry instanceof Set && includeEntry.has(table));
    return !included;
  }
}

export default ZongJi;
