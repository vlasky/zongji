// Offline parser tests: replays raw binlog packets captured by
// scripts/capture-fixtures.js through the full parsing pipeline without a
// database connection. Values asserted here correspond to the statements
// in scripts/capture-fixtures.js.
import fs from 'fs';
import tap from 'tap';

import ZongJi from '../index.js';
import initBinlogPacketClass from '../lib/packet/binlog.js';
import initBinlogClass from '../lib/sequence/binlog.js';
import { Parser } from '../lib/reader.js';
import * as eventsModule from '../lib/binlog_event.js';

const FIXTURE = JSON.parse(fs.readFileSync(
  new URL('./fixtures/binlog-mysql84.json', import.meta.url), 'utf8'));
// Same statements captured with binlog_row_metadata=FULL; carries no
// tableSchemas, so decoding proves the events are self-describing
const FIXTURE_FULLMETA = JSON.parse(fs.readFileSync(
  new URL('./fixtures/binlog-mysql84-fullmeta.json', import.meta.url),
  'utf8'));

// Replays every packet in a fixture and returns the decoded events,
// mimicking the TableMap metadata handling of ZongJi's binlogHandler.
// configOverrides simulates different mysql2 connection options; the
// captured bytes are independent of them.
function decodeFixture(fixture, configOverrides = {}) {
  const zongji = new ZongJi({});
  zongji.useChecksum = fixture.useChecksum;
  zongji.connection = {
    config: { ...fixture.connectionConfig, ...configOverrides },
  };
  const BinlogPacket = initBinlogPacketClass(zongji);

  return fixture.packets.map(hex => {
    const buffer = Buffer.from(hex, 'hex');
    const packet = { buffer, offset: 0, end: buffer.length };
    const parser = new Parser(packet);
    const binlogPacket = new BinlogPacket();
    binlogPacket.parse(parser);
    const event = binlogPacket.getEvent();

    if (event.getTypeName() === 'TableMap') {
      // What ZongJi#binlogHandler does: self-describing events build their
      // own schemas, others get the INFORMATION_SCHEMA snapshot
      zongji.tableMap[event.tableId] = {
        columnSchemas: event.hasSelfDescribingMetadata() ?
          event.buildColumnSchemas() :
          fixture.tableSchemas[event.tableName],
        parentSchema: event.schemaName,
        tableName: event.tableName,
      };
      event.updateColumnInfo();
    }
    return event;
  });
}

