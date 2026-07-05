// Captures raw binlog packets from a running MySQL server into
// test/fixtures/*.json so the parsing layer can be tested offline
// (see test/parser.js). Regenerate with:
//
//   node scripts/capture-fixtures.js [suffix] [--full]
//
// --full captures with binlog_row_metadata=FULL (restored afterwards).
//
// against a MySQL server started like the test containers
// (docker-compose up -d mysql84). Environment overrides:
// MYSQL_HOST, TEST_MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2';
import ZongJi from '../index.js';

const FIXTURE_DB = 'zongji_fixture_capture';
const args = process.argv.slice(2).filter(arg => arg !== '--full');
// --full captures with binlog_row_metadata=FULL (MySQL 8.0+), making
// TableMap events self-describing; the fixture then omits tableSchemas
// so tests prove decoding works without INFORMATION_SCHEMA
const FULL_METADATA = process.argv.includes('--full');
const SUFFIX = args[0] || 'mysql';

const connectionSettings = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.TEST_MYSQL_PORT || 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'secret',
  timezone: 'Z',
  dateStrings: ['TIMESTAMP'],
};

// The statements whose binlog events form the fixture. Session time_zone is
// pinned so TIMESTAMP values are reproducible. On MySQL the last insert
// runs under binlog_rows_query_log_events=ON so the fixture carries a
// ROWS_QUERY event (the variable does not exist on MariaDB, whose
// annotate analogue is captured via requestAnnotateRows below).
const CAPTURE_TABLE = 'capture_types';
const captureStatements = [
  'SET @@session.time_zone = "+00:00"',
  `CREATE TABLE ${CAPTURE_TABLE} (
    id INT PRIMARY KEY,
    i_big BIGINT,
    u_big BIGINT UNSIGNED,
    dec_col DECIMAL(30, 10),
    vc VARCHAR(20),
    ch CHAR(5),
    bin_col BINARY(4),
    vb VARBINARY(8),
    txt TEXT,
    blb BLOB,
    flt FLOAT,
    dbl DOUBLE,
    dt DATETIME(3),
    ts TIMESTAMP NULL,
    d DATE,
    t TIME(3),
    y YEAR,
    e ENUM('a', 'b', 'c'),
    e2 ENUM('a,b', 'c''d', 'plain'),
    s SET('x', 'y', 'z'),
    bt BIT(10),
    js JSON,
    geo GEOMETRY,
    txt_latin1 TEXT CHARACTER SET latin1,
    vc_latin1 VARCHAR(20) CHARACTER SET latin1,
    vc_ucs2 VARCHAR(10) CHARACTER SET ucs2
  )`,
  `INSERT INTO ${CAPTURE_TABLE} VALUES (
    1,
    9223372036854775807,
    18446744073709551615,
    -12345678901234567.0123456789,
    'héllo wörld',
    'abc',
    X'DEADBEEF',
    X'0102',
    'text value',
    X'CAFE',
    1.25,
    -2.5,
    '2024-06-15 12:34:56.789',
    '2024-06-15 12:34:56',
    '2024-06-15',
    '-01:02:03.500',
    2024,
    'b',
    'c''d',
    'x,z',
    b'1000000001',
    '{"a": 1, "big": 9223372036854775807, "arr": ["x", true, null], "d": 1.5}',
    ST_GeomFromText('POINT(1 2)'),
    'café ñ',
    'Ÿ€ señor',
    'héllo'
  )`,
  `UPDATE ${CAPTURE_TABLE} SET id = 2, vc = 'updated' WHERE id = 1`,
  `DELETE FROM ${CAPTURE_TABLE} WHERE id = 2`,
];

const mysqlRowsQueryStatements = [
  'SET SESSION binlog_rows_query_log_events = ON',
  `INSERT INTO ${CAPTURE_TABLE} (id) VALUES (3)`, // all other columns NULL
  'SET SESSION binlog_rows_query_log_events = OFF',
];

const mariadbNullRowStatements = [
  `INSERT INTO ${CAPTURE_TABLE} (id) VALUES (3)`, // all other columns NULL
];

