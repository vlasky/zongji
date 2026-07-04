# Changelog

All notable changes to @vlasky/zongji since forking from nevill/zongji.

## Unreleased (0.7.0)

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