// Row-value assertions shared by both metadata sources. e2 (an ENUM whose
// values contain a comma and a quote) is only asserted for the FULL
// metadata path: the INFORMATION_SCHEMA path parses the value list out of
// the COLUMN_TYPE string and cannot handle those characters.
function assertCanonicalRows(test, events, { exactEnumValues } = {}) {
  const writes = events.filter(e => e.getTypeName() === 'WriteRows');
  const updates = events.filter(e => e.getTypeName() === 'UpdateRows');
  const deletes = events.filter(e => e.getTypeName() === 'DeleteRows');

  test.equal(writes.length, 2);
  test.equal(updates.length, 1);
  test.equal(deletes.length, 1);

  const row = writes[0].rows[0];
  test.equal(row.id, 1);
  test.strictSame(row.i_big, '9223372036854775807', 'exact BIGINT string');
  test.strictSame(row.u_big, '18446744073709551615', 'exact UNSIGNED string');
  test.strictSame(row.dec_col, '-12345678901234567.0123456789',
    'exact DECIMAL string');
  test.equal(row.vc, 'héllo wörld');
  test.equal(row.ch, 'abc');
  test.strictSame(row.bin_col, Buffer.from('deadbeef', 'hex'));
  test.strictSame(row.vb, Buffer.from('0102', 'hex'));
  test.equal(row.txt, 'text value');
  test.strictSame(row.blb, Buffer.from('cafe', 'hex'));
  test.equal(row.flt, 1.25);
  test.equal(row.dbl, -2.5);
  test.ok(row.dt instanceof Date);
  test.equal(row.dt.toISOString(), '2024-06-15T12:34:56.789Z',
    'DATETIME(3) with timezone Z');
  test.equal(row.ts, '2024-06-15 12:34:56',
    'TIMESTAMP as string via dateStrings');
  test.ok(row.d instanceof Date);
  test.equal(row.d.toISOString(), '2024-06-15T00:00:00.000Z');
  test.equal(row.t, '-01:02:03.500');
  test.equal(row.y, 2024);
  test.equal(row.e, 'b');
  if (exactEnumValues) {
    test.equal(row.e2, "c'd",
      'ENUM values containing commas and quotes decode exactly');
  }
  test.equal(row.s, 'x,z');
  test.strictSame(row.bt, Buffer.from([0x02, 0x01]), 'BIT(10) b1000000001');
  test.strictSame(row.js, {
    a: 1,
    big: '9223372036854775807',
    arr: ['x', true, null],
    d: 1.5,
  }, 'JSON as parsed object, 64-bit integer exact');
  test.strictSame(row.geo, { x: 1, y: 2 });
  test.equal(row.txt_latin1, 'café ñ', 'latin1 TEXT decoded via its charset');
  test.equal(row.vc_latin1, 'Ÿ€ señor',
    'latin1 VARCHAR decoded as cp1252 (Ÿ and € live in 0x80-0x9F)');
  test.equal(row.vc_ucs2, 'héllo', 'ucs2 VARCHAR decoded big-endian');

  const change = updates[0].rows[0];
  test.equal(change.before.id, 1);
  test.equal(change.before.vc, 'héllo wörld');
  test.equal(change.after.id, 2);
  test.equal(change.after.vc, 'updated');

  test.equal(deletes[0].rows[0].id, 2);

  const nullRow = writes[1].rows[0];
  test.equal(nullRow.id, 3);
  for (const key of Object.keys(nullRow)) {
    if (key !== 'id') {
      test.equal(nullRow[key], null, `${key} is null`);
    }
  }
}

tap.test('event stream structure matches capture', test => {
  const events = decodeFixture(FIXTURE);
  test.strictSame(
    events.map(e => e.getTypeName()),
    FIXTURE.eventSummary,
    'decoded event types match the sequence observed at capture time');
  test.end();
});

tap.test('row values decode exactly (default mysql2 semantics)', test => {
  const events = decodeFixture(FIXTURE);
  assertCanonicalRows(test, events);
  test.end();
});

tap.test('binlog_row_metadata=FULL: events are self-describing', test => {
  test.strictSame(FIXTURE_FULLMETA.tableSchemas, {},
    'fixture carries no INFORMATION_SCHEMA data at all');

  const events = decodeFixture(FIXTURE_FULLMETA);
  test.strictSame(
    events.map(e => e.getTypeName()),
    FIXTURE_FULLMETA.eventSummary,
    'decoded event types match the sequence observed at capture time');

  const tableMaps = events.filter(e => e.getTypeName() === 'TableMap');
  test.ok(tableMaps.length > 0);
  tableMaps.forEach(tm => {
    test.ok(tm.hasSelfDescribingMetadata(), 'TableMap self-describing');
  });

  // Row values decode identically to the INFORMATION_SCHEMA path,
  // including the enum whose values defeat COLUMN_TYPE string parsing
  assertCanonicalRows(test, events, { exactEnumValues: true });
  test.end();
});

