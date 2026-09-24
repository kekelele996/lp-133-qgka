module.exports = {
  health: '志愿者互助平台服务正常',
  auth: {
    unauthorized: '未授权访问',
    invalidToken: 'Token无效',
  },
  errors: {
    notFound: '接口不存在',
    internal: '服务器错误',
  },
  authFlow: {
    missingRegisterFields: '请填写必填项',
    phoneRegistered: '该手机号已注册',
    registerSuccess: '注册成功',
    missingLoginFields: '请输入手机号和密码',
    userNotFound: '用户不存在',
    wrongPassword: '密码错误',
    loginSuccess: '登录成功',
  },
  user: {
    notFound: '用户不存在',
    updated: '更新成功',
  },
  needs: {
    missingFields: '请填写标题和类型',
    created: '发布成功',
    notFound: '需求不存在',
    alreadyAccepted: '该需求已被接单',
    cannotAcceptOwnNeed: '不能接自己发布的需求',
    accepted: '接单成功',
  },
  orders: {
    notFound: '订单不存在',
    forbidden: '无权限操作',
    invalidHours: '请输入有效的服务时长',
    onlyVolunteerSubmit: '只有服务志愿者本人可以提交服务时长',
    onlyResidentConfirm: '只有居民本人可以验收确认',
    notInProgress: '服务尚未开始或已提交，不能重复提交服务时长',
    alreadySubmitted: '服务时长已提交，正在等待居民验收确认，请勿重复提交',
    notPendingConfirmation: '订单不在等待验收确认状态，无法确认',
    alreadyCompleted: '订单已完成，无需再次操作，积分已结算',
    submitted: '服务时长已提交，等待居民验收确认',
    confirmed: '验收确认成功，服务时长和积分已结算',
    reviewed: '评价成功',
  },
  messages: {
    missingFields: '请填写接收者和内容',
    sent: '发送成功',
  },
  rewards: {
    giftNotFound: '礼品不存在',
    insufficientPoints: '积分不足',
    exchanged: '兑换成功',
  },
  server: {
    started: '志愿者互助平台后端服务启动成功',
  },
};
