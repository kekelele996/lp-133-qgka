const { Router } = require('express');
const pool = require('../../db');
const messages = require('../constants/messages');
const { authenticateToken } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');

const router = Router();

// 进行中包含两种状态：服务中、已提交时长等待居民验收
const ACTIVE_STATUSES = ['in_progress', 'pending_confirmation'];

// 10 积分 / 小时
const POINTS_PER_HOUR = 10;

const parseServiceHours = (value) => {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
    return null;
  }
  return Math.round(hours * 100) / 100;
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

  if (status === 'active') {
    sql += ` AND o.status IN (?, ?)`;
    params.push(...ACTIVE_STATUSES);
  } else if (status) {
    sql += ' AND o.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY o.created_at DESC';

  const [rows] = await pool.query(sql, params);
  res.json({ orders: rows });
}));

// 第一步：志愿者提交实际服务时长，订单保持进行中，等待居民验收
router.post('/:id/submit', authenticateToken, asyncHandler(async (req, res) => {
  const { service_hours } = req.body;
  const orderId = req.params.id;
  const hours = parseServiceHours(service_hours);

  if (hours === null) {
    return res.status(400).json({ message: messages.orders.invalidHours });
  }

  const [orders] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);

  if (orders.length === 0) {
    return res.status(404).json({ message: messages.orders.notFound });
  }

  const order = orders[0];

  if (order.volunteer_id !== req.user.id) {
    return res.status(403).json({ message: messages.orders.onlyVolunteerSubmit });
  }

  if (order.status === 'completed') {
    return res.status(400).json({ message: messages.orders.alreadyCompleted });
  }

  if (order.status === 'pending_confirmation') {
    return res.status(400).json({ message: messages.orders.alreadySubmitted });
  }

  if (order.status !== 'in_progress') {
    return res.status(400).json({ message: messages.orders.notInProgress });
  }

  await pool.query(
    `UPDATE orders
     SET status = 'pending_confirmation', service_hours = ?, end_time = NOW()
     WHERE id = ? AND status = 'in_progress'`,
    [hours, orderId],
  );

  // 此阶段只记录时长，不给志愿者增加积分
  res.json({ message: messages.orders.submitted });
}));

// 第二步：居民验收确认，结算服务时长和积分，订单与需求一起完成
router.post('/:id/confirm', authenticateToken, asyncHandler(async (req, res) => {
  const orderId = req.params.id;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // 行锁锁定订单，防止并发重复确认导致积分重复增加
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

    if (order.status !== 'pending_confirmation') {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.notPendingConfirmation });
    }

    const hours = Number(order.service_hours);

    // 仅在状态仍为待确认时更新，双重保险避免重复入账
    const [result] = await conn.query(
      `UPDATE orders
       SET status = 'completed', confirmed_at = NOW()
       WHERE id = ? AND status = 'pending_confirmation'`,
      [orderId],
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(400).json({ message: messages.orders.alreadyCompleted });
    }

    await conn.query(
      "UPDATE needs SET status = 'completed' WHERE id = ? AND status <> 'completed'",
      [order.need_id],
    );

    await conn.query(
      'UPDATE users SET service_hours = service_hours + ?, points = points + ? WHERE id = ?',
      [hours, hours * POINTS_PER_HOUR, order.volunteer_id],
    );

    await conn.commit();
    res.json({ message: messages.orders.confirmed, service_hours: hours, points: hours * POINTS_PER_HOUR });
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
