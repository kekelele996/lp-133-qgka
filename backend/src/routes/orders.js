const { Router } = require('express');
const pool = require('../../db');
const messages = require('../constants/messages');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

const POINTS_PER_HOUR = 10;
const MAX_SERVICE_HOURS = 24;

// 校验服务时长：正数、最多 24 小时，保留两位小数
const parseServiceHours = (value) => {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_SERVICE_HOURS) {
    return null;
  }
  return Math.round(hours * 100) / 100;
};

// 非进行态订单的统一提示
const getInactiveOrderError = (status) => {
  if (status === 'completed') {
    return { code: 400, message: messages.orders.alreadyCompleted };
  }
  if (status === 'cancelled') {
    return { code: 400, message: messages.orders.cancelled };
  }
  return null;
};

router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const { status } = req.query;
  let sql = `SELECT o.*, n.title, n.type, n.address,
    u1.name as user_name, u2.name as volunteer_name
    FROM orders o
    LEFT JOIN needs n ON o.need_id = n.id
    LEFT JOIN users u1 ON o.user_id = u1.id
    LEFT JOIN users u2 ON o.volunteer_id = u2.id
    WHERE o.user_id = ? OR o.volunteer_id = ?`;
  const params = [req.user.id, req.user.id];

  if (status) {
    sql += ' AND o.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY o.created_at DESC';

  const [rows] = await pool.query(sql, params);
  res.json({ orders: rows });
}));

// 第一步：志愿者提交实际服务时长，订单保持进行中（进入待居民确认），暂不入账积分
router.post('/:id/submit', authenticateToken, asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);

  if (orders.length === 0) {
    return res.status(404).json({ message: messages.orders.notFound });
  }

  const order = orders[0];

  if (order.volunteer_id !== req.user.id) {
    return res.status(403).json({ message: messages.orders.onlyVolunteerSubmit });
  }

  const inactiveError = getInactiveOrderError(order.status);
  if (inactiveError) {
    return res.status(inactiveError.code).json({ message: inactiveError.message });
  }

  const hours = parseServiceHours(req.body.service_hours);
  if (hours === null) {
    return res.status(400).json({ message: messages.orders.invalidServiceHours });
  }

  if (order.status === 'pending_confirm') {
    // 居民确认前允许志愿者更正时长，明确提示当前仍在等待确认
    await pool.query(
      'UPDATE orders SET service_hours = ? WHERE id = ?',
      [hours, orderId],
    );
    return res.json({
      message: messages.orders.resubmitted,
      order: { id: order.id, status: 'pending_confirm', service_hours: hours },
    });
  }

  await pool.query(
    `UPDATE orders
     SET status = 'pending_confirm', service_hours = ?, submitted_at = NOW()
     WHERE id = ?`,
    [hours, orderId],
  );

  res.json({
    message: messages.orders.submitted,
    order: { id: order.id, status: 'pending_confirm', service_hours: hours },
  });
}));

// 第二步：居民确认验收，服务时长与积分才一次性入账（事务 + 行锁保证不重复入账）
router.post('/:id/confirm', authenticateToken, asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [orders] = await conn.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId],
    );

    if (orders.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: messages.orders.notFound });
    }

    const order = orders[0];

    if (order.user_id !== req.user.id) {
      await conn.rollback();
      return res.status(403).json({ message: messages.orders.onlyResidentConfirm });
    }

    if (order.status === 'completed') {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.alreadyCompleted });
    }

    if (order.status === 'cancelled') {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.cancelled });
    }

    if (order.status === 'in_progress') {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.notSubmitted });
    }

    // status === 'pending_confirm'：行锁保证只有一个确认请求能走到这里
    const hours = Number(order.service_hours) || 0;
    const earnedPoints = Math.round(hours * POINTS_PER_HOUR);

    await conn.query(
      `UPDATE orders
       SET status = 'completed', points_earned = ?, end_time = NOW(), confirmed_at = NOW()
       WHERE id = ?`,
      [earnedPoints, orderId],
    );

    await conn.query(
      "UPDATE needs SET status = 'completed' WHERE id = ?",
      [order.need_id],
    );

    await conn.query(
      'UPDATE users SET service_hours = service_hours + ?, points = points + ? WHERE id = ?',
      [hours, earnedPoints, order.volunteer_id],
    );

    await conn.commit();

    res.json({
      message: messages.orders.completed,
      order: {
        id: order.id,
        status: 'completed',
        service_hours: hours,
        points_earned: earnedPoints,
      },
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

router.post('/:id/review', authenticateToken, asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  const orderId = req.params.id;
  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);

  if (orders.length === 0) {
    return res.status(404).json({ message: messages.orders.notFound });
  }

  const targetId = orders[0].user_id === req.user.id
    ? orders[0].volunteer_id
    : orders[0].user_id;

  await pool.query(
    'INSERT INTO reviews (order_id, reviewer_id, target_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
    [orderId, req.user.id, targetId, rating, comment],
  );

  res.json({ message: messages.orders.reviewed });
}));

module.exports = router;
