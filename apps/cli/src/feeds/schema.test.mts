import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSchema, validate } from './schema.mts';
import type { Schema } from './schema.mts';

const schema = (raw: unknown): Schema => {
  const parsed = parseSchema(raw);
  assert.equal(typeof parsed, 'object', String(parsed));
  return parsed as Schema;
};

const ACCEPTS_AND_REJECTS: [string, unknown, unknown, unknown, RegExp][] = [
  ['type object', { type: 'object' }, {}, [], /options must be a object/],
  ['type array', { type: 'array' }, [], {}, /options must be a array/],
  ['type string', { type: 'string' }, 'a', 1, /options must be a string/],
  ['type integer', { type: 'integer' }, 3, 3.5, /options must be a whole number/],
  ['type number', { type: 'number' }, 3.5, '3', /options must be a number/],
  ['type boolean', { type: 'boolean' }, false, 0, /options must be a boolean/],
  ['minLength', { type: 'string', minLength: 2 }, 'ab', 'a', /at least 2 characters/],
  ['maxLength', { type: 'string', maxLength: 2 }, 'ab', 'abc', /at most 2 characters/],
  ['pattern', { type: 'string', pattern: '^a+$' }, 'aa', 'ab', /must match \^a\+\$/],
  ['string enum', { enum: ['x', 'y'] }, 'y', 'z', /must be one of "x", "y"/],
  ['number enum', { enum: [1, 2] }, 2, 3, /must be one of 1, 2/],
  ['minimum', { type: 'integer', minimum: 1 }, 1, 0, /at least 1/],
  ['maximum', { type: 'integer', maximum: 5 }, 5, 6, /at most 5/],
  ['minItems', { type: 'array', minItems: 1 }, [1], [], /at least 1 items/],
  ['maxItems', { type: 'array', maxItems: 1 }, [1], [1, 2], /at most 1 items/],
  ['required', { type: 'object', required: ['q'] }, { q: 1 }, {}, /options\.q is required/],
  [
    'additionalProperties false',
    { type: 'object', additionalProperties: false },
    {},
    { x: 1 },
    /options\.x is not an option here/,
  ],
  [
    'additionalProperties schema',
    { type: 'object', additionalProperties: { type: 'string' } },
    { x: 'a' },
    { x: 1 },
    /options\.x must be a string/,
  ],
  [
    'properties',
    { type: 'object', properties: { n: { type: 'integer' } } },
    { n: 1 },
    { n: 'a' },
    /options\.n must be a whole number/,
  ],
  ['items', { type: 'array', items: { type: 'string' } }, ['a'], ['a', 2], /options\[1\] must be a string/],
];

for (const [name, raw, good, bad, reason] of ACCEPTS_AND_REJECTS)
  test(`schema keyword ${name} accepts a fitting value and rejects another`, () => {
    const parsed = schema(raw);
    assert.equal(validate(parsed, good), undefined);
    assert.match(validate(parsed, bad) ?? '', reason);
  });

test('an error names the index and the property it is about', () => {
  const parsed = schema({
    type: 'object',
    properties: {
      repositories: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' } },
    },
  });
  assert.equal(
    validate(parsed, { repositories: ['acme/app', 'acme'] }),
    'options.repositories[1] must match ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
  );
});

test('annotations are ignored and a schema without a type constrains only its keywords', () => {
  const parsed = schema({ description: 'd', default: 1, title: 't', examples: [1], minimum: 2 });
  assert.equal(validate(parsed, 'anything'), undefined);
  assert.match(validate(parsed, 1) ?? '', /at least 2/);
});

test('a property that is not declared is allowed unless additionalProperties says otherwise, and "constructor" is not a declared one', () => {
  const parsed = schema({ type: 'object', properties: { a: { type: 'string' } } });
  assert.equal(validate(parsed, { b: 1 }), undefined);
  assert.equal(validate(parsed, JSON.parse('{"constructor": 1, "__proto__": 2}')), undefined);
});

const REJECTED_SCHEMAS: [string, unknown, RegExp][] = [
  ['an unknown keyword', { type: 'object', oneOf: [] }, /schema uses a keyword this CLI does not read: "oneOf"/],
  [
    'an unknown keyword nested in a property',
    { properties: { a: { $ref: '#' } } },
    /schema\.properties\.a uses a keyword.*"\$ref"/,
  ],
  ['a schema that is not an object', [], /schema must be an object/],
  ['an unknown type', { type: 'null' }, /type must be one of/],
  ['a negative count', { minItems: -1 }, /minItems must be a whole number/],
  ['a non-number bound', { minimum: '1' }, /minimum must be a number/],
  ['a pattern that is not a regular expression', { pattern: '(' }, /not a regular expression/],
  ['a pattern that needs the u flag', { pattern: '\\p{Nope}' }, /not a regular expression/],
  ['an enum of objects', { enum: [{}] }, /enum must be a list/],
  ['required that is not a list of names', { required: [1] }, /required must be a list/],
  ['properties that is a list', { properties: [] }, /properties must be an object/],
  ['additionalProperties that is text', { additionalProperties: 'no' }, /additionalProperties must be an object/],
];

for (const [name, raw, reason] of REJECTED_SCHEMAS)
  test(`parseSchema rejects ${name}`, () => assert.match(String(parseSchema(raw)), reason));

test('parseSchema allows eight levels of nesting and rejects a ninth', () => {
  const nest = (levels: number): unknown =>
    levels === 0 ? { type: 'string' } : { type: 'object', properties: { a: nest(levels - 1) } };
  assert.equal(typeof parseSchema(nest(8)), 'object');
  assert.match(String(parseSchema(nest(9))), /nested deeper than 8 levels/);
});
