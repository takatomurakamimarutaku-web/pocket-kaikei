import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute } from '../js/router.js';

const routes = [
  { path: '/beers' },
  { path: '/beer/:id' },
  { path: '/beer/:id/edit' },
  { path: '/checkin/new' },
  { path: '/checkin/:id/edit' },
];

test('matchRoute: 固定パスとパラメータ', () => {
  assert.equal(matchRoute('#/beers', routes).route.path, '/beers');
  const m = matchRoute('#/beer/abc-123', routes);
  assert.equal(m.route.path, '/beer/:id');
  assert.deepEqual(m.params, { id: 'abc-123' });
  assert.deepEqual(matchRoute('#/beer/x/edit', routes).params, { id: 'x' });
});

test('matchRoute: new が :id より先に定義されていれば優先される', () => {
  assert.equal(matchRoute('#/checkin/new', routes).route.path, '/checkin/new');
  assert.equal(matchRoute('#/checkin/xyz/edit', routes).params.id, 'xyz');
});

test('matchRoute: クエリとエンコード', () => {
  const m = matchRoute('#/checkin/new?beerId=a%20b', routes);
  assert.equal(m.route.path, '/checkin/new');
  assert.deepEqual(m.query, { beerId: 'a b' });
  assert.equal(matchRoute('#/beer/%E3%81%82', routes).params.id, 'あ');
});

test('matchRoute: 未定義・不正は null', () => {
  assert.equal(matchRoute('#/unknown', routes), null);
  assert.equal(matchRoute('', routes), null);
  assert.equal(matchRoute('#/beer', routes), null);
  assert.equal(matchRoute('#/beer/%E3%81', routes), null, '壊れたエンコード');
});