tap.test('binlog_row_metadata=FULL: synthesised column schemas', test => {
  const events = decodeFixture(FIXTURE_FULLMETA);
  const tm = events.find(e => e.getTypeName() === 'TableMap');
  const schemas = tm.buildColumnSchemas();
  const byName = Object.fromEntries(schemas.map(s => [s.COLUMN_NAME, s]));

  test.strictSame(tm.columnNames.slice(0, 4),
    ['id', 'i_big', 'u_big', 'dec_col']);
  test.equal(byName.id.COLUMN_TYPE, 'int');
  test.equal(byName.id.UNSIGNED, false);
  test.equal(byName.i_big.COLUMN_TYPE, 'bigint');
  test.equal(byName.u_big.COLUMN_TYPE, 'bigint unsigned');
  test.equal(byName.u_big.UNSIGNED, true);
  test.equal(byName.dec_col.COLUMN_TYPE, 'decimal(30,10)');
  test.equal(byName.vc.COLUMN_TYPE, 'varchar(20)',
    'character width recovered from byte width and charset');
  test.equal(byName.vc.CHARACTER_SET_NAME, 'utf8mb4');
  test.equal(byName.ch.COLUMN_TYPE, 'char(5)');
  test.equal(byName.bin_col.COLUMN_TYPE, 'binary(4)');
  test.equal(byName.bin_col.CHARACTER_SET_NAME, null);
  test.equal(byName.vb.COLUMN_TYPE, 'varbinary(8)');
  test.equal(byName.txt.COLUMN_TYPE, 'text');
  test.equal(byName.txt.CHARACTER_SET_NAME, 'utf8mb4');
  test.equal(byName.txt_latin1.CHARACTER_SET_NAME, 'latin1',
    'per-column charset from binlog metadata');
  test.equal(byName.vc_latin1.COLUMN_TYPE, 'varchar(20)');
  test.equal(byName.vc_latin1.CHARACTER_SET_NAME, 'latin1');
  test.equal(byName.vc_ucs2.COLUMN_TYPE, 'varchar(10)',
    'character width recovered through the two-byte-per-char charset');
  test.equal(byName.vc_ucs2.CHARACTER_SET_NAME, 'ucs2');
  test.equal(byName.blb.COLUMN_TYPE, 'blob');
  test.equal(byName.blb.CHARACTER_SET_NAME, null);
  test.strictSame(byName.e.ENUM_VALUES, ['a', 'b', 'c']);
  test.strictSame(byName.e2.ENUM_VALUES, ['a,b', "c'd", 'plain'],
    'enum values with commas and quotes survive');
  test.equal(byName.e2.COLUMN_TYPE, "enum('a,b','c''d','plain')");
  test.strictSame(byName.s.SET_VALUES, ['x', 'y', 'z']);
  test.equal(byName.bt.COLUMN_TYPE, 'bit(10)');
  test.equal(byName.dt.COLUMN_TYPE, 'datetime(3)');
  test.equal(byName.ts.COLUMN_TYPE, 'timestamp');
  test.equal(byName.js.COLUMN_TYPE, 'json');
  test.equal(byName.geo.COLUMN_TYPE, 'geometry');

  test.strictSame(tm.primaryKey, [0], 'primary key column indexes');
  test.ok(tm.columnVisibility.every(Boolean), 'all columns visible');
  test.equal(tm.signedness[2], true, 'u_big signedness bit');
  test.equal(tm.signedness[4], undefined,
    'non-numeric columns carry no signedness');
  test.end();
});

tap.test('malformed optional metadata falls back to fetched schemas', test => {
  const zongji = new ZongJi({});
  zongji.useChecksum = FIXTURE_FULLMETA.useChecksum;
  zongji.connection = { config: { ...FIXTURE_FULLMETA.connectionConfig } };
  const BinlogPacket = initBinlogPacketClass(zongji);

  const tableMapIndex = FIXTURE_FULLMETA.eventSummary.indexOf('TableMap');
  const buffer = Buffer.from(FIXTURE_FULLMETA.packets[tableMapIndex], 'hex');

  // Locate the SIGNEDNESS field (type byte 0x01, length 0x01 for this
  // table) near the end of the event, then corrupt its length two ways:
  // far beyond the event (out of bounds) and by one byte (in bounds, but
  // known field types must consume their declared length exactly)
  let signednessOffset = null;
  for (let i = buffer.length - 1; i > 0; i--) {
    if (buffer[i] === 0x01 && buffer[i + 1] === 0x01) {
      signednessOffset = i;
      break;
    }
  }
  test.ok(signednessOffset, 'found the SIGNEDNESS field to corrupt');

  for (const badLength of [0xf0, 0x02]) {
    const corrupted = Buffer.from(buffer);
    corrupted[signednessOffset + 1] = badLength;

    const parser = new Parser(
      { buffer: corrupted, offset: 0, end: corrupted.length });
    const binlogPacket = new BinlogPacket();
    binlogPacket.parse(parser);
    const event = binlogPacket.getEvent();

    test.equal(event.getTypeName(), 'TableMap',
      'event still parses (metadata is optional)');
    test.equal(event.hasSelfDescribingMetadata(), false,
      `corrupt metadata (length 0x${badLength.toString(16)}) is discarded`);
    test.equal(event.signedness, undefined);
    test.equal(event.primaryKey, undefined);
  }
  test.end();
});