// MariaDB-specific coverage: logical types riding on BINARY/VARBINARY
// codes, COMPRESSED columns, 5.3 "hires" temporals (the GLOBAL-only
// format switch is baked in at CREATE time and restored immediately),
// and log_bin_compress event envelopes.
const MARIADB_TABLE = 'capture_mariadb';
const MARIADB_HIRES_TABLE = 'capture_hires';

// Original values of the GLOBAL variables the capture flips, restored to
// exactly what the server had (never assumed defaults)
async function readMariaDbGlobals(conn) {
  const rows = await query(conn, `SELECT
    @@global.mysql56_temporal_format AS temporalFormat,
    @@global.log_bin_compress AS logBinCompress,
    @@global.log_bin_compress_min_len AS logBinCompressMinLen`);
  return rows[0];
}

function mariadbRestoreStatements(globals) {
  return [
    `SET GLOBAL mysql56_temporal_format = ${
      globals.temporalFormat ? 'ON' : 'OFF'}`,
    `SET GLOBAL log_bin_compress = ${
      globals.logBinCompress ? 'ON' : 'OFF'}`,
    `SET GLOBAL log_bin_compress_min_len = ${
      globals.logBinCompressMinLen}`,
  ];
}

function mariadbStatements(globals) {
  return [
    `CREATE TABLE ${MARIADB_TABLE} (
      id INT PRIMARY KEY,
      u UUID,
      i4 INET4,
      i6 INET6,
      v VECTOR(3),
      j JSON,
      vc_comp VARCHAR(300) COMPRESSED,
      txt_comp TEXT COMPRESSED CHARACTER SET latin1
    )`,
    `INSERT INTO ${MARIADB_TABLE} VALUES (
      1,
      '11111111-2222-3333-4444-555555555555',
      '192.168.1.10',
      '::ffff:8.8.8.8',
      VEC_FromText('[1.5,2.5,3.5]'),
      '{"a": 1}',
      REPEAT('squash-', 30),
      'caf\xE9 latin one'
    )`,
    `INSERT INTO ${MARIADB_TABLE} (id, i6) VALUES (2, '::')`,
    'SET GLOBAL mysql56_temporal_format = OFF',
    `CREATE TABLE ${MARIADB_HIRES_TABLE} (
      dt3 DATETIME(3),
      t3 TIME(3),
      ts3 TIMESTAMP(3) NULL
    )`,
    // The format is baked into the table at CREATE; the global can be
    // restored immediately
    `SET GLOBAL mysql56_temporal_format = ${
      globals.temporalFormat ? 'ON' : 'OFF'}`,
    `INSERT INTO ${MARIADB_HIRES_TABLE} VALUES
      ('2024-06-15 12:34:56.789', '-01:02:03.500', '2024-06-15 12:34:56.789')`,
    'SET GLOBAL log_bin_compress = ON',
    'SET GLOBAL log_bin_compress_min_len = 10',
    `INSERT INTO ${MARIADB_TABLE} (id, vc_comp)
      VALUES (3, REPEAT('flat-', 40))`,
    ...mariadbRestoreStatements(globals),
  ];
}

const closingStatements = [
  'FLUSH LOGS', // real Rotate event
  'SET @@session.time_zone = "SYSTEM"',
];

function query(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.query(sql, (err, result) => err ? reject(err) : resolve(result));
  });
}

