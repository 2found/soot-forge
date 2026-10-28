import assert from 'node:assert/strict';
import test from 'node:test';
import {SECRET_PATTERNS, detectSecret} from '../core/secrets.mjs';
import {fixture} from './helpers.mjs';

const shared = fixture('secrets');

test('patterns are exactly the contract detector', () => {
  assert.deepEqual(SECRET_PATTERNS, shared.patterns);
});

test('every block sample is caught by its pattern, every pass sample passes', () => {
  for (const sample of shared.block) {
    const text = sample.text.split(shared.split_marker).join('');
    assert.equal(detectSecret(text), sample.pattern, sample.pattern);
  }
  for (const text of shared.pass) assert.equal(detectSecret(text), null, text);
});
