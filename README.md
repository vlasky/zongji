MySQL binlog-based change data capture (CDC) for Node.js, [originally created by Nevill Dutt](https://github.com/nevill/zongji).

[@vlasky/zongji](https://github.com/vlasky/zongji) has been tested working with MySQL 5.7, 8.0 and 8.4.

It leverages [`mysql2`](https://github.com/sidorares/node-mysql2) for connections and authentication, while using zongji's binlog parsing and event pipeline.

# Latest Release

Version 0.6.0 is a major modernisation that rewrites the codebase to use the mysql2 module, ES6 syntax and ESM exports, adds TypeScript definitions, and adds official support for MySQL 8.4.

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

## Installation

* Requires Node.js v18+

  ```bash
  $ npm install @vlasky/zongji
  ```

* Enable MySQL binlog in `my.cnf`, restart MySQL server after making the changes.
  > Binlog checksum is enabled by default in all supported MySQL versions. Zongji can work with it, but it doesn't verify the checksum.

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

The `dateStrings` and `timezone` configuration options from the connection details are respected for date/time value handling.

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

**Options available:**

Option Name | Type | Description
------------|------|-------------------------------
`serverId`  | `integer` | [Unique number (1 - 2<sup>32</sup>)](https://dev.mysql.com/doc/refman/5.0/en/replication-options.html#option_mysqld_server-id) to identify this replication slave instance. Must be specified if running more than one instance of ZongJi. Must be used in `start()` method for effect.<br>**Default:** `1`
`startAtEnd` | `boolean` | Pass `true` to only emit binlog events that occur after ZongJi's instantiation. Must be used in `start()` method for effect.<br>**Default:** `false`
`filename` | `string` | Begin reading events from this binlog file. If specified together with `position`, will take precedence over `startAtEnd`.
`position` | `integer` | Begin reading events from this position. Must be included with `filename`.
`includeEvents` | `[string]` | Array of event names to include<br>**Example:** `['writerows', 'updaterows', 'deleterows']`
`excludeEvents` | `[string]` | Array of event names to exclude<br>**Example:** `['rotate', 'tablemap']`
`includeSchema` | `object` | Object describing which databases and tables to include (Only for row events). Use database names as the key and pass an array of table names or `true` (for the entire database).<br>**Example:** ```{ 'my_database': ['allow_table', 'another_table'], 'another_db': true }```
`excludeSchema` | `object` | Object describing which databases and tables to exclude (Same format as `includeSchema`)<br>**Example:** ```{ 'other_db': ['disallowed_table'], 'ex_db': true }```

* By default, all events and schema are emitted.
* `excludeSchema` and `excludeEvents` take precedence over `includeSchema` and `includeEvents`, respectively.

**Supported Binlog Events:**

Event name  | Description
------------|---------------
`unknown`   | Catch any other events
`query`     | [Insert/Update/Delete Query](https://dev.mysql.com/doc/internals/en/query-event.html)
`intvar`    | [Autoincrement and LAST_INSERT_ID](https://dev.mysql.com/doc/internals/en/intvar-event.html)
`rotate`    | [New Binlog file](https://dev.mysql.com/doc/internals/en/rotate-event.html) Not required to be included to rotate to new files, but it is required to be included in order to keep the `filename` and `position` properties updated with current values for [graceful restarting on errors](https://gist.github.com/numtel/5b37b2a7f47b380c1a099596c6f3db2f).
`format`    | [Format Description](https://dev.mysql.com/doc/internals/en/format-description-event.html)
`xid`       | [Transaction ID](https://dev.mysql.com/doc/internals/en/xid-event.html)
`gtid`      | GTID event with `gtid`, `sid`, `gno` properties
`anonymousgtid` | Anonymous GTID event (same shape as `gtid`)
`previousgtids` | Previous GTIDs event with `gtidSet` and `sids`
`tablemap`  | Before any row event (must be included for any other row events)
`writerows` | Rows inserted, row data array available as `rows` property on event object
`updaterows` | Rows changed, row data array available as `rows` property on event object
`deleterows` | Rows deleted, row data array available as `rows` property on event object

**Event Methods**

Neither method requires any arguments.

Name   | Description
-------|---------------------------
`dump` | Log a description of the event to the console
`getEventName` | Return the name of the event

## Important Notes

* :star2: All MySQL column types are supported, with type casting similar to [mysql2](https://github.com/sidorares/node-mysql2).
* :speak_no_evil: 64-bit integer is supported via package big-integer(see #108). If an integer is within the safe range of JS number (-2^53, 2^53), a Number object will returned, otherwise, will return as String.
* :point_right: `TRUNCATE` statement does not cause corresponding `DeleteRows` event. Use unqualified `DELETE FROM` for same effect.
* When using fractional seconds with `DATETIME` and `TIMESTAMP` data types, only millisecond precision is available due to the limit of Javascript's `Date` object.
* Binlog checksums (e.g. `CRC32`) are supported; zongji will detect and ignore the checksum bytes at the end of row events.

## Run Tests

* Install [Docker](https://www.docker.com/community-edition#download)
* Run `docker-compose up -d` to start MySQL containers
* Run `npm test` to execute the test suite

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
