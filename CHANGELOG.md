# Changelog

All notable changes to @vlasky/zongji since forking from nevill/zongji.

## Unreleased

- MariaDB support (tested against MariaDB 11.8): ZongJi now detects the server flavour and follows MariaDB binlogs natively, announcing `@mariadb_slave_capability=4` so the server sends its real GTID events instead of rewriting them for legacy clients. MariaDB's GTID model (a `domain-server-sequence` watermark per replication domain) is fully supported: events carry `event.gtid` in MariaDB format, `zongji.gtidSet` exposes a MariaDB GTID position (seeded from `start({ gtidSet })`, from `@@gtid_current_pos` under `startAtEnd`, or from the GTID list event at the start of a binlog file), and `start({ gtidSet: '0-1-1234' })` resumes via `@slave_connect_state` with server-side skipping, including across failover. New event types: `mariadbgtid`, `mariadbgtidlist`, `binlogcheckpoint`, `startencryption`, plus `xaprepare` (also emitted by MySQL 5.7+, previously `unknown`). MariaDB data types decode to match mysql2 query results: `UUID`, `INET4` and `INET6` as canonical text, `VECTOR` as a raw Buffer, `JSON` as the LONGTEXT alias text it is, `COMPRESSED` columns transparently decompressed (with correct charsets, under all `binlog_row_metadata` settings), MariaDB 5.3-era "hires" temporals (`mysql56_temporal_format=OFF`) decoded correctly instead of desynchronising the row, and compressed binlog events (`log_bin_compress=ON`) decoded transparently as ordinary query/row events. `binlog_row_metadata=FULL` works on MariaDB 10.5+ with the same self-describing decode as MySQL; tables whose classic temporal columns could hide hires encodings automatically use `INFORMATION_SCHEMA` instead, and `UUID`/`INET*`/`VECTOR` values arrive as raw Buffers in FULL mode (the binlog cannot distinguish them from `BINARY`). An opt-in `requestAnnotateRows` start option asks the server for `annotaterows` events carrying the SQL statement text behind each row operation. The test suite runs against MariaDB 11.8 in CI alongside MySQL 5.7/8.0/8.4, and an offline MariaDB fixture pins the captured wire bytes of all of the above in the parser tests.
- Fix the resume position (`options.position`) going stale when the events carrying real positions are excluded by `includeEvents`: filtered events now advance it at the packet layer under the same safety rules as delivered ones (never past a TableMap, never a zero position). On MySQL the position merely lagged; on MariaDB, where events inside a transaction carry `end_log_pos=0`, common filter sets froze it entirely.
- Fix a filtered `rotate` event leaving an incoherent resume pair: the filename never updated while later events advanced the position into the new file. Rotates now update the `filename`/`position` pair before event filtering, whether delivered or not.
- GTID-based resume: `start({ gtidSet })` issues COM_BINLOG_DUMP_GTID, letting the server locate the correct binlog file and skip already-processed transactions itself; a persisted checkpoint therefore survives failover to another server in the same replication topology (requires `gtid_mode=ON`). `zongji.gtidSet` exposes the executed set for persisting: seeded exactly from the start set, from the server's `gtid_executed` under `startAtEnd`, or from the stream's Previous_gtids event when reading from the start of a binlog file, and extended only as observed transactions commit. Purged-GTID and GTID-mode errors surface through the `error` event. Heartbeat events (sent in place of server-side-skipped transactions and while idle) are now decoded instead of falling through to `unknown`, and Previous_gtids string formatting is canonical (single transactions print as `8`, not `8-8`)
- Support `binlog_row_metadata=FULL` (MySQL 8.0+): TableMap events now parse the optional metadata block (column names, signedness, character sets, enum/set value lists, primary key, column visibility), and when it is complete ZongJi decodes rows entirely from the binlog stream with no `INFORMATION_SCHEMA` queries and no connection pauses. Each TableMap event rebuilds the table's metadata, so `ALTER TABLE` can no longer leave stale column definitions behind. Enum/set values containing commas or quotes decode correctly in this mode (the `INFORMATION_SCHEMA` path cannot represent them). Under the default `binlog_row_metadata=MINIMAL`, integer signedness now comes from the binlog instead of being inferred from the `COLUMN_TYPE` string. TableMap events expose `columnNames`, `signedness`, `primaryKey` and `columnVisibility` where available, and column schemas gain `UNSIGNED`, `ENUM_VALUES` and `SET_VALUES`.

