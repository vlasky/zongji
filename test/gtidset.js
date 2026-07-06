// Offline unit tests for the GTID set model (lib/gtid_set.js)
import tap from 'tap';

import { GtidSet } from '../lib/gtid_set.js';
import {
  GtidSet as ExportedGtidSet,
  MariadbGtidPosition as ExportedMariadbGtidPosition,
} from '../index.js';
import { MariadbGtidPosition } from '../lib/mariadb_gtid.js';
import { PreviousGtids } from '../lib/binlog_event.js';
import { Parser } from '../lib/reader.js';

const UUID_A = '3e11fa47-71ca-11e1-9e33-c80aa9429562';
const UUID_B = '2c256447-3f0d-431b-9a25-bddf1f1f6ef6';

tap.test('parse and toString round-trip', test => {
  const cases = [
    '',
    `${UUID_A}:1-5`,
    `${UUID_A}:1-5:11-18`,
    `${UUID_B}:1-27,${UUID_A}:1-5:8`,
  ];
  for (const text of cases) {
    const canonical = GtidSet.parse(text).toString();
    test.equal(GtidSet.parse(canonical).toString(), canonical,
      `'${text}' round-trips`);
  }
  test.equal(GtidSet.parse('').isEmpty(), true);
  test.equal(GtidSet.parse(`${UUID_A}:7`).toString(), `${UUID_A}:7`,
    'single transaction has no range dash');
  test.equal(
    GtidSet.parse(` ${UUID_A.toUpperCase()} : 1-3 `.replace(/ /g, ''))
      .toString(),
    `${UUID_A}:1-3`, 'uuids normalise to lowercase');
  test.end();
});

tap.test('add coalesces intervals', test => {
  const set = GtidSet.parse(`${UUID_A}:1-5`);
  set.add(`${UUID_A}:6`);
  test.equal(set.toString(), `${UUID_A}:1-6`, 'adjacent gno extends');
  set.add(`${UUID_A}:9`);
  test.equal(set.toString(), `${UUID_A}:1-6:9`, 'gap starts a new interval');
  set.add(`${UUID_A}:8`);
  test.equal(set.toString(), `${UUID_A}:1-6:8-9`);
  set.add(`${UUID_A}:7`);
  test.equal(set.toString(), `${UUID_A}:1-9`, 'bridging gno merges intervals');
  set.add(`${UUID_A}:3`);
  test.equal(set.toString(), `${UUID_A}:1-9`, 'duplicate is a no-op');
  set.add(`${UUID_B}:1`);
  test.equal(set.toString(), `${UUID_B}:1,${UUID_A}:1-9`,
    'sids sort lexicographically');
  test.end();
});

tap.test('invalid input rejected', test => {
  test.throws(() => GtidSet.parse('not-a-uuid:1-5'));
  test.throws(() => GtidSet.parse(UUID_A), 'missing intervals');
  test.throws(() => GtidSet.parse(`${UUID_A}:5-1`), 'descending interval');
  test.throws(() => GtidSet.parse(`${UUID_A}:0`), 'gno must be >= 1');
  test.throws(() => GtidSet.parse(`${UUID_A}:1-2-3`));
  test.throws(() => new GtidSet().add('no-colon'));
  // Decimal digits only, per the MySQL GTID grammar
  test.throws(() => GtidSet.parse(`${UUID_A}:1e3`), 'exponent notation');
  test.throws(() => GtidSet.parse(`${UUID_A}:0x10`), 'hex notation');
  test.throws(() => GtidSet.parse(`${UUID_A}:1.0`), 'decimal point');
  test.throws(() => GtidSet.parse(`${UUID_A}:9223372036854775808`),
    'beyond the GNO maximum of 2^63-1');
  test.end();
});