tap.test('binlog_row_metadata=MINIMAL fixture still uses fetched schemas',
  test => {
    const events = decodeFixture(FIXTURE);
    const tm = events.find(e => e.getTypeName() === 'TableMap');
    test.equal(tm.hasSelfDescribingMetadata(), false,
      'MINIMAL metadata has no column names');
    test.ok(tm.signedness, 'signedness still parsed under MINIMAL');
    test.equal(tm.signedness[2], true, 'u_big unsigned from binlog');
    test.end();
  });

tap.test('decimalNumbers and jsonStrings connection options', test => {
  // Options behave identically with either metadata source
  for (const fixture of [FIXTURE, FIXTURE_FULLMETA]) {
    const events = decodeFixture(fixture, {
      decimalNumbers: true,
      jsonStrings: true,
    });
    const row = events.find(e => e.getTypeName() === 'WriteRows').rows[0];

    test.type(row.dec_col, 'number', 'DECIMAL as Number with decimalNumbers');
    test.equal(row.dec_col, parseFloat('-12345678901234567.0123456789'));

    test.type(row.js, 'string', 'JSON as string with jsonStrings');
    test.match(row.js, /"big": 9223372036854775807\s*[,}]/,
      '64-bit integer serialised as a raw JSON numeral, not a quoted string');
    const parsed = JSON.parse(row.js);
    test.equal(parsed.a, 1);
    test.strictSame(parsed.arr, ['x', true, null]);
    test.equal(parsed.d, 1.5);
  }
  test.end();
});

tap.test('non-row events decode', test => {
  const events = decodeFixture(FIXTURE);

  const queries = events.filter(e => e.getTypeName() === 'Query');
  test.ok(queries.some(q => /CREATE TABLE/i.test(q.query)),
    'CREATE TABLE query event');
  test.ok(queries.every(q => q.schema === FIXTURE.schemaName));

  const xids = events.filter(e => e.getTypeName() === 'Xid');
  test.ok(xids.length >= 1);
  xids.forEach(x => test.type(x.xid, 'number'));

  const gtids = events.filter(e => e.getTypeName() === 'Gtid');
  gtids.forEach(g => {
    test.match(g.gtid, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/);
  });

  const rotates = events.filter(e => e.getTypeName() === 'Rotate');
  test.ok(rotates.length >= 2, 'fake rotate at start plus FLUSH LOGS');
  rotates.forEach(r => test.match(r.binlogName, /\.\d+$/));

  const previous = events.filter(e => e.getTypeName() === 'PreviousGtids');
  previous.forEach(p => test.type(p.gtidSet, 'string'));

  test.end();
});

tap.test('corrupt gtid packet surfaces an error even when filtered', test => {
  const zongji = new ZongJi({});
  zongji.useChecksum = FIXTURE.useChecksum;
  zongji.connection = { config: { ...FIXTURE.connectionConfig } };
  // 'gtid' is NOT included: the parse error must still be delivered,
  // because transaction attribution for all following events depends on it
  zongji._filters({ includeEvents: ['tablemap', 'writerows'] });

  const gtidIndex = FIXTURE.eventSummary.indexOf('Gtid');
  const full = Buffer.from(FIXTURE.packets[gtidIndex], 'hex');
  // Header parses (marker + 19 bytes) but the 25-byte GTID body does not
  const truncated = full.subarray(0, 25);

  const deliveries = [];
  const BinlogClass = initBinlogClass(zongji);
  const command = new BinlogClass(function(error, event) {
    deliveries.push({ error, event });
  });
  command.binlogData({
    buffer: truncated,
    offset: 0,
    end: truncated.length,
    isEOF: () => false,
    isError: () => false,
  });

  test.equal(deliveries.length, 1, 'callback invoked despite the filter');
  test.type(deliveries[0].error, Error);
  test.equal(zongji._currentGtid, undefined,
    'no stale GTID left behind for following events');
  test.end();
});

