[![npm version](https://img.shields.io/npm/v/@vlasky/zongji.svg)](https://www.npmjs.com/package/@vlasky/zongji)
[![npm downloads](https://img.shields.io/npm/dm/@vlasky/zongji.svg)](https://www.npmjs.com/package/@vlasky/zongji)
[![node version](https://img.shields.io/node/v/@vlasky/zongji.svg)](https://www.npmjs.com/package/@vlasky/zongji)
[![license](https://img.shields.io/npm/l/@vlasky/zongji.svg)](https://github.com/vlasky/zongji/blob/master/LICENSE)

MySQL and MariaDB binlog-based change data capture (CDC) for Node.js, [originally created by Nevill Dutt](https://github.com/nevill/zongji).

[@vlasky/zongji](https://github.com/vlasky/zongji) has been tested working with MySQL 5.7, 8.0 and 8.4, and MariaDB 11.8.

It leverages [`mysql2`](https://github.com/sidorares/node-mysql2) for connections and authentication, while using zongji's binlog parsing and event pipeline.

# Release Notes

See the [CHANGELOG](CHANGELOG.md) for the full release history.

Version 0.6.0 was a major modernisation that rewrote the codebase to use the mysql2 module, ES6 syntax and ESM exports, added TypeScript definitions, and added official support for MySQL 8.4.

Version 0.5.9 is the last release that supports Node.js versions below 18 and CommonJS.

## Quick Start

```javascript
import ZongJi from '@vlasky/zongji';

const zongji = new ZongJi({ /* ... MySQL Connection Settings ... */ });

// Each change to the replication log results in an event
zongji.on('binlog', function(evt) {
  evt.dump();
});

// Binlog must be started, optionally pass in filters
zongji.start({
  includeEvents: ['tablemap', 'writerows', 'updaterows', 'deleterows']
});
```

### GTID example

```javascript
zongji.on('binlog', function(evt) {
  const type = evt.getTypeName();
  if (type === 'Gtid' || type === 'AnonymousGtid') {
    console.log('GTID:', evt.gtid, 'SID:', evt.sid, 'GNO:', evt.gno);
  }
});
```

### TypeScript

TypeScript definitions are included:

```typescript
import ZongJi from '@vlasky/zongji';
```

For a complete implementation see [`example.js`](example.js)...

## Module format

Since v0.6.0 this package is ESM-only. CommonJS projects can load it on Node.js >= 20.17 or >= 22.12, where `require()` of ES modules is supported, or on any supported version via dynamic `import()`:

```javascript
const { default: ZongJi } = await import('@vlasky/zongji');
```

## Installation

* Requires Node.js v18+. Actively supported and tested on Node.js 22, 24 and 26; version 0.7.0 was also verified on Node.js 18 and 20 at release, but those lines are end-of-life and no longer tested.

  ```bash
  $ npm install @vlasky/zongji
  ```

* Enable the binlog in `my.cnf`, restart the server after making the changes.
  > Binlog checksum is enabled by default in all supported MySQL and MariaDB versions. Zongji can work with it, but it doesn't verify the checksum.
  > On MariaDB, `binlog_format` defaults to `MIXED`, so setting it to `row` explicitly matters there in particular.

  ```
  # Must be unique integer from 1-2^32
  server-id        = 1
  # Row format required for ZongJi
  binlog_format    = row
  # Directory must exist. This path works for Linux. Other OS may require
  #   different path.
  log_bin          = /var/log/mysql/mysql-bin.log

  binlog_do_db     = employees   # Optional, limit which databases to log
  expire_logs_days = 10          # Optional, purge old logs
  max_binlog_size  = 100M        # Optional, limit log size

  # Recommended on MySQL 8.0+ / MariaDB 10.5+: makes binlog events carry
  #   complete column metadata (names, signedness, charsets, enum/set
  #   values), so ZongJi decodes rows without querying INFORMATION_SCHEMA
  #   (see below)
  binlog_row_metadata = FULL
  ```
* Create an account with replication privileges, e.g. given privileges to account `zongji` (or any account that you use to read binary logs)

  ```sql
  GRANT REPLICATION SLAVE, REPLICATION CLIENT, SELECT ON *.* TO 'zongji'@'localhost'
  ```

## ZongJi Class

The `ZongJi` constructor accepts one argument of either:

* An object containing MySQL connection details in the same format as used by [package mysql2](https://npm.im/mysql2)
* Or, a [mysql2](https://npm.im/mysql2) `Connection` or `Pool` object that will be used for querying column information.

If a `Connection` or `Pool` object is passed to the constructor, it will not be destroyed/ended by Zongji's `stop()` method.

Binlog row values follow the same [mysql2 connection options](https://sidorares.github.io/node-mysql2/docs/api-and-configurations) as query results, so CDC events and queries on the same connection agree:

Option | Effect on row values
-------|---------------------
`dateStrings` | `DATE`, `DATETIME` and `TIMESTAMP` columns are returned as strings instead of `Date` objects.
`timezone` | Applied when converting `DATETIME` and `TIMESTAMP` values to `Date` objects.
`decimalNumbers` | `DECIMAL` columns are returned as exact strings by default (e.g. `'-123.4500'`); set `decimalNumbers: true` to receive Numbers (may lose precision beyond 15 significant digits).
`jsonStrings` | `JSON` columns are returned as parsed JavaScript values by default; set `jsonStrings: true` to receive JSON strings.

### Table metadata source

To decode row events, ZongJi needs each table's column metadata. It obtains this in one of two ways:

* **From the binlog itself** (MySQL 8.0+ or MariaDB 10.5+ with `binlog_row_metadata=FULL`): every `TableMap` event carries column names, signedness, character sets and enum/set value lists. ZongJi decodes rows entirely from the stream: no `INFORMATION_SCHEMA` queries, no pausing the binlog connection, and no risk of the metadata being stale after an `ALTER TABLE` (each event describes the schema in force when it was written). Enum/set values containing commas or quotes also decode correctly only in this mode.
* **From `INFORMATION_SCHEMA`** (all other cases, including MySQL 5.7, the MySQL default `binlog_row_metadata=MINIMAL` and the MariaDB default `NO_LOG`): on the first event for each table, ZongJi briefly pauses the stream and fetches column metadata over its control connection. If the table is altered between the binlog write and the fetch, decoded rows may be misinterpreted until the next `TableMap` refresh.

Setting `binlog_row_metadata=FULL` on the server is therefore recommended. It is a dynamic global variable (`SET GLOBAL binlog_row_metadata=FULL`) with negligible binlog size overhead for typical schemas. Even under `MINIMAL`, MySQL 8.0+ binlogs carry exact integer signedness, which ZongJi uses in preference to parsing the column definition.

MariaDB caveats under `FULL`: the binlog cannot distinguish `UUID`, `INET4`, `INET6` and `VECTOR` columns from `BINARY`/`VARBINARY`, so in this mode their values arrive as raw `Buffer`s rather than the formatted values the `INFORMATION_SCHEMA` path produces; and tables containing classic temporal type codes (which may hide MariaDB 5.3-era "hires" columns the binlog cannot describe) automatically fall back to the `INFORMATION_SCHEMA` path.

Each instance includes the following methods:

Method Name | Arguments | Description
------------|-----------|------------------------
`start`     | `options` | Start receiving replication events, see options listed below
`stop`      | *None*    | Disconnect from MySQL server, stop receiving events
`on`        | `eventName`, `handler` | Add a listener to the `binlog` or `error` event. Each handler function accepts one argument.

Some events can be emitted in different phases:

Event Name | Description
-----------|------------------------
`ready`    | This event occurs right after ZongJi successfully establishes a connection, sets up replica (slave) status, and sets the binlog position.
`binlog`   | Once a binlog is received and passes the filter, it will bubble up with this event.
`error`    | Every error will be caught by this event.
`stopped`  | Emitted when ZongJi connection is stopped (ZongJi#stop is called).

Always attach an `error` listener. Errors that occur before a listener attaches (for example, a connection failure in the same tick as construction) are buffered and re-delivered to the first `error` listener. If no listener is ever attached, the buffered errors are thrown, following Node's default behaviour for unhandled `'error'` events.

**Options available:**

Option Name | Type | Description
------------|------|-------------------------------
`serverId`  | `integer` | [Unique number (1 - 2<sup>32</sup>)](https://dev.mysql.com/doc/refman/5.0/en/replication-options.html#option_mysqld_server-id) to identify this replication slave instance. Must be specified if running more than one instance of ZongJi. Must be used in `start()` method for effect.<br>**Default:** `1`
`startAtEnd` | `boolean` | Pass `true` to only emit binlog events that occur after ZongJi's instantiation. Must be used in `start()` method for effect.<br>**Default:** `false`
`filename` | `string` | Begin reading events from this binlog file. If specified together with `position`, will take precedence over `startAtEnd`.
`position` | `integer` | Begin reading events from this position. Must be included with `filename`.
`gtidSet` | `string` | Resume from executed GTIDs (e.g. a persisted `zongji.gtidSet`): a MySQL GTID set (`'uuid:1-27'`) or a MariaDB GTID position (`'0-1-1234'`), matching the server flavour. The server locates the correct binlog file itself and skips transactions already processed, so a checkpoint remains valid across failover to another server in the same replication topology. Requires `gtid_mode=ON` on MySQL; always available on MariaDB. Pass `''` to stream the entire available history. Takes precedence over `filename`/`position` and `startAtEnd`.
`requestAnnotateRows` | `boolean` | MariaDB only: ask the server to send `annotaterows` events (the SQL statement text preceding each row operation's events). Off by default; note the statement text may contain sensitive literals that the row images alone would not expose. Ignored on MySQL.<br>**Default:** `false`
`includeEvents` | `[string]` | Array of event names to include<br>**Example:** `['writerows', 'updaterows', 'deleterows']`
`excludeEvents` | `[string]` | Array of event names to exclude<br>**Example:** `['rotate', 'tablemap']`
`includeSchema` | `object` | Object describing which databases and tables to include (Only for row events). Use database names as the key and pass an array of table names or `true` (for the entire database).<br>**Example:** ```{ 'my_database': ['allow_table', 'another_table'], 'another_db': true }```
`excludeSchema` | `object` | Object describing which databases and tables to exclude (Same format as `includeSchema`)<br>**Example:** ```{ 'other_db': ['disallowed_table'], 'ex_db': true }```

* By default, all events and schema are emitted.
* `excludeSchema` and `excludeEvents` take precedence over `includeSchema` and `includeEvents`, respectively.
* Calling `start()` while a previous `start()` is still initialising is ignored and the first call completes. The exception is after an intervening `stop()`: the new `start()` then restarts cleanly, and exactly one binlog stream is opened.
* Calling `start()` while ZongJi is already running does not reconnect; it only updates the event and schema filters from the given options.

**Supported Binlog Events:**

Event name  | Description
------------|---------------
`unknown`   | Catch any other events
`query`     | [Insert/Update/Delete Query](https://dev.mysql.com/doc/internals/en/query-event.html)
`intvar`    | [Autoincrement and LAST_INSERT_ID](https://dev.mysql.com/doc/internals/en/intvar-event.html)
`rotate`    | [New Binlog file](https://dev.mysql.com/doc/internals/en/rotate-event.html). The `filename` and `position` resume properties stay updated across rotations whether or not this event is included; include it only if you want to observe rotations yourself.
`format`    | [Format Description](https://dev.mysql.com/doc/internals/en/format-description-event.html)
`xid`       | [Transaction ID](https://dev.mysql.com/doc/internals/en/xid-event.html)
`gtid`      | MySQL GTID event with `gtid`, `sid`, `gno` properties
`anonymousgtid` | MySQL anonymous GTID event (same shape as `gtid`)
`previousgtids` | MySQL Previous GTIDs event with `gtidSet` and `sids`
`mariadbgtid` | MariaDB GTID event with `gtid` (`'domain-server-sequence'`), `domainId`, `serverId`, `seqNo` and flags (`standalone`, `isDdl`, XA states). Replaces the `BEGIN` query event of a transaction.
`mariadbgtidlist` | MariaDB GTID list event (start of every binlog file): the last GTID per domain and server seen so far, MariaDB's analogue of `previousgtids`
`binlogcheckpoint` | MariaDB binlog checkpoint event naming the oldest binlog file still needed for crash recovery (informational)
`annotaterows` | MariaDB: the SQL `statement` that produced the row events that follow (the analogue of MySQL's rows-query event). Only sent when `start()` was given `requestAnnotateRows: true`; useful for audit trails and statement attribution in CDC records
`rowsquery` | MySQL: the SQL `statement` that produced the row events that follow (the analogue of MariaDB's `annotaterows`). Sent to every consumer while the server runs with `binlog_rows_query_log_events=ON` (default `OFF`); no `start()` option is involved. The same sensitivity note applies: statement text may contain literals
`startencryption` | MariaDB encrypted-binlog marker (informational: the server decrypts before sending, the stream itself is cleartext)
`xaprepare` | XA PREPARE event (MySQL 5.7+ and MariaDB) terminating an XA-prepared event group, with `xidFormatId`, `xidGtrid`, `xidBqual` and `onePhase`
`heartbeat` | Sent by the server instead of real events: while the connection idles, and in place of transactions skipped server-side during a GTID resume. Carries `binlogName`; `nextPosition` holds the advanced position.
`tablemap`  | Before any row event (must be included for any other row events)
`writerows` | Rows inserted, row data array available as `rows` property on event object
`updaterows` | Rows changed, row data array available as `rows` property on event object
`deleterows` | Rows deleted, row data array available as `rows` property on event object
`transactionpayload` | Compressed transaction from MySQL 8.0.20+ servers with `binlog_transaction_compression=ON`. ZongJi cannot decode the row events inside it, so it emits an `error` (once per instance) naming the server setting responsible. (MariaDB's equivalent, `log_bin_compress=ON`, IS supported: its compressed events decode transparently as ordinary `query` and row events.)
`partialupdaterows` | Partial JSON update from MySQL 8.0+ servers with `binlog_row_value_options=PARTIAL_JSON`. ZongJi cannot decode the JSON diff format, so it emits an `error` (once per instance) naming the server setting responsible.

When the server runs with `gtid_mode=ON` (MySQL), or always on MariaDB, every emitted event carries a `gtid` property (`'uuid:sequence'` on MySQL, `'domain-server-sequence'` on MariaDB) identifying the transaction it belongs to, tracked internally even if GTID events are excluded by `includeEvents`. It is `undefined` for anonymous transactions, for events seen before the stream's first GTID event, and for events that belong to no transaction (e.g. a rotate arriving between one transaction's commit and the next transaction's GTID event; the commit event itself still carries its transaction's `gtid`). One exception: a DDL statement has no commit marker of its own, so its `gtid` persists on such trailing events until the next transaction begins. Use it for checkpointing and deduplication. The same value is available as `zongji.lastGtid` while an event is being delivered; it is only coherent when read synchronously inside a `'binlog'` handler, so checkpointing code should prefer `event.gtid`.

### GTID-based resume

`zongji.gtidSet` exposes the executed GTIDs as a string: a MySQL GTID set (e.g. `'3e11fa47-…:1-27'`) or a MariaDB GTID position (e.g. `'0-1-1234'`), depending on the connected server. It is the value ZongJi started from, extended as each observed transaction *commits*, so a persisted value never claims a transaction whose row events were still in flight. Persist it alongside (or instead of) `filename`/`position` and resume with:

```javascript
zongji.start({ gtidSet: savedGtidSet, serverId: 5 });
```

Unlike file+position checkpoints, a GTID checkpoint is valid on any server in the same replication topology, which makes resuming across a failover possible. The server performs the skipping itself, so already-processed transactions are not resent.

`zongji.gtidSet` is available when `start()` was given a `gtidSet`, with `startAtEnd` (seeded from the server's `gtid_executed` on MySQL, `gtid_current_pos` on MariaDB), or when reading from the start of a binlog file (seeded from its Previous_gtids or MariaDB GTID list event). It is `undefined` when resuming from an arbitrary mid-file file+position checkpoint, where no exact value can be known.

On MySQL, GTID resume requires `gtid_mode=ON` and a set is a per-source-UUID collection of intervals. On MariaDB, GTIDs are always on and a position is a single watermark per replication domain (`domain-server-sequence`): resuming replays each listed domain after its watermark, and domains not listed replay from the beginning. If the server has purged binlogs your checkpoint still needs, `start()` emits an error (code 1236) naming the problem; MariaDB additionally reports a checkpoint ahead of its binlog as error 1945/1955. A fresh snapshot is then required.

**Event Methods**

Neither method requires any arguments.

Name   | Description
-------|---------------------------
`dump` | Log a description of the event to the console
`getEventName` | Return the name of the event

## Important Notes

* :star2: All MySQL column types are supported, with type casting similar to [mysql2](https://github.com/sidorares/node-mysql2).
* MariaDB-specific types and features are supported: `UUID`, `INET4` and `INET6` decode to their canonical text forms and `VECTOR` to a raw `Buffer` of little-endian float32s (matching mysql2 query results); MariaDB `JSON` is a `LONGTEXT` alias and yields strings; `COMPRESSED` columns are decompressed transparently; compressed binlog events (`log_bin_compress=ON`) decode as ordinary query/row events; and MariaDB 5.3-era "hires" temporal columns (tables written under `mysql56_temporal_format=OFF`) decode correctly.
* :speak_no_evil: 64-bit integers are decoded exactly using native BigInt (see #108). If an integer is within the safe range of JS numbers (-2^53, 2^53), a Number is returned, otherwise an exact String. This also applies to 64-bit integers inside JSON columns.
* :point_right: `TRUNCATE` statement does not cause corresponding `DeleteRows` event. Use unqualified `DELETE FROM` for same effect.
* When using fractional seconds with `DATETIME` and `TIMESTAMP` data types, only millisecond precision is available due to the limit of Javascript's `Date` object.
* Binlog checksums (e.g. `CRC32`) are supported; zongji will detect and ignore the checksum bytes at the end of row events.

## Run Tests

* Install [Docker](https://www.docker.com/community-edition#download)
* Run `docker-compose up -d` to start the MySQL and MariaDB containers
* Run `npm test` to execute the test suite against MySQL 8.4 (port 3306)
* Run `TEST_MYSQL_PORT=3308 npm test` to execute it against MariaDB 11.8; MySQL-only tests skip automatically, and the MariaDB-specific suite in `test/mariadb.js` runs (it no-ops against MySQL)

## References

The following resources provided valuable information that greatly assisted in creating ZongJi:

* https://github.com/sidorares/node-mysql2
* https://github.com/mysqljs/mysql
* https://github.com/felixge/faster-than-c/
* https://web.archive.org/web/20130117004733/https://intuitive-search.blogspot.co.uk/2011/07/binary-log-api-and-replication-listener.html
* https://github.com/Sannis/node-mysql-libmysqlclient
* https://kkaefer.com/node-cpp-modules/
* https://dev.mysql.com/doc/internals/en/replication-protocol.html
* https://web.archive.org/web/20200201195450/https://www.cs.wichita.edu/~chang/lecture/cs742/program/how-mysql-c-api.html
* https://github.com/jeremycole/mysql_binlog (Ruby implementation of MySQL binlog parser)
* https://dev.mysql.com/doc/internals/en/date-and-time-data-type-representation.html

## License
MIT