tap.test('GNOs beyond 2^53 stay exact', test => {
  // Round-trips either side of the Number safe-integer boundary and at
  // the GNO maximum
  for (const gno of ['9007199254740991', '9007199254740992',
    '9007199254740993', '9223372036854775807']) {
    test.equal(GtidSet.parse(`${UUID_A}:${gno}`).toString(),
      `${UUID_A}:${gno}`, `${gno} round-trips`);
  }

  const set = GtidSet.parse(`${UUID_A}:1-9007199254740991`);
  set.add(`${UUID_A}:9007199254740992`);
  test.equal(set.toString(), `${UUID_A}:1-9007199254740992`,
    'adjacency coalesces across the 2^53 boundary');
  set.add(`${UUID_A}:9007199254740994`);
  test.equal(set.toString(),
    `${UUID_A}:1-9007199254740992:9007199254740994`,
    'a gap of one above 2^53 stays a separate interval (no rounding)');
  test.equal(set.contains(`${UUID_A}:9007199254740992`), true);
  test.equal(set.contains(`${UUID_A}:9007199254740993`), false,
    'the gap gno is not contained');
  test.equal(set.contains(`${UUID_A}:9007199254740994`), true);

  const max = GtidSet.parse(
    `${UUID_A}:9223372036854775806-9223372036854775807`);
  test.equal(max.contains(`${UUID_A}:9223372036854775807`), true,
    'contains at 2^63-1');
  test.equal(max.contains(`${UUID_A}:9223372036854775805`), false);
  max.add(`${UUID_A}:9223372036854775805`);
  test.equal(max.toString(),
    `${UUID_A}:9223372036854775805-9223372036854775807`,
    'add coalesces at the top of the range');

  // The wire decoder must stay exact too: interval bounds are u64 and
  // the resulting text seeds the executed-set tracker
  const text = `${UUID_A}:1-5:9007199254740993-9223372036854775807`;
  const encoded = GtidSet.parse(text).encode();
  const parser = new Parser({
    buffer: encoded, offset: 0, end: encoded.length,
  });
  const event = new PreviousGtids(parser,
    { timestamp: 0, nextPosition: 0, size: encoded.length },
    { useChecksum: false });
  test.equal(event.gtidSet, text,
    'PreviousGtids decodes bounds beyond 2^53 exactly');
  test.same(event.sids[0].intervals,
    [{ start: 1, end: 6 },
      { start: '9007199254740993', end: '9223372036854775808' }],
    'sids follow the Number-or-exact-string convention (end exclusive)');
  test.doesNotThrow(() => JSON.stringify(event.sids),
    'sids stay JSON-serialisable');
  test.end();
});

tap.test('encode matches the Previous_gtids wire format', test => {
  // PreviousGtids (lib/binlog_event.js) decodes this same encoding from
  // real server packets, so decoding our own bytes with it proves the
  // formats agree
  const text = `${UUID_B}:1-27,${UUID_A}:1-5:8`;
  const encoded = GtidSet.parse(text).encode();

  // Simulate the event body: 19-byte header already consumed by the time
  // PreviousGtids reads the sid block, so hand the parser the block alone
  const parser = new Parser({
    buffer: encoded, offset: 0, end: encoded.length,
  });
  const event = new PreviousGtids(parser,
    { timestamp: 0, nextPosition: 0, size: encoded.length },
    { useChecksum: false });

  test.equal(event.gtidSet, text, 'PreviousGtids decodes our encoding');
  test.end();
});

tap.test('encode layout details', test => {
  const encoded = GtidSet.parse(`${UUID_A}:1-5`).encode();
  test.equal(encoded.length, 8 + 16 + 8 + 16);
  test.equal(encoded.readBigUInt64LE(0), 1n, 'n_sids');
  test.equal(encoded.subarray(8, 24).toString('hex'),
    UUID_A.replace(/-/g, ''), 'binary uuid');
  test.equal(encoded.readBigUInt64LE(24), 1n, 'n_intervals');
  test.equal(encoded.readBigUInt64LE(32), 1n, 'interval start');
  test.equal(encoded.readBigUInt64LE(40), 6n, 'interval end is exclusive');
  test.equal(GtidSet.parse('').encode().length, 8,
    'empty set encodes as zero sids');
  test.end();
});

tap.test('contains tests single-transaction membership', test => {
  test.equal(ExportedGtidSet, GtidSet,
    'GtidSet is a named export of the package entry');

  const set = GtidSet.parse(`${UUID_A}:1-5:11:tag_a:3-4,${UUID_B}:7`);
  test.equal(set.contains(`${UUID_A}:3`), true);
  test.equal(set.contains(`${UUID_A}:5`), true, 'interval end inclusive');
  test.equal(set.contains(`${UUID_A}:11`), true, 'single-gno interval');
  test.equal(set.contains(`${UUID_A}:6`), false, 'gap between intervals');
  test.equal(set.contains(`${UUID_B}:7`), true);
  test.equal(set.contains(`${UUID_B}:8`), false);
  test.equal(set.contains(`${UUID_A}:tag_a:3`), true, 'tagged member');
  test.equal(set.contains(`${UUID_A}:TAG_A:4`), true, 'tag case-folds');
  test.equal(set.contains(`${UUID_A}:tag_a:5`), false,
    'tagged intervals are their own source');
  test.equal(set.contains(`${UUID_A}:tag_b:3`), false, 'unknown tag');
  test.equal(set.contains('11111111-2222-3333-4444-555555555555:1'),
    false, 'unknown uuid');
  test.equal(set.contains(undefined), false,
    'anonymous transactions (event.gtid undefined) are never contained');
  test.equal(set.contains(null), false);
  test.throws(() => set.contains('garbage'), 'malformed input throws');
  test.throws(() => set.contains(`${UUID_A}:not a tag!:1`));
  test.end();
});