tap.test('truncated packet surfaces a parse error via getEvent', test => {
  const zongji = new ZongJi({});
  zongji.useChecksum = FIXTURE.useChecksum;
  zongji.connection = { config: { ...FIXTURE.connectionConfig } };
  const BinlogPacket = initBinlogPacketClass(zongji);

  // Replay up to and including the first TableMap so the rows event has
  // metadata, then truncate the WriteRows packet body
  const writeIndex = FIXTURE.eventSummary.indexOf('WriteRows');
  for (let i = 0; i < writeIndex; i++) {
    const buffer = Buffer.from(FIXTURE.packets[i], 'hex');
    const parser = new Parser({ buffer, offset: 0, end: buffer.length });
    const binlogPacket = new BinlogPacket();
    binlogPacket.parse(parser);
    const event = binlogPacket.getEvent();
    if (event.getTypeName() === 'TableMap') {
      zongji.tableMap[event.tableId] = {
        columnSchemas: FIXTURE.tableSchemas[event.tableName],
        parentSchema: event.schemaName,
        tableName: event.tableName,
      };
      event.updateColumnInfo();
    }
  }

  const full = Buffer.from(FIXTURE.packets[writeIndex], 'hex');
  const truncated = full.subarray(0, 40);
  const parser = new Parser(
    { buffer: truncated, offset: 0, end: truncated.length });
  const binlogPacket = new BinlogPacket();
  binlogPacket.parse(parser);
  test.throws(() => binlogPacket.getEvent(),
    'corrupt packet throws instead of returning garbage');
  test.end();
});

// MariaDB event parsers must bound every fixed or length-prefixed read by
// the checksum-excluded end: the parser's own bounds include the trailing
// CRC32, so a truncated body could otherwise silently absorb checksum
// bytes as field data.
tap.test('truncated MariaDB events throw instead of consuming the CRC',
  test => {
    const { MariadbGtid, MariadbGtidList, BinlogCheckpoint } = eventsModule;
    const zongji = { useChecksum: true };
    const makeParser = (body) => {
      const parser = new Parser();
      parser.append(Buffer.concat([body, Buffer.from([0xde, 0xad, 0xbe, 0xef])]));
      return parser;
    };
    const options = { timestamp: 0, nextPosition: 100, size: 0, serverId: 1 };

    // FL_PREPARED_XA claims 6+ more bytes; only 2 remain before the CRC
    test.throws(() => new MariadbGtid(makeParser(Buffer.concat([
      Buffer.alloc(8, 0x01),          // seq_no
      Buffer.from([0, 0, 0, 0]),      // domain_id
      Buffer.from([0x40]),            // flags2 = FL_PREPARED_XA
      Buffer.from([0x11, 0x22]),
    ])), options, zongji), /Truncated MariadbGtid/);

    // Count claims one 16-byte entry; only 12 bytes remain before the CRC
    test.throws(() => new MariadbGtidList(makeParser(Buffer.concat([
      Buffer.from([0x01, 0, 0, 0]),   // count = 1
      Buffer.alloc(12, 0x02),
    ])), options, zongji), /Truncated MariadbGtidList/);

    // Name length runs past the data area into the CRC
    test.throws(() => new BinlogCheckpoint(makeParser(Buffer.concat([
      Buffer.from([0x10, 0, 0, 0]),   // length 16
      Buffer.from('mysql-bin.01'),    // only 12 bytes
    ])), options, zongji), /Truncated BinlogCheckpoint/);

    // A well-formed minimal GTID event still parses (13 bytes + pad)
    const good = new MariadbGtid(makeParser(Buffer.concat([
      Buffer.alloc(8, 0x00), Buffer.from([5, 0, 0, 0]), Buffer.from([0x01]),
      Buffer.alloc(6, 0x00),          // zero padding to 19
    ])), options, zongji);
    test.equal(good.domainId, 5);
    test.equal(good.standalone, true);
    test.equal(good.gtid, '5-1-0');
    test.end();
  });

