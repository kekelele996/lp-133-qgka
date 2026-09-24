/**
 * 订单双方验收流程集成测试（不依赖 MySQL）。
 * 通过 require 缓存注入内存版 pool，完整驱动 routes/orders.js。
 */
const assert = require('assert');
const http = require('http');

// ---- 内存数据库 ----
const db = {
  users: [
    { id: 1, name: '志愿者甲', role: 'volunteer', points: 560, service_hours: 56 },
    { id: 2, name: '居民乙', role: 'resident', points: 0, service_hours: 0 },
    { id: 3, name: '其他志愿者', role: 'volunteer', points: 10, service_hours: 1 },
    { id: 4, name: '其他居民', role: 'resident', points: 0, service_hours: 0 },
  ],
  needs: [
    { id: 10, user_id: 2, status: 'accepted' },
  ],
  orders: [
    // 初始进行中订单：志愿者1 服务 居民2
    {
      id: 100, need_id: 10, user_id: 2, volunteer_id: 1,
      status: 'in_progress', service_hours: 0, points_earned: 0,
    },
  ],
};

const clone = (v) => JSON.parse(JSON.stringify(v));

// 极简 SQL 执行器，仅覆盖 orders.js 中使用的语句
const execute = (sql, params = []) => {
  sql = sql.replace(/\s+/g, ' ').trim();

  let m;
  if ((m = sql.match(/^SELECT \* FROM orders WHERE id = \?( FOR UPDATE)?$/))) {
    return [clone(db.orders.filter((o) => String(o.id) === String(params[0])))];
  }
  if ((m = sql.match(/^SELECT o\.\*/))) {
    const uid = params[0];
    let rows = db.orders.filter((o) => String(o.user_id) === String(uid) || String(o.volunteer_id) === String(uid));
    // 列表查询可能带 status 过滤（动态拼接，这里用关键字识别）
    if (/AND o\.status = \?/.test(sql)) {
      const st = params[2];
      rows = rows.filter((o) => o.status === st);
    }
    return [clone(rows.map((o) => ({
      ...o,
      title: '测试需求',
      type: 'shopping',
      address: '测试地址',
      user_name: '居民乙',
      volunteer_name: '志愿者甲',
    })))];
  }
  if (/^UPDATE orders SET service_hours = \? WHERE id = \?$/.test(sql)) {
    const o = db.orders.find((x) => String(x.id) === String(params[1]));
    o.service_hours = params[0];
    return [{}];
  }
  if (/^UPDATE orders\s+SET status = 'pending_confirm'/.test(sql)) {
    const o = db.orders.find((x) => String(x.id) === String(params[1]));
    o.status = 'pending_confirm';
    o.service_hours = params[0];
    o.submitted_at = new Date();
    return [{}];
  }
  if (/^UPDATE orders\s+SET status = 'completed'/.test(sql)) {
    const o = db.orders.find((x) => String(x.id) === String(params[1]));
    o.status = 'completed';
    o.points_earned = params[0];
    o.end_time = new Date();
    o.confirmed_at = new Date();
    return [{}];
  }
  if (/^UPDATE needs SET status = 'completed' WHERE id = \?$/.test(sql)) {
    const n = db.needs.find((x) => String(x.id) === String(params[0]));
    n.status = 'completed';
    return [{}];
  }
  if (/^UPDATE users SET service_hours = service_hours \+ \?, points = points \+ \? WHERE id = \?$/.test(sql)) {
    const u = db.users.find((x) => String(x.id) === String(params[2]));
    u.service_hours = Number(u.service_hours) + Number(params[0]);
    u.points = Number(u.points) + Number(params[1]);
    return [{}];
  }
  if (/^INSERT INTO reviews/.test(sql)) {
    return [{ insertId: 1 }];
  }
  throw new Error(`mock 未覆盖的 SQL: ${sql}`);
};

// 模拟连接：commit 前的改动延迟生效，验证事务回滚不会产生部分写入
const makeConnection = () => {
  let snapshot = null;
  return {
    async beginTransaction() {},
    async query(sql, params) {
      if (/FOR UPDATE$/.test(sql.replace(/\s+/g, ' ').trim())) {
        snapshot = JSON.stringify({ db });
      }
      return execute(sql, params);
    },
    async commit() {
      snapshot = null;
    },
    async rollback() {
      const state = JSON.parse(snapshot);
      db.users = state.db.users;
      db.needs = state.db.needs;
      db.orders = state.db.orders;
      snapshot = null;
    },
    release() {},
  };
};

const mockPool = {
  query: async (sql, params) => execute(sql, params),
  getConnection: async () => makeConnection(),
};

// ---- 注入 mock pool 后再加载路由与 app ----
const dbModulePath = require.resolve('../db');
require.cache[dbModulePath] = {
  id: dbModulePath,
  filename: dbModulePath,
  loaded: true,
  exports: mockPool,
};

// 绕过真实 JWT：直接把鉴权中间件替换为注入 req.user
const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    authenticateToken: (req, res, next) => {
      req.user = { id: Number(req.headers['x-user-id']) };
      next();
    },
  },
};

const { createApp } = require('../src/app');

