import tap from 'tap';
import { getEventClass } from '../lib/code_map.js';

tap.test('Codemap', test => {
  test.equal(getEventClass(2).name, 'Query');
  test.equal(getEventClass(490).name, 'Unknown');
  test.end();
});
