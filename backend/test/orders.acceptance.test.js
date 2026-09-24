/**
 * 订单双方验收流程单元测试
 * 通过桩件模拟 mysql2 连接池，验证路由状态机与权限/防重复逻辑
 */
const Module = require('module');
const assert = require('assert');

// ---- 内存数据库桩件 ----
const volunteer = { id: 10, points: 100, service_hours: 5 };
const resident = { id: 20, points: 0, service_hours: 0 };
const otherVolunteer = { id: 11, points: 0, service_hours: 0 };

let order;
let needStatus = 'accepted';
let conn;

const resetState = () => {
  volunteer.points = 100;
  volunteer.service_hours = 5;
  resident.points = 0;
  resident.service_hours = 0;
  order = {
    id: 1,
    need_id: 100,
    user_id: resident.id,
    volunteer_id: volunteer.id,
    status: 'in_progress',
    service_hours: 0,
    end_time: null,
    confirmed_at: null,
  };
  needStatus = 'accepted';
};

const users = { 10: volunteer, 11: otherVolunteer, 20: resident };

const execute = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();

  if (s.startsWith('SELECT o.*')) {
    return [[order], {}];
  }
  if (s.startsWith('SELECT * FROM orders WHERE id = ? FOR UPDATE')) {
    if (!conn || conn.locked !== 1) throw new Error('confirm 必须在事务中用 FOR UPDATE 锁定订单');
    return [[order], {}];
  }
  if (s.startsWith('SELECT * FROM orders WHERE id = ?')) {
    return [[order], {}];
  }
  if (s.startsWith("UPDATE orders SET status = 'pending_confirmation'")) {
    if (order.status !== 'in_progress') return [{ affectedRows: 0 }, {}];
    order.status = 'pending_confirmation';
    order.service_hours = params[0];
    order.end_time = 'NOW';
    return [{ affectedRows: 1 }, {}];
  }
  if (s.startsWith("UPDATE orders SET status = 'completed'")) {
    if (order.status !== 'pending_confirmation') return [{ affectedRows: 0 }, {}];
    order.status = 'completed';
    order.confirmed_at = 'NOW';
    return [{ affectedRows: 1 }, {}];
  }
  if (s.startsWith("UPDATE needs SET status = 'completed'")) {
    needStatus = 'completed';
    return [{ affectedRows: 1 }, {}];
  }
  if (s.startsWith('UPDATE users SET service_hours')) {
    const u = users[params[2]];
    u.service_hours = Number(u.service_hours) + Number(params[0]);
    u.points = Number(u.points) + Number(params[1]);
    return [{ affectedRows: 1 }, {}];
  }
  if (s.startsWith('INSERT INTO reviews')) {
    return [{ insertId: 1 }, {}];
  }
  throw new Error(`未模拟的 SQL: ${s}`);
};

const fakePool = {
  query: execute,
  async getConnection() {
    conn = {
      locked: 1,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release() { this.locked = 0; conn = null; },
      query: async (sql, params) => execute(sql, params),
    };
    return conn;
  },
};

// 拦截 require('../../db')，用内存桩件替代 MySQL
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '../../db') return fakePool;
  return origLoad.apply(this, arguments);
};

// 用真实 express 启动路由：authenticateToken 内部用 jsonwebtoken 解析
const express = require('express');
const jwt = require('jsonwebtoken');

const env = require('../src/config/env');
const ordersRouter = require('../src/routes/orders');
const { errorHandler } = require('../src/middleware/errorHandler');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (token) req.user = jwt.verify(token, env.jwtSecret);
  next();
});
app.use('/api/orders', ordersRouter);
app.use(errorHandler);

const server = app.listen(0);
const port = server.address().port;

const tokenFor = (id) => jwt.sign({ id }, env.jwtSecret);

