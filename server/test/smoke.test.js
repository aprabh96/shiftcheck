// End-to-end test over the HTTP API. Needs a running server with an empty database and one admin:
//   npm run create-admin -- --name Owner   (with ADMIN_PIN=246810)
//   npm start
//   SMOKE_ADMIN_PIN=246810 npm test
import assert from 'node:assert/strict';
import test from 'node:test';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3001';
const ADMIN_PIN = process.env.SMOKE_ADMIN_PIN || '246810';

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: res.status, data };
}

test('ShiftCheck end to end', async (t) => {
  const suffix = Date.now().toString(36);
  let admin, alex, viewer, alexId, samId, viewerId, opening, closing, tOpen, tClose;

  await t.test('config and admin sign-in', async () => {
    assert.equal((await call('GET', '/api/employees/config')).status, 200);
    assert.equal((await call('POST', '/api/auth/login', { pin: '000000' })).status, 401);
    const r = await call('POST', '/api/auth/login', { pin: ADMIN_PIN });
    assert.equal(r.status, 200);
    admin = r.data.token;
  });

  await t.test('admin sets up categories, people and tasks', async () => {
    await call('POST', '/api/admin/categories', { name: `Opening ${suffix}` }, admin);
    await call('POST', '/api/admin/categories', { name: `Closing ${suffix}` }, admin);
    const cats = (await call('GET', '/api/admin/categories', undefined, admin)).data;
    opening = cats.find((c) => c.name === `Opening ${suffix}`).id;
    closing = cats.find((c) => c.name === `Closing ${suffix}`).id;

    assert.equal((await call('POST', '/api/admin/employees', { name: 'Short', pin: '12' }, admin)).status, 400, 'short PIN refused');
    assert.equal((await call('POST', '/api/admin/employees', { name: 'X', pin: '1234', role: 'superuser' }, admin)).status, 400, 'unknown role refused');
    alexId = (await call('POST', '/api/admin/employees', { name: `Alex ${suffix}`, pin: '1357' }, admin)).data.id;
    samId = (await call('POST', '/api/admin/employees', { name: `Sam ${suffix}`, pin: '2468' }, admin)).data.id;
    viewerId = (await call('POST', '/api/admin/employees', { name: `Viewer ${suffix}`, pin: '975310', role: 'viewer' }, admin)).data.id;
    await call('POST', `/api/admin/employees/${alexId}/categories`, { categoryIds: [opening] }, admin);
    await call('POST', `/api/admin/employees/${samId}/categories`, { categoryIds: [closing] }, admin);

    await call('POST', '/api/admin/tasks', { title: `Unlock front door ${suffix}`, category_id: opening, tolerance_hours: 24 }, admin);
    await call('POST', '/api/admin/tasks', { title: `Lock back door ${suffix}`, category_id: closing, tolerance_hours: 24 }, admin);
    let tasks = (await call('GET', '/api/admin/tasks', undefined, admin)).data;
    tasks = Array.isArray(tasks) ? tasks : tasks.tasks;
    tOpen = tasks.find((x) => x.title === `Unlock front door ${suffix}`).id;
    tClose = tasks.find((x) => x.title === `Lock back door ${suffix}`).id;
    await call('POST', `/api/admin/tasks/${tOpen}/set-assignments`, { employeeIds: [alexId] }, admin);
    await call('POST', `/api/admin/tasks/${tClose}/set-assignments`, { employeeIds: [samId] }, admin);
  });

  await t.test('employee sees and completes only their own tasks', async () => {
    const list = (await call('GET', '/api/employees/list')).data;
    assert.ok(list.some((e) => e.id === alexId));
    alex = (await call('POST', '/api/auth/login', { employeeId: alexId, pin: '1357' })).data.token;
    const mine = (await call('GET', '/api/tasks', undefined, alex)).data;
    assert.deepEqual(mine.map((x) => x.id), [tOpen]);
    assert.equal((await call('POST', '/api/tasks/complete', { taskIds: [tClose], displayName: 'Alex' }, alex)).status, 403);
    assert.equal((await call('GET', `/api/tasks/${tClose}/comments`, undefined, alex)).status, 404);
    assert.equal((await call('POST', '/api/tasks/complete', { taskIds: [tOpen], displayName: 'Alex' }, alex)).status, 200);
    const logs = await call('GET', '/api/admin/logs', undefined, admin);
    assert.ok(JSON.stringify(logs.data).includes(`Unlock front door ${suffix}`));
  });

  await t.test('roles are enforced', async () => {
    assert.equal((await call('GET', '/api/admin/employees', undefined, alex)).status, 403, 'employee blocked from admin');
    viewer = (await call('POST', '/api/auth/login', { employeeId: viewerId, pin: '975310' })).data.token;
    assert.equal((await call('GET', '/api/admin/employees', undefined, viewer)).status, 200, 'viewer can read');
    assert.equal((await call('POST', '/api/admin/categories', { name: 'Nope' }, viewer)).status, 403, 'viewer cannot write');
    assert.equal((await call('GET', '/api/tasks', undefined, 'not-a-token')).status, 401);
  });

  await t.test('input is validated and the last admin is protected', async () => {
    assert.equal((await call('PUT', '/api/admin/categories/reorder', { orderedIds: ['1); DROP TABLE categories;--'] }, admin)).status, 400);
    assert.equal((await call('PUT', '/api/admin/categories/reorder', { orderedIds: [closing, opening] }, admin)).status, 200);
    const admins = (await call('GET', '/api/admin/employees', undefined, admin)).data.filter((e) => e.role === 'admin');
    if (admins.length === 1) {
      assert.equal((await call('DELETE', `/api/admin/employees/${admins[0].id}`, undefined, admin)).status, 400);
      assert.equal((await call('PUT', `/api/admin/employees/${admins[0].id}`, { role: 'employee' }, admin)).status, 400);
    }
  });
});
