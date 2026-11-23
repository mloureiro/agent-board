import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeholders, render } from './template.mts';

test('placeholders lists each name once and leaves other braces as literal text', () => {
  assert.deepEqual(placeholders('review {url} and {title}, {url} again'), ['url', 'title']);
  assert.deepEqual(placeholders('{ } {} {1a} {a-b} {a b} { url } {{key}} }{ {'), ['key']);
  assert.deepEqual(placeholders(`{${'a'.repeat(40)}} {${'a'.repeat(41)}}`), ['a'.repeat(40)]);
  assert.deepEqual(placeholders('no braces'), []);
});

test('render replaces every placeholder and keeps other braces', () => {
  assert.deepEqual(render('/review {url} {url} {x', { url: 'u' }), { ok: true, text: '/review u u {x' });
  assert.deepEqual(render('json: {"a": 1}', {}), { ok: true, text: 'json: {"a": 1}' });
});

test('render names the first field an item did not send, whatever the name', () => {
  assert.deepEqual(render('{url} {title} {other}', { url: 'u' }), { ok: false, missing: 'title' });
  assert.deepEqual(render('{constructor}', {}), { ok: false, missing: 'constructor' });
});

test('render removes control characters from a value and cuts it to 500 characters', () => {
  const rendered = render('t: {title}', { title: `a\u0000b\u001b[31mc\u2028d${'x'.repeat(600)}` });
  assert.equal(rendered.ok, true);
  const text = rendered.ok ? rendered.text : '';
  assert.match(text, /^t: ab\[31mcd/);
  assert.equal(text.length, 't: '.length + 500);
});

test('a value that holds a placeholder is not expanded again', () => {
  assert.deepEqual(render('{a}', { a: '{b}', b: 'x' }), { ok: true, text: '{b}' });
});

test('render puts a value on one line: newlines and tabs become one space, and format characters go', () => {
  const rendered = render('t: {title}', { title: 'a\n\n## b\r\n\tc‮d​e' });
  assert.deepEqual(rendered, { ok: true, text: 't: a ## b cde' });
});
