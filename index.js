import mysql from 'mysql2';
import { EventEmitter } from 'events';
import initBinlogClass from './lib/sequence/binlog.js';
import { GtidSet } from './lib/gtid_set.js';

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
    this._currentGtid = undefined;
    this._executedGtids = null;
    this._pendingGtid = undefined;
    this._seedGtidsFromStream = false;
    this.ready = false;
    this.stopped = false;
    this._starting = false;
    this._startEpoch = 0;
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

  // The set of transactions this instance knows to be processed: the
  // start() seed plus every transaction whose commit has been observed.
  // Persist it and pass to start({ gtidSet }) to resume, including on a
  // different server in the same replication topology. Undefined when no
  // exact seed was available (see start()).
  get gtidSet() {
    return this._executedGtids ? this._executedGtids.toString() : undefined;
  }

  // Called from the packet layer (before event filtering) for
  // GTID-relevant events. A transaction's GTID enters the executed set
  // only once its commit marker has been seen (Xid, or a Query event
  // other than BEGIN, e.g. DDL or COMMIT), so a persisted zongji.gtidSet
  // never claims a transaction whose row events were still in flight.
  _trackGtidProgress(eventName, event) {
    const fold = () => {
      if (this._pendingGtid !== undefined && this._executedGtids) {
        this._executedGtids.add(this._pendingGtid);
      }
      this._pendingGtid = undefined;
    };

    switch (eventName) {
      case 'gtid':
        // A new transaction implies the previous one committed, so this
        // also covers commit markers hidden by event filtering
        fold();
        this._pendingGtid = event.gtid;
        break;
      case 'anonymousgtid':
        fold();
        break;
      case 'xid':
        fold();
        break;
      case 'query': {
        // Fold only on definite commit markers. Anything else (BEGIN,
        // XA START/END, DDL, SAVEPOINT, ...) must not fold: claiming a
        // transaction early risks losing its remaining events on resume,
        // whereas not folding merely delays the checkpoint until the
        // next transaction's GTID arrives (at-least-once redelivery).
        const query = event.query.trim().toUpperCase();
        if (query === 'COMMIT' || query === 'ROLLBACK' ||
            query.startsWith('XA COMMIT') ||
            query.startsWith('XA ROLLBACK')) {
          fold();
        }
        break;
      }
      case 'previousgtids':
        // When dumping from the start of a binlog file, its Previous_gtids
        // event is the exact "everything before this point" seed
        if (this._seedGtidsFromStream && this._executedGtids === null) {
          try {
            this._executedGtids = GtidSet.parse(event.gtidSet);
          } catch {
            // Leave unseeded; gtidSet stays undefined
          }
        }
        break;
    }
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
    gtidSet,
    nonBlock,
  } = {}) {
    this.options = {
      serverId,
      filename,
      position,
      startAtEnd,
      gtidSet,
      nonBlock,
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

    // A duplicate start() while one is already initialising is ignored -
    // the first call completes - but its filters are applied, exactly as
    // in the already-running branch above: filters are snapshotted, and
    // re-calling start() is the documented way to update them, so updates
    // made during the initialisation window must not be lost. Stream
    // options (filename/position/serverId) still come from the first
    // call. If stop() intervened, this start() instead proceeds as a
    // restart: the epoch below makes the stale initialisation chain
    // abort, so exactly one binlog dump command is ever enqueued.
    if (this._starting && !this.stopped) {
      this._filters(options);
      return;
    }
    this._starting = true;
    this._startEpoch += 1;
    const epoch = this._startEpoch;

    // A resumed stream must not attribute early events to a GTID seen
    // before the restart
    this._currentGtid = undefined;
    this._pendingGtid = undefined;

    // Executed-GTID-set tracking (drives the zongji.gtidSet checkpoint).
    // Exact seeds: an explicit start set, the server's gtid_executed for
    // startAtEnd (fetched below), or the stream's first Previous_gtids
    // event when dumping from the start of a binlog file. An arbitrary
    // mid-file file+position start has no exact seed, so gtidSet stays
    // undefined there.
    this._executedGtids = null;
    this._seedGtidsFromStream = false;
    if (options.gtidSet != null) {
      try {
        this._executedGtids = GtidSet.parse(options.gtidSet);
      } catch (err) {
        this._starting = false;
        this.emit('error', err);
        return;
      }
    } else if (!options.startAtEnd &&
        (options.position === undefined || options.position <= 4)) {
      this._seedGtidsFromStream = true;
    }

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
        // As above: never mutate options for a superseded start()
        if (epoch !== this._startEpoch) {
          return resolve();
        }
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

    // For startAtEnd the server's own executed set is the exact seed for
    // zongji.gtidSet ("everything up to now"); transactions racing between
    // this query and the dump start are streamed and merge idempotently
    const seedGtidsFromServer = (resolve, reject) => {
      this.ctrlConnection.query(
        'SELECT @@GLOBAL.gtid_executed AS gtidExecuted', (err, rows) => {
          // A stale seed must not overwrite state belonging to a newer
          // start() that superseded this one while the query was in flight
          if (epoch !== this._startEpoch) {
            return resolve();
          }
          if (err) {
            return reject(err);
          }
          try {
            this._executedGtids =
              GtidSet.parse(rows[0].gtidExecuted.replace(/\s/g, ''));
          } catch (parseErr) {
            return reject(parseErr);
          }
          resolve();
        });
    };

    // Attach the current transaction's GTID (tracked at the packet layer,
    // even when 'gtid' events are filtered out). Gtid/AnonymousGtid events
    // keep their own parsed value.
    const attachGtid = (event) => {
      if (!('gtid' in event)) {
        event.gtid = this._currentGtid;
      }
      return event;
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
          if (event.hasSelfDescribingMetadata()) {
            // MySQL 8.0+ with binlog_row_metadata=FULL: the event itself
            // carries complete column metadata as of binlog write time, so
            // no INFORMATION_SCHEMA round-trip (and no connection pause) is
            // needed. Rebuilt on every TableMap event, so ALTER TABLE never
            // leaves stale columns behind.
            this.tableMap[event.tableId] = {
              columnSchemas: event.buildColumnSchemas(),
              parentSchema: event.schemaName,
              tableName: event.tableName,
            };
            event.updateColumnInfo();
            break;
          }
          const tableMap = this.tableMap[event.tableId];
          if (!tableMap || tableMap.tableName !== event.tableName || tableMap.columns.length !== event.columnCount) {
            if (!this.connection) return;
            this.connection.pause();
            attachGtid(event);
            this._fetchTableInfo(event, () => {
              try {
                // merge the column info with metadata
                event.updateColumnInfo();
              } catch (err) {
                // Schema drift between binlog write and metadata fetch:
                // drop the cached entry (subsequent row events for this
                // table id are skipped rather than misdecoded) and report
                delete this.tableMap[event.tableId];
                this.emit('error', err);
                if (this.connection) this.connection.resume();
                return;
              }
              this.emit('binlog', event);
              if (this.connection) this.connection.resume();
            });
            return;
          }
          break;
        }
        case 'Rotate':
          // The payload position is the first event of the NEW file: the
          // only value coherent with binlogName. The header nextPosition
          // refers to the OLD file (0 for the artificial rotate at dump
          // start), so rotates are excluded from the generic update below;
          // persisting (new filename, old-file offset) would corrupt the
          // resume point until the next non-rotate event repaired it.
          this.options.filename = event.binlogName;
          this.options.position = event.position;
          break;
      }
      // Never advance the resume position past a TableMap: a consumer
      // persisting options.position could otherwise resume in the gap
      // between a TableMap and its row events, and with no cached table
      // metadata those rows would be silently dropped. Holding position
      // back means the TableMap is replayed before its rows on resume;
      // rows already seen may be re-emitted (at-least-once), which is
      // recoverable where dropping is not. A narrower window remains for
      // multi-table statements (all TableMaps precede all row events, so
      // emitting the first table's rows advances past the later
      // TableMaps); the complete fix is advancing only at transaction
      // boundaries, tracked pre-filter.
      const typeName = event.getTypeName();
      if (typeName !== 'TableMap' && typeName !== 'Rotate') {
        this.options.position = event.nextPosition;
      }
      this.emit('binlog', attachGtid(event));
    };

    let promises = [new Promise(testChecksum)];

    if (this.options.startAtEnd) {
      promises.push(new Promise(findBinlogEnd));
      if (this._executedGtids === null) {
        promises.push(new Promise(seedGtidsFromServer));
      }
    }

    Promise.all(promises)
      .then(() => {
        // Abort if a newer start() superseded this one (after a stop())
        // while promises were pending
        if (epoch !== this._startEpoch) {
          return;
        }
        this._starting = false;
        // Abort if stop() was called while promises were pending
        if (this.stopped) {
          return;
        }

        this.BinlogClass = initBinlogClass(this);
        this.ready = true;
        this.emit('ready');

        // Final check right before addCommand - connection may have been
        // destroyed or this start() superseded by a ready handler
        if (this.stopped || epoch !== this._startEpoch) {
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
        if (epoch !== this._startEpoch) {
          return;
        }
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

    // Errors emitted by a connection we are deliberately destroying are
    // teardown noise (e.g. in-flight queries failing with
    // ERR_STREAM_WRITE_AFTER_END); do not forward them to the caller
    const silenceErrors = (conn) => {
      conn.removeAllListeners('error');
      conn.on('error', () => {});
    };

    // Capture the connections this stop() owns: finish() may fire from an
    // async callback after a subsequent start() has already created
    // replacement connections, and must not touch those
    const ctrlConnection = this.ctrlConnection;
    const ctrlToClose = this.ctrlConnectionOwner ? ctrlConnection : null;

    // Binary log connection does not end with destroy()
    let connectionThreadId = null;
    if (this.connection) {
      connectionThreadId = this.connection.threadId;
      silenceErrors(this.connection);
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
      if (ctrlToClose) {
        silenceErrors(ctrlToClose);
        ctrlToClose.destroy();
        // @ts-ignore - internal mysql2 API
        if (ctrlToClose.stream && typeof ctrlToClose.stream.unref === 'function') {
          // @ts-ignore - internal mysql2 API
          ctrlToClose.stream.unref();
        }
        if (this.ctrlConnection === ctrlToClose) {
          this.ctrlConnection = null;
        }
      }
      this.emit('stopped');
    };

    if (!ctrlConnection ||
        ctrlConnection.state === 'disconnected' ||
        ctrlConnection._fatalError ||
        ctrlConnection._protocolError ||
        ctrlConnection._closing) {
      if (this.ctrlConnection === ctrlConnection) {
        this.ctrlConnection = null;
      }
      return finish();
    }

    if (!connectionThreadId) {
      return finish();
    }

    const killTimeout = setTimeout(finish, 1000);
    try {
      ctrlConnection.query(
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
