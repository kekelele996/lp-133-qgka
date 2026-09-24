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
    invalidServiceHours: '请输入有效的服务时长（大于0且不超过24小时）',
    onlyVolunteerSubmit: '只有服务该订单的志愿者可以提交服务时长',
    onlyResidentConfirm: '只有发布需求的居民可以确认验收',
    alreadyCompleted: '订单已完成验收，服务时长与积分已入账，无需重复操作',
    waitingResident: '服务时长已提交，等待居民确认验收',
    notSubmitted: '志愿者还未提交服务时长，请等待志愿者提交',
    cancelled: '订单已取消，无法继续操作',
    resubmitted: '服务时长已更新，仍在等待居民确认验收',
    submitted: '服务时长提交成功，等待居民确认',
    completed: '居民已确认，服务完成',
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