// MariaDB 11.8 capture: native GTID events, annotate events, logical
// types riding on binary codes, COMPRESSED columns, a compressed row
// EVENT (log_bin_compress) and 5.3 hires temporals - all decoded offline
// from the pinned bytes, on any test lane.
const FIXTURE_MARIADB = JSON.parse(fs.readFileSync(
  new URL('./fixtures/binlog-mariadb118.json', import.meta.url), 'utf8'));

tap.test('MariaDB fixture decodes offline', test => {
  const events = decodeFixture(FIXTURE_MARIADB);
  test.strictSame(
    events.map(e => e.getTypeName()),
    FIXTURE_MARIADB.eventSummary,
    'decoded event types match the sequence observed at capture time');

  const gtids = events.filter(e => e.getTypeName() === 'MariadbGtid');
  test.ok(gtids.length >= 5, 'native GTID events present');
  for (const gtid of gtids) {
    test.match(gtid.gtid, /^\d+-\d+-\d+$/);
  }
  test.equal(gtids[0].standalone, true, 'DDL group GTID is standalone');
  test.equal(gtids[0].isDdl, true);
  test.equal(gtids[1].standalone, false, 'transaction GTID replaces BEGIN');
  for (let i = 1; i < gtids.length; i++) {
    test.ok(BigInt(String(gtids[i].seqNo)) >
      BigInt(String(gtids[i - 1].seqNo)), `seqNo advances (${i})`);
  }

  const list = events.find(e => e.getTypeName() === 'MariadbGtidList');
  test.ok(list.count >= 1, 'GTID list at the rotated file start');
  test.equal(list.count, list.gtids.length);
  test.match(list.gtids[list.gtids.length - 1].gtid, /^\d+-\d+-\d+$/);

  const checkpoint =
    events.find(e => e.getTypeName() === 'BinlogCheckpoint');
  test.match(checkpoint.binlogName, /^mysql-bin\.\d+$/);

  const notes = events.filter(e => e.getTypeName() === 'AnnotateRows');
  test.ok(notes.some(n => n.statement.includes(
    'INSERT INTO capture_mariadb')),
    'annotate events carry the originating SQL');

  const writes = events.filter(e => e.getTypeName() === 'WriteRows' &&
    e.tableMap[e.tableId].tableName === 'capture_mariadb');
  test.equal(writes.length, 3);
  const row = writes[0].rows[0];
  test.equal(row.u, '11111111-2222-3333-4444-555555555555', 'UUID');
  test.equal(row.i4, '192.168.1.10', 'INET4');
  test.equal(row.i6, '::ffff:8.8.8.8', 'INET6 v4-mapped');
  test.strictSame(row.v, Buffer.from('0000c03f0000204000006040', 'hex'),
    'VECTOR as raw little-endian float32 buffer');
  test.equal(row.j, '{"a": 1}', 'MariaDB JSON is LONGTEXT text');
  test.equal(row.vc_comp, 'squash-'.repeat(30),
    'zlib COMPRESSED column value');
  test.equal(row.txt_comp, 'café latin one', 'latin1 COMPRESSED text');
  test.equal(writes[1].rows[0].i6, '::',
    'all-zero INET6 re-padded from a stripped row image');
  test.equal(writes[2].rows[0].vc_comp, 'flat-'.repeat(40),
    'row decoded from a compressed row event (log_bin_compress)');

  const hires = events.find(e => e.getTypeName() === 'WriteRows' &&
    e.tableMap[e.tableId].tableName === 'capture_hires').rows[0];
  test.ok(hires.dt3 instanceof Date);
  test.equal(hires.dt3.toISOString(), '2024-06-15T12:34:56.789Z',
    'hires DATETIME(3)');
  test.equal(hires.t3, '-01:02:03.500', 'negative hires TIME(3)');
  test.equal(hires.ts3, '2024-06-15 12:34:56.789',
    'hires TIMESTAMP(3) as string via dateStrings');
  test.end();
});