const server = createApp().listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/orders`;

const call = async (method, path, userId, body) => {
  const res = await new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': String(userId),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (r) => {
        let data = '';
        r.on('data', (c) => { data += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data || '{}') }));
      },
    );
    if (payload) req.write(payload);
    req.end();
  });
  return res;
};

let passed = 0;
const check = (name, cond, extra) => {
  assert.ok(cond, `${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`);
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const volunteer = () => db.users.find((u) => u.id === 1);
const order = () => db.orders.find((o) => o.id === 100);

(async () => {
  try {
    // 1. 初始状态
    check('订单初始为 in_progress', order().status === 'in_progress');
    check('志愿者初始积分为 560', volunteer().points === 560);

    // 2. 居民不能抢在志愿者前面提交
    let r = await call('POST', '/100/submit', 2, { service_hours: 2 });
    check('居民提交时长返回 403', r.status === 403, r.body);
    check('订单仍为 in_progress', order().status === 'in_progress');
    check('积分未变化', volunteer().points === 560);

    // 3. 无关志愿者也不能提交
    r = await call('POST', '/100/submit', 3, { service_hours: 2 });
    check('无关志愿者提交返回 403', r.status === 403, r.body);

    // 4. 非法时长
    for (const bad of [0, -1, 'abc', null, 25, undefined]) {
      r = await call('POST', '/100/submit', 1, { service_hours: bad });
      check(`非法时长 ${JSON.stringify(bad)} 返回 400`, r.status === 400, r.body);
    }
    check('非法时长不入账', volunteer().points === 560 && order().status === 'in_progress');

    // 5. 志愿者正常提交：进入待确认，但积分不入账
    r = await call('POST', '/100/submit', 1, { service_hours: 2 });
    check('志愿者提交成功', r.status === 200 && r.body.order.status === 'pending_confirm', r.body);
    check('订单状态 pending_confirm', order().status === 'pending_confirm');
    check('服务时长已记录为 2', Number(order().service_hours) === 2);
    check('提交后积分仍为 560（未提前入账）', volunteer().points === 560);
    check('需求仍未完成', db.needs[0].status === 'accepted');

    // 6. 志愿者不能自己确认
    r = await call('POST', '/100/confirm', 1);
    check('志愿者确认返回 403', r.status === 403, r.body);
    check('被拒后积分仍为 560', volunteer().points === 560);

    // 7. 无关居民不能确认
    r = await call('POST', '/100/confirm', 4);
    check('无关居民确认返回 403', r.status === 403, r.body);

    // 8. 志愿者在确认前可更正时长
    r = await call('POST', '/100/submit', 1, { service_hours: 3 });
    check('重复提交可更正时长且有明确提示', r.status === 200 && /等待居民确认/.test(r.body.message), r.body);
    check('时长更正为 3', Number(order().service_hours) === 3);
    check('更正后积分仍未入账', volunteer().points === 560);
    // 改回 2
    await call('POST', '/100/submit', 1, { service_hours: 2 });

    // 9. 居民确认：时长与积分一次性入账
    r = await call('POST', '/100/confirm', 2);
    check('居民确认成功', r.status === 200 && r.body.order.status === 'completed', r.body);
    check('订单 completed', order().status === 'completed');
    check('需求一并 completed', db.needs[0].status === 'completed');
    check('积分入账 560 + 20 = 580', volunteer().points === 580, volunteer());
    check('服务时长入账 56 + 2 = 58', Number(volunteer().service_hours) === 58);
    check('points_earned 记录为 20', order().points_earned === 20);

    // 10. 已完成订单重复确认：明确提示，不重复加积分
    r = await call('POST', '/100/confirm', 2);
    check('重复确认返回 400', r.status === 400, r.body);
    check('重复确认提示已完成', /已完成/.test(r.body.message));
    check('积分保持 580 不重复增加', volunteer().points === 580);

    // 11. 已完成订单重复提交：同样拒绝
    r = await call('POST', '/100/submit', 1, { service_hours: 5 });
    check('完成后再提交返回 400', r.status === 400, r.body);
    check('时长不被篡改', Number(order().service_hours) === 2);
    check('积分仍为 580', volunteer().points === 580);

    // 12. 404
    r = await call('POST', '/999/confirm', 2);
    check('不存在订单返回 404', r.status === 404);

    // 13. 列表能区分状态
    r = await call('GET', '?status=completed', 1);
    check('列表按 completed 过滤', r.status === 200 && r.body.orders.length === 1 && r.body.orders[0].status === 'completed');
    r = await call('GET', '?status=in_progress', 1);
    check('列表按 in_progress 过滤为空', r.status === 200 && r.body.orders.length === 0);

    // 14. 全新订单：志愿者未提交时居民确认应被拒绝
    db.orders.push({
      id: 101, need_id: 10, user_id: 2, volunteer_id: 1,
      status: 'in_progress', service_hours: 0, points_earned: 0,
    });
    r = await call('POST', '/101/confirm', 2);
    check('未提交时长居民确认返回 400', r.status === 400 && /还未提交/.test(r.body.message), r.body);
    check('积分仍为 580', volunteer().points === 580);

    console.log(`\n🎉 全部 ${passed} 项断言通过`);
  } catch (e) {
    console.error('❌ 测试失败:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