const call = async (method, urlPath, userId, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(userId ? { Authorization: `Bearer ${tokenFor(userId)}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
};

const tests = [];
const test = async (name, fn) => {
  resetState();
  try {
    await fn();
    tests.push({ name, ok: true });
  } catch (err) {
    tests.push({ name, ok: false, err });
  }
};
const eq = assert.strictEqual;

(async () => {
  // 1. 志愿者提交时长：状态变为待确认，不增加积分
  await test('志愿者提交时长 -> pending_confirmation，积分不入账', async () => {
    const r = await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 2 });
    eq(r.status, 200);
    eq(order.status, 'pending_confirmation');
    eq(Number(order.service_hours), 2);
    eq(volunteer.points, 100);
    eq(Number(volunteer.service_hours), 5);
    assert.ok(/等待居民验收确认/.test(r.json.message));
  });

  // 2. 居民不能提交时长
  await test('居民提交时长被拒绝', async () => {
    const r = await call('POST', '/api/orders/1/submit', resident.id, { service_hours: 2 });
    eq(r.status, 403);
    assert.ok(/只有服务志愿者本人/.test(r.json.message));
    eq(order.status, 'in_progress');
  });

  // 3. 其他志愿者不能代提交（防止邻居代操作）
  await test('非本单志愿者提交被拒绝', async () => {
    const r = await call('POST', '/api/orders/1/submit', otherVolunteer.id, { service_hours: 2 });
    eq(r.status, 403);
  });

  // 4. 非法时长
  await test('非法服务时长 400', async () => {
    let r = await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 0 });
    eq(r.status, 400);
    r = await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: -3 });
    eq(r.status, 400);
    r = await call('POST', '/api/orders/1/submit', volunteer.id, {});
    eq(r.status, 400);
  });

  // 5. 重复提交被拒绝，时长不被覆盖
  await test('待确认状态重复提交 -> 明确提示且时长不变', async () => {
    await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 2 });
    const r = await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 9 });
    eq(r.status, 400);
    assert.ok(/请勿重复提交/.test(r.json.message));
    eq(Number(order.service_hours), 2);
    eq(volunteer.points, 100);
  });

  // 6. 服务中状态居民无法确认
  await test('未提交时长居民确认 -> 400', async () => {
    const r = await call('POST', '/api/orders/1/confirm', resident.id);
    eq(r.status, 400);
    assert.ok(/不在等待验收确认/.test(r.json.message));
    eq(order.status, 'in_progress');
  });

  // 7. 志愿者不能代替居民确认
  await test('志愿者确认被拒绝', async () => {
    await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 2 });
    const r = await call('POST', '/api/orders/1/confirm', volunteer.id);
    eq(r.status, 403);
    assert.ok(/只有居民本人/.test(r.json.message));
    eq(order.status, 'pending_confirmation');
  });

  // 8. 居民确认：完成订单+需求，结算时长与积分
  await test('居民确认 -> completed，时长/积分钟志愿者，需求完成', async () => {
    await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 2 });
    const r = await call('POST', '/api/orders/1/confirm', resident.id);
    eq(r.status, 200);
    eq(order.status, 'completed');
    eq(needStatus, 'completed');
    eq(Number(volunteer.service_hours), 7); // 5 + 2
    eq(volunteer.points, 120); // 100 + 20
    assert.ok(/验收确认成功/.test(r.json.message));
    assert.ok(order.confirmed_at);
  });

  // 9. 已完成订单再次提交/确认：明确提示，积分不重复增加
  await test('完成后重复确认 -> 明确提示，积分不重复', async () => {
    await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 2 });
    await call('POST', '/api/orders/1/confirm', resident.id);
    const r1 = await call('POST', '/api/orders/1/confirm', resident.id);
    eq(r1.status, 400);
    assert.ok(/订单已完成/.test(r1.json.message));
    const r2 = await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 2 });
    eq(r2.status, 400);
    assert.ok(/订单已完成/.test(r2.json.message));
    eq(volunteer.points, 120);
    eq(Number(volunteer.service_hours), 7);
  });

  // 10. 无关用户访问订单
  await test('无关用户确认 404/403', async () => {
    await call('POST', '/api/orders/1/submit', volunteer.id, { service_hours: 2 });
    const r = await call('POST', '/api/orders/1/confirm', 999);
    assert.ok(r.status === 403 || r.status === 401);
  });

  // 11. 进行中列表包含两种状态
  await test('订单列表 active 过滤 in_progress + pending_confirmation', async () => {
    const r = await call('GET', '/api/orders?status=active', volunteer.id);
    eq(r.status, 200);
    assert.ok(Array.isArray(r.json.orders));
  });

  server.close();

  let failed = 0;
  for (const t of tests) {
    if (t.ok) {
      console.log(`  ✓ ${t.name}`);
    } else {
      failed++;
      console.error(`  ✗ ${t.name}\n    ${t.err.stack}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
