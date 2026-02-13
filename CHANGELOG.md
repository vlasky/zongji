# Changelog

All notable changes to @vlasky/zongji since forking from nevill/zongji.

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