tap.test('tagged GTIDs (MySQL 8.3+)', test => {
  test.test('parse/toString round-trip, ordering and folding', test => {
    const tagged = `${UUID_A}:1-5:tag_a:1:tag_b:1`;
    test.equal(GtidSet.parse(tagged).toString(), tagged, 'round-trips');
    test.equal(GtidSet.parse(`${UUID_A}:tag_b:1:tag_a:1-2`).toString(),
      `${UUID_A}:tag_a:1-2:tag_b:1`,
      'tags sort within the uuid block; untagged-only block needs none');
    test.equal(GtidSet.parse(`${UUID_A}:tag_a:3:1-2`).toString(),
      `${UUID_A}:tag_a:1-3`,
      'a tag governs all following intervals until the next tag');
    test.equal(GtidSet.parse(`${UUID_A}:TAG_A:1`).toString(),
      `${UUID_A}:tag_a:1`, 'tags fold to lowercase');
    test.end();
  });

  test.test('add accepts uuid:tag:gno', test => {
    const set = GtidSet.parse(`${UUID_A}:1-5`);
    set.add(`${UUID_A}:tag_a:1`);
    set.add(`${UUID_A}:tag_a:2`);
    test.equal(set.toString(), `${UUID_A}:1-5:tag_a:1-2`,
      'tagged intervals coalesce per (uuid, tag)');
    set.add(`${UUID_A}:6`);
    test.equal(set.toString(), `${UUID_A}:1-6:tag_a:1-2`,
      'tagged and untagged sources stay separate');
    test.throws(() => set.add(`${UUID_A}:not a tag!:1`), 'invalid tag');
    test.throws(() => set.add(`${UUID_A}:tag:extra:1`), 'too many parts');
    test.throws(() => GtidSet.parse(`${UUID_A}:tag_a`),
      'tag without intervals');
    test.throws(() => GtidSet.parse(`${UUID_A}:1:tag_a`),
      'trailing tag without intervals');
    test.throws(() => GtidSet.parse(`${UUID_A}:tag_a:tag_b:1`),
      'consecutive tags');
    test.end();
  });

  test.test('wire encoding matches a server-written tagged set', test => {
    // PREVIOUS_GTIDS body written by MySQL 8.4.8 itself (captured from
    // a live binlog) for this exact set: the reference for
    // Gtid_set::encode's tagged format
    const uuid = 'fb5b7041-7754-11f1-a067-e69d25af13b4';
    const serverBytes =
      '0103000000000001' +                        // (1<<56)|(3<<8)|1
      'fb5b7041775411f1a067e69d25af13b4' + '00' + // untagged entry
      '010000000000000001000000000000000600000000000000' +
      'fb5b7041775411f1a067e69d25af13b4' + '0a7461675f61' + // 'tag_a'
      '010000000000000001000000000000000200000000000000' +
      'fb5b7041775411f1a067e69d25af13b4' + '0a7461675f62' + // 'tag_b'
      '010000000000000001000000000000000200000000000000';
    const set = GtidSet.parse(`${uuid}:1-5:tag_a:1:tag_b:1`);
    test.equal(set.encode().toString('hex'), serverBytes,
      'byte-identical to the server encoding');

    // Untagged sets must stay in the classic format every server accepts
    const classic = GtidSet.parse(`${uuid}:1-5`).encode();
    test.equal(classic.readBigUInt64LE(0), 1n,
      'untagged first u64 is a plain sid count (format byte 0)');
    test.end();
  });

  test.test('tagged encoding round-trips through PreviousGtids', test => {
    const text = `${UUID_B}:1-27,${UUID_A}:1-5:tag_a:1:tag_b:7-9`;
    const encoded = GtidSet.parse(text).encode();
    const parser = new Parser({
      buffer: encoded, offset: 0, end: encoded.length,
    });
    const event = new PreviousGtids(parser,
      { timestamp: 0, nextPosition: 0, size: encoded.length },
      { useChecksum: false });
    test.equal(event.gtidSet, text, 'PreviousGtids decodes our encoding');
    test.equal(GtidSet.parse(event.gtidSet).toString(), text,
      'and the text parses back');
    test.end();
  });

  test.end();
});

