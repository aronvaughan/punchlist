import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, mdToHtml } from '../public/md.js';

test('esc escapes all HTML metacharacters', () => {
  assert.equal(esc(`<img src=x onerror="a">&'`),
    '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});

test('raw HTML in notes is escaped, never rendered', () => {
  const html = mdToHtml('<script>alert(1)</script>\n\n<b onmouseover=x>hi</b>');
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /<b /);
  assert.match(html, /&lt;script&gt;/);
});

test('paragraphs, bold, italic, code', () => {
  assert.equal(mdToHtml('one **two** *three* `four`'),
    '<p>one <strong>two</strong> <em>three</em> <code>four</code></p>');
  assert.equal(mdToHtml('a\n\nb'), '<p>a</p>\n<p>b</p>');
});

test('links: http/https only; javascript: stays literal text', () => {
  assert.equal(mdToHtml('[x](https://example.com/a?b=1)'),
    '<p><a href="https://example.com/a?b=1" target="_blank" rel="noopener noreferrer">x</a></p>');
  const bad = mdToHtml('[x](javascript:alert(1))');
  assert.doesNotMatch(bad, /<a /);
  assert.doesNotMatch(bad, /javascript:alert\(1\)<\/a>/);
});

test('link text/url with quotes cannot break out of the attribute', () => {
  const html = mdToHtml('[a"b](https://e.com/"x)');
  assert.doesNotMatch(html, /"x"? onerror/);
  assert.doesNotMatch(html, /href="https:\/\/e\.com\/"x/);
});

test('unordered and ordered lists', () => {
  assert.equal(mdToHtml('- a\n- **b**'), '<ul><li>a</li><li><strong>b</strong></li></ul>');
  assert.equal(mdToHtml('1. a\n2) b'), '<ol><li>a</li><li>b</li></ol>');
});

test('fenced code blocks are escaped verbatim', () => {
  assert.equal(mdToHtml('```\n<x> & *y*\n```'), '<pre><code>&lt;x&gt; &amp; *y*</code></pre>');
});

test('empty and null input', () => {
  assert.equal(mdToHtml(''), '');
  assert.equal(mdToHtml(null), '');
  assert.equal(mdToHtml('\n\n\n'), '');
});
