import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/quickadd.js';

// parse(text, {projects, tags, today}) -> fields (pure)
// tokens: #tag  @project (or @"multi word")  !due  ^when  *recur
const PROJECTS = [{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Deep Work' }];
const OPTS = { projects: PROJECTS, tags: ['chore'], today: '2026-03-04' }; // a Wednesday

const CASES = [
  ['plain title', 'buy milk', { title: 'buy milk' }],
  ['one tag', 'buy milk #errand', { title: 'buy milk', tags: ['errand'] }],
  ['multiple tags', '#a fix roof #b', { title: 'fix roof', tags: ['a', 'b'] }],
  ['project resolves case-insensitively', 'mow lawn @home', { title: 'mow lawn', project_id: 'p1' }],
  ['quoted multi-word project', 'write essay @"deep work"', { title: 'write essay', project_id: 'p2' }],
  ['unknown project stays in title', 'ping @nobody', { title: 'ping @nobody' }],
  ['ISO due', 'taxes !2026-04-15', { title: 'taxes', due_date: '2026-04-15' }],
  ['due today', 'call mom !today', { title: 'call mom', due_date: '2026-03-04' }],
  ['due tomorrow', 'call dad !tomorrow', { title: 'call dad', due_date: '2026-03-05' }],
  ['due next weekday (strictly after today)', 'report !friday', { title: 'report', due_date: '2026-03-06' }],
  ['due same weekday goes to next week', 'standup !wednesday', { title: 'standup', due_date: '2026-03-11' }],
  ['when someday', 'learn sanskrit ^someday', { title: 'learn sanskrit', when_type: 'someday' }],
  ['when date', 'pack bags ^2026-05-01', { title: 'pack bags', when_type: 'date', when_date: '2026-05-01' }],
  ['when tomorrow', 'gym ^tomorrow', { title: 'gym', when_type: 'date', when_date: '2026-03-05' }],
  ['recur daily defaults due=today', 'water plants *daily',
    { title: 'water plants', recur: { freq: 'daily', anchor: 'due' }, due_date: '2026-03-04' }],
  ['recur every N', 'change filter *every:3 !2026-03-10',
    { title: 'change filter', recur: { freq: 'every', n: 3, anchor: 'due' }, due_date: '2026-03-10' }],
  ['recur weekly with completion anchor', 'review inbox *weekly:mon,fri+completion',
    { title: 'review inbox', recur: { freq: 'weekly', days: ['mon', 'fri'], anchor: 'completion' }, due_date: '2026-03-04' }],
  ['recur monthly dom', 'pay rent *monthly:1 !2026-04-01',
    { title: 'pay rent', recur: { freq: 'monthly', dom: 1, anchor: 'due' }, due_date: '2026-04-01' }],
  ['everything combined', 'trim hedge @Home #garden #chore !friday ^2026-03-05',
    { title: 'trim hedge', project_id: 'p1', tags: ['garden', 'chore'], due_date: '2026-03-06', when_type: 'date', when_date: '2026-03-05' }],
  ['tokens only, empty title', '#x !today', { title: '', tags: ['x'], due_date: '2026-03-04' }],
];

for (const [name, text, expected] of CASES) {
  test(`quickadd: ${name}`, () => {
    const got = parse(text, OPTS);
    // compare only expected keys + title; absent keys must be undefined
    for (const k of ['title', 'tags', 'project_id', 'when_type', 'when_date', 'due_date', 'recur']) {
      assert.deepEqual(got[k], expected[k], `field ${k}`);
    }
  });
}

test('quickadd: invalid due token throws', () => {
  assert.throws(() => parse('x !someday', OPTS));
  assert.throws(() => parse('x !2026-13-99', OPTS));
});
test('quickadd: invalid recur token throws', () => {
  assert.throws(() => parse('x *yearly', OPTS));
  assert.throws(() => parse('x *every:0', OPTS));
});
test('quickadd: over-specified recur tokens are rejected, not silently truncated', () => {
  assert.throws(() => parse('x *every:2:3', OPTS));
  assert.throws(() => parse('x *daily:1', OPTS));
  assert.throws(() => parse('x *weekly:mon:fri', OPTS));
  assert.throws(() => parse('x *monthly:1:2', OPTS));
});