tap.test('MariadbGtidPosition', test => {
  test.equal(ExportedMariadbGtidPosition, MariadbGtidPosition,
    'MariadbGtidPosition is a named export of the package entry');

  test.test('parse round-trips', test => {
    for (const text of ['', '0-1-5', '0-1-5,1-2-10', '2-4294967295-9007199254740991']) {
      test.equal(MariadbGtidPosition.parse(text).toString(), text);
    }
    // Whitespace tolerated, output sorted by domain
    test.equal(MariadbGtidPosition.parse(' 1-2-3 , 0-1-5 ').toString(),
      '0-1-5,1-2-3');
    // seq_no beyond 2^53 survives exactly
    test.equal(MariadbGtidPosition.parse('0-1-18446744073709551615').toString(),
      '0-1-18446744073709551615');
    test.end();
  });

  test.test('invalid positions are rejected', test => {
    const bad = ['0-1', '0-1-2-3', 'a-1-2', '1e3-1-1', '0x10-1-1',
      '0-1-1.0', '4294967296-1-1', '0-1-18446744073709551616',
      '0-1-5,0-2-6' /* duplicate domain */];
    for (const text of bad) {
      test.throws(() => MariadbGtidPosition.parse(text), text);
    }
    test.end();
  });

  test.test('add overwrites the domain watermark', test => {
    const position = MariadbGtidPosition.parse('0-1-5');
    position.add({ domainId: 0, serverId: 2, seqNo: 3 });
    // Deliberately not a max: "last processed" wins after a failover
    test.equal(position.toString(), '0-2-3');
    position.add({ domainId: 7, serverId: 1, seqNo: 1 });
    test.equal(position.toString(), '0-2-3,7-1-1');
    // event.seqNo beyond 2^53 arrives as an exact string
    position.add({ domainId: 0, serverId: 2, seqNo: '9007199254740993' });
    test.equal(position.toString(), '0-2-9007199254740993,7-1-1',
      'string seqNo survives exactly');
    test.end();
  });

  test.test('covers', test => {
    const position =
      MariadbGtidPosition.parse('0-1-100,1-2-9007199254740993');

    // Inclusive (default): snapshot-barrier semantics, the position
    // covers the whole of its own final transaction
    test.equal(position.covers('0-1-100'), true, 'own watermark covered');
    test.equal(position.covers('0-1-99'), true);
    test.equal(position.covers('0-1-101'), false);

    // Exclusive: redelivery-watermark semantics, the watermark
    // transaction's own events must not read as already seen
    test.equal(position.covers('0-1-100', { inclusive: false }), false,
      'own watermark not covered exclusively');
    test.equal(position.covers('0-1-99', { inclusive: false }), true);

    // Exact beyond 2^53: as Numbers these two compare equal
    test.equal(position.covers('1-2-9007199254740992', { inclusive: false }),
      true);
    test.equal(position.covers('1-2-9007199254740993', { inclusive: false }),
      false, 'no rounding at the 2^53 boundary');
    test.equal(position.covers('1-2-9007199254740993'), true);
    test.equal(position.covers('1-2-9007199254740994'), false);

    // Post-failover sequence numbers can regress under a new server id,
    // so a mismatch is never covered, even for a lower seqNo
    test.equal(position.covers('0-7-1'), false,
      'server-id mismatch is not covered');
    test.equal(position.covers('9-1-1'), false, 'unknown domain');
    test.equal(position.covers(undefined), false,
      'events before the first GTID event are never covered');
    test.equal(position.covers(null), false);
    test.throws(() => position.covers('garbage'), 'malformed input throws');
    test.throws(() => position.covers('0-1'));

    const max = MariadbGtidPosition.parse('0-1-18446744073709551615');
    test.equal(max.covers('0-1-18446744073709551614', { inclusive: false }),
      true, 'exact at the top of the u64 range');
    test.equal(max.covers('0-1-18446744073709551615', { inclusive: false }),
      false);
    test.equal(max.covers('0-1-18446744073709551615'), true);
    test.end();
  });

  test.test('fromGtidList keeps the last entry per domain', test => {
    const position = MariadbGtidPosition.fromGtidList([
      { domainId: 0, serverId: 1, seqNo: 5 },
      { domainId: 1, serverId: 1, seqNo: 2 },
      { domainId: 0, serverId: 3, seqNo: 4 },
    ]);
    test.equal(position.toString(), '0-3-4,1-1-2');
    test.end();
  });

  test.test('isEmpty', test => {
    test.equal(MariadbGtidPosition.parse('').isEmpty(), true);
    test.equal(MariadbGtidPosition.parse('0-1-1').isEmpty(), false);
    test.end();
  });

  test.end();
});