## [0.7.1] - 2026-07-04

- Fix `start()` calls made while a previous `start()` was still initialising silently discarding their filters. Since 0.7.0 filters are snapshotted and re-calling `start()` is the documented way to update them, but updates made between `start()` and the `ready` event were lost; consumers registering tables during boot (e.g. @vlasky/mysql-live-select) missed events for tables added in that window. Filters passed during initialisation now apply, exactly as when already running; stream options (filename/position/serverId) still come from the first call.
- Fix a resume-position gap that could silently drop row events. `options.position` was advanced past TableMap events on the cached-metadata path, so a consumer persisting `filename`/`position` for reconnect could resume between a TableMap and its row events; the resumed instance had no metadata for the table id and dropped those rows with no error. TableMap events no longer advance the resume position, closing the gap for single-table statements (the common case). A narrower window remains for multi-table statements (multi-table UPDATE, foreign-key cascades), where the server writes all TableMap events before any row events: emitting the first table's rows still advances the position past the later TableMaps. Rows already processed before a crash may be re-delivered after resume (at-least-once), which is recoverable where dropping is not.
- Fix rotate events corrupting the `filename`/`position` resume pair. A rotate's header position refers to the old binlog file (0 for the artificial rotate at the start of every dump), yet it was written into `options.position` alongside the new file's name; a consumer resuming from that pair after a real rotation could get "position > file size" or a mid-event read, and the artificial rotate silently reset the start position to 0. The rotate's payload position (the start of the new file) is now used, and the filename update is unconditional. Present in every zongji release since the original upstream project.
- Fix a corrupt GTID event's parse error being swallowed when `gtid` is excluded by `includeEvents`; the whole following transaction was then silently mislabelled as anonymous. The error now reaches the `error` event regardless of filtering.
- Schema drift between a binlog event being written and the metadata fetch (e.g. a column dropped in between) now emits a descriptive error naming the table and column counts, instead of throwing a bare TypeError from inside event parsing; the affected table's rows are skipped until its next TableMap event refreshes the metadata.

## [0.7.0] - 2026-07-04

### Breaking changes

- DECIMAL columns now emit exact string values (e.g. `'-123.4500'`) instead of lossy floats, matching mysql2 query results. Migration: set `decimalNumbers: true` on the connection options passed to ZongJi to restore Numbers.
- JSON columns now emit parsed JavaScript values instead of JSON strings, matching mysql2 query results. Migration: set `jsonStrings: true` on the connection options passed to ZongJi to restore strings. In string mode, output now uses MySQL's own formatting (spaces after `:` and `,`) and 64-bit integers appear as exact raw numerals rather than lossy doubles.
- Event and schema filters are snapshotted when `start()` is called; mutating the arrays or objects you passed in no longer changes filtering afterwards. Migration: call `start()` again with the new filters (the documented way to update them).

### Other changes