async function main() {
  const admin = mysql.createConnection(connectionSettings);
  await query(admin, `DROP DATABASE IF EXISTS ${FIXTURE_DB}`);
  await query(admin, `CREATE DATABASE ${FIXTURE_DB}`);
  const versionRows = await query(admin, 'SELECT VERSION() AS version');
  const isMariaDb = versionRows[0].version.includes('MariaDB');

  let originalRowMetadata;
  if (FULL_METADATA) {
    const rows = await query(admin,
      'SELECT @@global.binlog_row_metadata AS setting');
    originalRowMetadata = rows[0].setting;
    await query(admin, 'SET GLOBAL binlog_row_metadata = FULL');
  }
  const restoreRowMetadata = async () => {
    if (FULL_METADATA && originalRowMetadata !== undefined) {
      await query(admin,
        `SET GLOBAL binlog_row_metadata = ${originalRowMetadata}`);
    }
  };

  const zongji = new ZongJi({ ...connectionSettings, database: FIXTURE_DB });
  const packets = [];
  const eventSummary = [];

  zongji.on('error', err => {
    console.error('zongji error:', err);
    process.exitCode = 1;
  });

  zongji.on('binlog', event => {
    eventSummary.push(event.getTypeName());
  });

  zongji.on('ready', async () => {
    // Capture every packet payload exactly as the Parser sees it
    const proto = zongji.BinlogClass.prototype;
    const originalBinlogData = proto.binlogData;
    proto.binlogData = function(packet, connection) {
      if (packet && packet.buffer && !packet.isEOF() && !packet.isError()) {
        packets.push(
          packet.buffer.subarray(packet.offset, packet.end).toString('hex'));
      }
      return originalBinlogData.call(this, packet, connection);
    };

    const work = mysql.createConnection(
      { ...connectionSettings, database: FIXTURE_DB });
    const mariadbGlobals = isMariaDb ?
      await readMariaDbGlobals(admin) : null;
    try {
      const statements = [
        ...captureStatements,
        ...(isMariaDb ? mariadbNullRowStatements : mysqlRowsQueryStatements),
        ...(isMariaDb ? mariadbStatements(mariadbGlobals) : []),
        ...closingStatements,
      ];
      for (const sql of statements) {
        await query(work, sql);
      }
    } finally {
      work.destroy();
      // A failure mid-sequence must not leave the flipped globals behind
      // (the restore statements are idempotent, so re-running them after
      // a complete sequence is harmless)
      if (isMariaDb) {
        for (const sql of mariadbRestoreStatements(mariadbGlobals)) {
          await query(admin, sql).catch(() => {});
        }
      }
    }

    // Give the binlog stream a moment to drain
    setTimeout(async () => {
      // Refuse to write a truncated capture (e.g. slow server still
      // delivering events when the drain timer fired)
      const minimumCounts = {
        TableMap: 4, WriteRows: 2, UpdateRows: 1, DeleteRows: 1,
        Xid: 1, Query: 1, Rotate: 2,
        ...(isMariaDb ? {
          MariadbGtid: 5, AnnotateRows: 3,
          MariadbGtidList: 1, BinlogCheckpoint: 1,
        } : { RowsQuery: 1 }),
      };
      const missing = Object.entries(minimumCounts).filter(([type, min]) =>
        eventSummary.filter(name => name === type).length < min);
      if (missing.length > 0) {
        console.error('Capture incomplete, refusing to write fixture. ' +
          'Missing:', missing.map(([type, min]) => `${type} (need ${min})`)
          .join(', '));
        console.error('Received:', eventSummary.join(', '));
        zongji.stop();
        await restoreRowMetadata();
        admin.destroy();
        process.exit(1);
      }

      // In FULL metadata mode the TableMap events are self-describing;
      // omitting the INFORMATION_SCHEMA snapshot lets tests prove that
      const tableSchemas = {};
      if (!FULL_METADATA) {
        for (const entry of Object.values(zongji.tableMap)) {
          tableSchemas[entry.tableName] = entry.columnSchemas;
        }
      }

      const fixture = {
        description:
          'Raw binlog packet payloads captured by scripts/capture-fixtures.js',
        serverVersion: versionRows[0].version,
        binlogRowMetadata: FULL_METADATA ? 'FULL' : 'MINIMAL',
        useChecksum: zongji.useChecksum,
        connectionConfig: {
          timezone: connectionSettings.timezone,
          dateStrings: connectionSettings.dateStrings,
        },
        schemaName: FIXTURE_DB,
        tableSchemas,
        eventSummary,
        packets,
      };

      const dir = path.dirname(fileURLToPath(import.meta.url));
      const outFile = path.join(
        dir, '..', 'test', 'fixtures', `binlog-${SUFFIX}.json`);
      fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2) + '\n');
      console.log(`Wrote ${packets.length} packets (${eventSummary.join(', ')})`);
      console.log(`-> ${outFile}`);

      zongji.stop();
      await query(admin, `DROP DATABASE IF EXISTS ${FIXTURE_DB}`);
      await restoreRowMetadata();
      admin.destroy();
    }, 2000);
  });

  // requestAnnotateRows only has an effect on MariaDB (dump flag 0x02)
  zongji.start({ startAtEnd: true, serverId: 999, requestAnnotateRows: true });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
