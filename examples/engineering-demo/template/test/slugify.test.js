import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/slugify.js';

test('lower-cases and joins words with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
});

test('strips accents and punctuation', () => {
  assert.equal(slugify('Crème Brûlée, deluxe!'), 'creme-brulee-deluxe');
});
