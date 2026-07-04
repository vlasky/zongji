import tap from 'tap';
import { getEventClass } from '../lib/code_map.js';

tap.test('Codemap', test => {
  test.equal(getEventClass(2).name, 'Query');
  test.equal(getEventClass(490).name, 'Unknown');

  // Undecodable row-bearing event types must resolve to classes that
  // declare an unsupportedReason so ZongJi warns instead of dropping
  // row changes silently
  test.equal(getEventClass(39).name, 'PartialUpdateRows');
  test.match(getEventClass(39).unsupportedReason, /PARTIAL_UPDATE_ROWS_EVENT/);
  test.equal(getEventClass(40).name, 'TransactionPayload');
  test.match(getEventClass(40).unsupportedReason, /TRANSACTION_PAYLOAD_EVENT/);

  // Harmless unmapped types resolve to Unknown with no warning
  test.equal(getEventClass(41).name, 'Unknown');
  test.equal(getEventClass(41).unsupportedReason, undefined);
  test.end();
});
