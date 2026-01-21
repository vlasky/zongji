const mysql = require('mysql2');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const initBinlogClass = require('./lib/sequence/binlog');

const ConnectionConfigMap = {
  'Connection': obj => obj.config,
  'Pool': obj => obj.config.connectionConfig,
};

const TableInfoQueryTemplate = `SELECT 
  COLUMN_NAME, COLLATION_NAME, CHARACTER_SET_NAME, 
  COLUMN_COMMENT, COLUMN_TYPE 
  FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='%s' AND TABLE_NAME='%s' 
  ORDER BY ORDINAL_POSITION`;

function ZongJi(dsn) {
  EventEmitter.call(this);

  this._pendingErrors = [];
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
  this.ready = false;
  this.stopped = false;
  this.useChecksum = false;

  this._dsn = dsn;
  this.ctrlConnection = null;
  this.connection = null;
  this.ctrlConnectionOwner = false;
}

util.inherits(ZongJi, EventEmitter);

// dsn - can be one instance of Connection or Pool / object / url string
ZongJi.prototype._establishConnection = function(dsn) {
  const createConnection = (options) => {
    const emitError = (err) => {
      if (this.listenerCount('error') === 0) {
        this._pendingErrors.push(err);
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
};

ZongJi.prototype._isChecksumEnabled = function(next) {
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
};

ZongJi.prototype._findBinlogEnd = function(next) {
  this.ctrlConnection.query('SHOW BINARY LOGS', (err, rows) => {
    if (err) {
      // Errors should be emitted
      next(err);
    }
    else {
      next(null, rows.length > 0 ? rows[rows.length - 1] : null);
    }
  });
};

ZongJi.prototype._fetchTableInfo = function(tableMapEvent, next) {
  const sql = util.format(TableInfoQueryTemplate,
    tableMapEvent.schemaName, tableMapEvent.tableName);

  if (!this.ctrlConnection ||
      this.ctrlConnection.state === 'disconnected' ||
      this.ctrlConnection._fatalError ||
      this.ctrlConnection._protocolError ||
      this.ctrlConnection._closing) {
    return;
  }

  try {
    this.ctrlConnection.query(sql, (err, rows) => {
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
};

// #_options will reset all the options.
ZongJi.prototype._options = function({
  serverId,
  filename,
  position,
  startAtEnd,
}) {
  this.options = {
    serverId,
    filename,
    position,
    startAtEnd,
  };
};

// #_filters will reset all the filters.
ZongJi.prototype._filters = function({
  includeEvents,
  excludeEvents,
  includeSchema,
  excludeSchema,
}) {
  this.filters = {
    includeEvents,
    excludeEvents,
    includeSchema,
    excludeSchema,
  };
};

ZongJi.prototype.get = function(name) {
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
};

// @options contains a list options
// - `serverId` unique identifier
// - `filename`, `position` the position of binlog to beigin with
// - `startAtEnd` if true, will update filename / postion automatically
// - `includeEvents`, `excludeEvents`, `includeSchema`, `exludeSchema` filter different binlog events bubbling
ZongJi.prototype.start = function(options = {}) {
  // If already running, just update filters (for pause/resume) and return
  if (this.ready && !this.stopped) {
    this._filters(options);
    return;
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

    // Do not emit events that have been filtered out
    if (event === undefined || event._filtered === true) return;

    switch (event.getTypeName()) {
      case 'TableMap': {
        const tableMap = this.tableMap[event.tableId];
        if (!tableMap || tableMap.tableName !== event.tableName || tableMap.columns.length !== event.columnCount) {
          this.connection.pause();
          this._fetchTableInfo(event, () => {
            // merge the column info with metadata
            event.updateColumnInfo();
            this.emit('binlog', event);
            this.connection.resume();
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
      // Check if stop() was called while promises were pending
      if (this.stopped) {
        return;
      }

      this.BinlogClass = initBinlogClass(this);
      this.ready = true;
      this.emit('ready');

      // Final check right before enqueue - connection may have been destroyed
      // after the ready event was emitted (e.g., if a listener called stop())
      if (this.stopped) {
        return;
      }

      this.connection.addCommand(new this.BinlogClass(binlogHandler));
    })
    .catch(err => {
      this.emit('error', err);
    });

};

ZongJi.prototype.stop = function() {
  this.stopped = true;

  if (!this.connection && !this.ctrlConnection) {
    this.emit('stopped');
    return;
  }

  // Binary log connection does not end with destroy()
  if (this.connection) {
    this.connection.destroy();
    if (this.connection.stream && typeof this.connection.stream.unref === 'function') {
      this.connection.stream.unref();
    }
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (this.ctrlConnectionOwner) {
      this.ctrlConnection.destroy();
      if (this.ctrlConnection.stream && typeof this.ctrlConnection.stream.unref === 'function') {
        this.ctrlConnection.stream.unref();
      }
    }
    this.emit('stopped');
  };

  if (!this.ctrlConnection ||
      this.ctrlConnection.state === 'disconnected' ||
      this.ctrlConnection._fatalError ||
      this.ctrlConnection._protocolError ||
      this.ctrlConnection._closing) {
    return finish();
  }

  if (!this.connection || !this.connection.threadId) {
    return finish();
  }

  const killTimeout = setTimeout(finish, 1000);
  try {
    this.ctrlConnection.query(
      'KILL ' + this.connection.threadId,
      () => {
        clearTimeout(killTimeout);
        finish();
      }
    );
  } catch {
    clearTimeout(killTimeout);
    finish();
  }
};

// It includes every events by default.
ZongJi.prototype._skipEvent = function(name) {
  const includes = this.filters.includeEvents;
  const excludes = this.filters.excludeEvents;

  let included = (includes === undefined) ||
    (Array.isArray(includes) && (includes.indexOf(name) > -1));
  let excluded = Array.isArray(excludes) && (excludes.indexOf(name) > -1);

  return excluded || !included;
};

// It doesn't skip any schema by default.
ZongJi.prototype._skipSchema = function(database, table) {
  const includes = this.filters.includeSchema;
  const excludes = this.filters.excludeSchema || {};

  let included = (includes === undefined) ||
    (
      (database in includes) &&
      (
        includes[database] === true ||
        (
          Array.isArray(includes[database]) &&
          includes[database].indexOf(table) > -1
        )
      )
    );
  let excluded = (database in excludes) &&
    (
      excludes[database] === true ||
      (
        Array.isArray(excludes[database]) &&
        excludes[database].indexOf(table) > -1
      )
    );

  return excluded || !included;
};

module.exports = ZongJi;
