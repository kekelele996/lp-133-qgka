/**
 * 并发确认测试：模拟 MySQL SELECT ... FOR UPDATE 行锁。
 * 两个居民确认请求并发到达时，只有一个能入账积分。
 */
const assert = require('assert');
const http = require('http');

const db = {
  users: [
    { id: 1, name: '志愿者甲', role: 'volunteer', points: 560, service_hours: 56 },
    { id: 2, name: '居民乙', role: 'resident', points: 0, service_hours: 0 },
  ],
  needs: [{ id: 10, user_id: 2, status: 'accepted' }],
  orders: [{
    id: 100, need_id: 10, user_id: 2, volunteer_id: 1,
    status: 'pending_confirm', service_hours: 2, points_earned: 0,
  }],
};

// 行锁等待队列：模拟 InnoDB，第二个 FOR UPDATE 阻塞到持有者 commit/rollback
const lockWaiters = new Map();
const acquireLock = (id) => new Promise((resolve) => {
  if (!lockWaiters.has(id)) {
    lockWaiters.set(id, { held: true, queue: [] });
    return resolve();
  }
  lockWaiters.get(id).queue.push(resolve);
});
const releaseLock = (id) => {
  const lock = lockWaiters.get(id);
  const next = lock.queue.shift();
  if (next) {
    next(); // 移交给队列中下一个事务
  } else {
    lockWaiters.delete(id);
  }
};

const runUpdate = (sql, params) => {
  sql = sql.replace(/\s+/g, ' ').trim();
  if (/^UPDATE orders SET service_hours/.test(sql)) {
    Object.assign(db.orders.find((o) => String(o.id) === String(params[1])), { service_hours: params[0] });
  } else if (/^UPDATE orders\s+SET status = 'completed'/.test(sql)) {
    Object.assign(db.orders.find((o) => String(o.id) === String(params[1])), {
      status: 'completed', points_earned: params[0], end_time: new Date(), confirmed_at: new Date(),
    });
  } else if (/^UPDATE orders\s+SET status = 'pending_confirm'/.test(sql)) {
    Object.assign(db.orders.find((o) => String(o.id) === String(params[1])), { status: 'pending_confirm', service_hours: params[0] });
  } else if (/^UPDATE needs SET status = 'completed'/.test(sql)) {
    db.needs.find((n) => String(n.id) === String(params[0])).status = 'completed';
  } else if (/^UPDATE users SET service_hours/.test(sql)) {
    const u = db.users.find((x) => String(x.id) === String(params[2]));
    u.service_hours = Number(u.service_hours) + Number(params[0]);
    u.points = Number(u.points) + Number(params[1]);
  } else if (/^INSERT INTO reviews/.test(sql)) {
    return { insertId: 1 };
  }
  return {};
};

const makeConnection = () => {
  let snapshot = null;
  let lockedId = null;
  return {
    async beginTransaction() {},
    async query(sql, params) {
      sql = sql.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('SELECT * FROM orders WHERE id = ? FOR UPDATE')) {
        const id = String(params[0]);
        await acquireLock(id); // 第二个事务在此阻塞，直到第一个提交
        lockedId = id;
        snapshot = JSON.stringify(db); // 拿到锁后才看到当前已提交状态
        return [JSON.parse(JSON.stringify(db.orders.filter((o) => String(o.id) === id)))];
      }
      if (sql.startsWith('SELECT * FROM orders WHERE id = ?')) {
        const id = String(params[0]);
        return [JSON.parse(JSON.stringify(db.orders.filter((o) => String(o.id) === id)))];
      }
      if (sql.startsWith('SELECT o.*')) {
        const uid = String(params[0]);
        return [db.orders.filter((o) => String(o.user_id) === uid || String(o.volunteer_id) === uid)
          .map((o) => ({ ...o, title: 't', type: 'shopping', address: 'a', user_name: 'r', volunteer_name: 'v' }))];
      }
      return [runUpdate(sql, params)];
    },
    async commit() { snapshot = null; if (lockedId) releaseLock(lockedId); },
    async rollback() {
      const restored = JSON.parse(snapshot);
      db.users = restored.users; db.needs = restored.needs; db.orders = restored.orders;
      snapshot = null;
      if (lockedId) releaseLock(lockedId);
    },
    release() {},
  };
};

const mockPool = {
  query: async (sql, params) => [runUpdate(sql.replace(/\s+/g, ' ').trim(), params)],
  getConnection: async () => makeConnection(),
};

const dbModulePath = require.resolve('../db');
require.cache[dbModulePath] = { id: dbModulePath, filename: dbModulePath, loaded: true, exports: mockPool };
const authPath = require.resolve('../src/middleware/auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { authenticateToken: (req, res, next) => { req.user = { id: Number(req.headers['x-user-id']) }; next(); } },
};

const { createApp } = require('../src/app');
const server = createApp().listen(0);
const port = server.address().port;

const confirm = () => new Promise((resolve) => {
  const req = http.request(
    `http://127.0.0.1:${port}/api/orders/100/confirm`,
    { method: 'POST', headers: { 'x-user-id': '2' } },
    (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    },
  );
  req.end();
});

(async () => {
  try {
    // 先把订单推进到 pending_confirm
    db.orders[0].status = 'pending_confirm';

    // 两个确认请求几乎同时发出（如双击/邻居代操作）
    const [first, second] = await Promise.all([confirm(), confirm()]);

    const statuses = [first.status, second.status].sort();
    console.log('  响应状态:', first.status, second.status);
    assert.ok(
      (first.status === 200 && second.status === 400) || (first.status === 400 && second.status === 200),
      '应恰好一个成功一个被拒',
    );
    const ok = first.status === 200 ? first.body : second.body;
    const rejected = first.status === 400 ? first.body : second.body;
    assert.ok(/服务完成/.test(ok.message), '成功响应应提示完成');
    assert.ok(/已完成/.test(rejected.message), '被拒响应应明确提示订单已完成');

    const volunteer = db.users[0];
    assert.strictEqual(volunteer.points, 580, `积分应只入账一次(580)，实际 ${volunteer.points}`);
    assert.strictEqual(Number(volunteer.service_hours), 58, '时长应只入账一次(58)');
    assert.strictEqual(db.orders[0].points_earned, 20, '订单积分记录为 20');

    console.log('  ✓ 并发双重确认：仅一个事务成功，第二个收到“订单已完成”提示');
    console.log('  ✓ 积分 580、时长 58，均只入账一次');
    console.log('\n🎉 并发安全测试通过');
  } catch (e) {
    console.error('❌ 测试失败:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
})();
