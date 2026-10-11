import {it, expect} from 'vitest';
import {deterministicContext} from '../shared/resources';

// Temporary ET-022 hosted failure-propagation experiment; remove before acceptance.
it('ET-022 controlled assertion failure reaches the hosted job', () => {
  expect(deterministicContext(1000).now()).toBe(1001);
});