- Fix SQL injection in the table metadata query: schema and table names from TableMap events are now bound via a cached prepared statement (`execute()`) instead of being spliced into SQL text
- Replace the big-integer dependency with native BigInt (one fewer dependency); also fixes silent corruption of 64-bit integers inside JSON columns beyond 2^53, which now follow the same exact Number-or-string rule as BIGINT columns
- Emit an error (once per instance per type) when the server sends undecodable TRANSACTION_PAYLOAD_EVENT (`binlog_transaction_compression=ON`) or PARTIAL_UPDATE_ROWS_EVENT (`binlog_row_value_options=PARTIAL_JSON`) events, instead of silently dropping the row changes; remaining MySQL 8 event codes (TRANSACTION_CONTEXT, VIEW_CHANGE, XA_PREPARE, HEARTBEAT_V2) are now named in the code map
- Lifecycle hardening: emit an explicit error instead of hanging silently when the control connection dies during a metadata fetch; a duplicate `start()` while one is still initialising is ignored, while stop-then-restart during initialisation now works (exactly one binlog dump command is ever enqueued); errors from connections deliberately destroyed by `stop()` are no longer forwarded as teardown noise; errors buffered before an `error` listener attaches are thrown if no listener ever appears, restoring Node's default unhandled `'error'` behaviour
- DECIMAL parsing no longer mutates the shared network packet buffer when flipping the sign bit
- Fix `stop()` destroying the control connection of a subsequent `start()`: the asynchronous KILL cleanup now only touches the connections that particular `stop()` owned, so immediate stop-then-restart no longer wedges the new stream on its first metadata fetch
- The `nonBlock` option declared in the TypeScript definitions is now actually passed through by `start()`; previously it was dropped and the dump command always ran in blocking mode
- Remove dead code left over from the mysql.js protocol layer (ComBinlog, EofPacket/ErrorPacket, BufferReader)
- Compile event and schema filters into Sets and Maps for O(1) per-event filtering; only own keys of schema filter objects are considered
- Add a package.json `exports` map with `types` and `default` conditions
- All emitted events carry an `event.gtid` property (`'uuid:sequence'`) identifying their transaction when the server runs with `gtid_mode=ON`, tracked at the packet layer so it works even when `gtid` events are excluded by `includeEvents`; `undefined` for anonymous transactions
- Update mysql2 to ^3.22.5; the internal APIs zongji relies on (addCommand, handlePacket, packet sequence validation) were verified unchanged, and a new regression test covers the binlog stream over a compressed connection
- Continuous integration now tests Node.js 22, 24 and 26 against MySQL 5.7, 8.0 and 8.4. Node.js 18 and 20 are end-of-life: they remain allowed by `engines` (nothing in the code requires anything newer) and 0.7.0 passed the full test suite on both at release time, but they are no longer tested and future releases may break on them

## [0.6.1] - 2026-02-13

- Updated .gitignore and .npmignore to exclude AI tool and build/test files
- Added npm version, downloads, node version, and licence badges to README

## [0.6.0] - 2026-02-13

- Migrate from @vlasky/mysql to mysql2
- Convert codebase to ES modules
- Add TypeScript definitions
- Add official support for MySQL 8.4
- Fix sequence ID warnings when using compression with binlog streams
- Fix connection cleanup in stop() to prevent reuse of destroyed connections
- Add stopped flag to support dynamic filter updates and safe stop during init
- Fix flaky error test by handling all error events instead of just the first

## [0.5.9] - 2023-01-11

- Allow BLOB columns with utf8mb3 charset

## [0.5.8] - 2021-09-19

- Internal version bump

## [0.5.7] - 2021-07-08

- Fix connection when binlog_checksum is NONE

## [0.5.6] - 2021-04-30

- Update to @vlasky/mysql 2.18.5 with keepalive probe packet support

## [0.5.5] - 2021-04-17

- Update to @vlasky/mysql 2.18.4 to support additional charset collations in MySQL 8

## [0.5.4] - 2021-04-17

- Update to @vlasky/mysql 2.18.3 to support caching_sha2_password authentication plugin (MySQL 8 default)

## [0.5.3] - 2021-03-24

- Update to @vlasky/mysql 2.18.2 to support new MySQL 8 error codes
- Handle table map events that change table IDs (from YousefED)
- Fix null value in JSON column causing buffer RangeError (from YousefED)
- MySQL 8 compatibility fix for column mapping query order

## [0.5.2] - 2020-11-11

- Fix IEEE754 conversion error using DataView (from jefbarn)
- Update dependencies

## [0.5.1] - 2019-11-09

- Initial fork from nevill/zongji
- Add binlog_row_image support
