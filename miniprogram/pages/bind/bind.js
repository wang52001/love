const app = getApp()

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s.split('')
}
function ensure6Chars(val) {
  const s = typeof val === 'string' ? val : (val && val.toString ? val.toString() : '')
  return s.split('').concat(['','','','','','']).slice(0, 6)
}

Page({
  data: {
    tab: 0,
    status: '',
    bound: false,
    pending: false,
    rejected: false,
    isA: true,
    binding: false,
    inviteCode: ['A','B','C','1','2','3'],
    rawInput: '',
    inputCode: ['','','','','',''],
    inputFocus: false,
    focusIdx: 0,
    togetherDays: 0,
    bindDate: '',
    me: {},
    ta: {},
    loading: true,
    loadError: '',
    // 诊断信息
    debugInfo: '',
    hasToken: false,
    needLogin: false
  },

  onLoad(options) {
    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage', 'shareTimeline']
      })
    } catch (e) {}
    // 如果是对方用邀请分享点进来：自动切到"输入邀请码"tab 并预填
    let prefill = ''
    if (options && options.invite) {
      prefill = String(options.invite || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    } else if (options && options.scene) {
      try {
        const s = decodeURIComponent(String(options.scene))
        const m = s.match(/invite=([A-Z0-9]+)/i)
        if (m) prefill = String(m[1]).toUpperCase().slice(0, 6)
      } catch (_) {}
    }
    if (prefill && prefill.length === 6) {
      const arr = ensure6Chars(prefill)
      this.setData({
        tab: 1,
        rawInput: prefill,
        inputCode: arr,
        focusIdx: 6,
        inputFocus: false
      })
      wx.showToast({ title: '已自动填入邀请码 💕', icon: 'none' })
    }
    this.refresh()
  },
  onShow() { this.refresh() },

  async refresh() {
    const token = wx.getStorageSync('token')
    const hasToken = !!token
    this.setData({
      loading: true,
      loadError: '',
      hasToken: hasToken,
      needLogin: false,
      debugInfo: '开始加载… token=' + (hasToken ? '有' : '无')
    })

    // 没有token — 需要登录
    if (!hasToken) {
      console.log('[bind] 未登录，无 token')
      this.setData({
        loading: false,
        loadError: '',
        needLogin: true,
        debugInfo: '未登录，请先微信登录'
      })
      return
    }

    try {
      // 直接调用 API，不走 getBindInfo 的 catch，以便获取详细错误
      const couple = await app.request({ url: '/api/couple/info' })
      console.log('[bind] couple/info 返回:', JSON.stringify(couple).slice(0, 200))

      if (!couple) {
        this.setData({
          loading: false,
          loadError: '服务器返回空数据，请稍后重试',
          debugInfo: 'API 返回空数据'
        })
        return
      }

      wx.setStorageSync('coupleInfo', couple)
      const status = couple.status || ''
      const isA = couple.is_a !== false
      const isBound = status === 'bound'
      const isPending = !!(couple.pending)
      const isRejected = status === 'rejected'
      const myCode = couple.my_code || couple.invite_code || ''

      console.log('[bind] status=' + status + ' myCode=' + myCode + ' bound=' + isBound + ' pending=' + isPending)

      if (isBound && couple.bind_date) {
        const d = app.daysBetween(couple.bind_date, new Date()) + 1
        this.setData({
          status, bound: true, pending: false, rejected: false, isA,
          togetherDays: d, bindDate: couple.bind_date,
          ta: couple.ta_info || {},
          inviteCode: ensure6Chars(myCode),
          loading: false,
          debugInfo: '已绑定, code=' + myCode
        })
      } else if (isPending) {
        this.setData({
          status, bound: false, pending: true, rejected: false, isA,
          ta: couple.ta_info || {},
          inviteCode: ensure6Chars(myCode),
          loading: false,
          debugInfo: '等待确认, code=' + myCode
        })
      } else if (isRejected) {
        this.setData({
          status, bound: false, pending: false, rejected: true, isA,
          ta: couple.ta_info || {},
          inviteCode: ensure6Chars(myCode),
          loading: false,
          debugInfo: '已拒绝, code=' + myCode
        })
      } else {
        this.setData({
          status: '', bound: false, pending: false, rejected: false, isA: true,
          inviteCode: ensure6Chars(myCode),
          loading: false,
          debugInfo: '未绑定, code=' + myCode
        })
      }
      const me = wx.getStorageSync('userInfo') || {}
      this.setData({ me })
    } catch (e) {
      console.error('[bind] refresh error:', e)
      const errMsg = (e && (e.msg || e.message)) || '未知错误'
      const errCode = Number(e && (e.code || e.statusCode)) || 0
      // 检查是否因 401 导致 token 被清除
      const tokenAfter = wx.getStorageSync('token')
      if (!tokenAfter && errCode === 401) {
        // request 函数已经清除了 token 并触发 reLaunch
        this.setData({
          loading: false,
          loadError: '',
          needLogin: true,
          debugInfo: '登录已过期(401)，需要重新登录'
        })
        return
      }
      this.setData({
        loading: false,
        loadError: '加载失败：' + errMsg + '（错误码 ' + errCode + '）',
        debugInfo: '错误: code=' + errCode + ' msg=' + errMsg + ' url=' + (e.url || '')
      })
    }
  },

  // 重新登录
  async reLogin() {
    wx.showLoading({ title: '登录中…', mask: true })
    try {
      const data = await app.wxLogin(null)
      wx.hideLoading()
      if (data && data.user) {
        const user = data.user
        const avatarUrl = user.avatar_url
          ? (String(user.avatar_url).startsWith('http') ? user.avatar_url : 'https://api.jdhsf.top' + user.avatar_url)
          : ''
        const finalUser = {
          ...user,
          nickname: user.nickname || '情侣心情录用户',
          avatar_url: avatarUrl
        }
        wx.setStorageSync('userInfo', finalUser)
        app.globalData.userInfo = finalUser
      }
      wx.showToast({ title: '登录成功 💕', icon: 'none' })
      this.refresh()
    } catch (e) {
      wx.hideLoading()
      const msg = (e && (e.msg || e.message)) || '登录失败，请稍后重试'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  switchTab(e) {
    const tab = Number(e.currentTarget.dataset.tab)
    this.setData({ tab })
    if (tab === 1) setTimeout(() => this.setData({ inputFocus: true }), 300)
  },

  copy() {
    wx.setClipboardData({
      data: this.data.inviteCode.join(''),
      success: () => wx.showToast({ title: '邀请码已复制 📋', icon: 'none' })
    })
  },

  onFocus() { this.setData({ focusIdx: this.data.rawInput.length }) },

  onCodeInput(e) {
    const raw = (e.detail.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const arr = ensure6Chars(raw)
    this.setData({ rawInput: raw, inputCode: arr, focusIdx: raw.length })
  },

  async submitCode() {
    const code = this.data.inputCode.join('')
    if (code.length !== 6) {
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' })
      return
    }
    this.setData({ binding: true })
    wx.showLoading({ title: '正在绑定中…', mask: true })
    try {
      const res = await app.bindInviteCode(code) || {}
      wx.hideLoading()
      wx.setStorageSync('coupleInfo', res || {})
      app.globalData.coupleInfo = res || {}
      const status = res.status || ''
      const isPending = !!res.pending
      if (isPending) {
        this.setData({
          status,
          bound: false,
          pending: true,
          rejected: false,
          binding: false,
          isA: false,
          rawInput: '',
          inputCode: ['','','','','',''],
          focusIdx: 0,
          ta: res.ta_info || { nickname: 'TA' }
        })
        wx.showToast({ title: '申请已发送，等待 TA 确认 💕', icon: 'none' })
      } else if (status === 'bound') {
        const today = app.formatDate(new Date())
        this.setData({
          status,
          bound: true,
          pending: false,
          rejected: false,
          binding: false,
          rawInput: '',
          inputCode: ['','','','','',''],
          focusIdx: 0,
          togetherDays: 1,
          bindDate: res.bind_date || today,
          ta: res.ta_info || { nickname: 'TA' }
        })
        wx.showToast({ title: '绑定成功 💕', icon: 'none' })
      } else {
        this.setData({ binding: false })
        wx.showToast({ title: res.msg || '状态异常', icon: 'none' })
      }
    } catch (e) {
      wx.hideLoading()
      this.setData({ binding: false })
      wx.showToast({ title: (e && e.msg) || '绑定失败，请重试', icon: 'none' })
    }
  },

  async respond(e) {
    const action = e.currentTarget.dataset.action
    const actionText = { accept: '同意', reject: '拒绝', cancel: '取消' }[action] || action
    wx.showLoading({ title: actionText + '中…', mask: true })
    try {
      const res = await app.respondBind(action) || {}
      wx.hideLoading()
      if (res.status === 'bound') {
        wx.showToast({ title: '绑定成功 💕', icon: 'none' })
      } else if (res.status === 'rejected') {
        wx.showToast({ title: '已拒绝', icon: 'none' })
      } else if (res.status === 'unbound') {
        wx.showToast({ title: '已取消', icon: 'none' })
      } else if (res.msg) {
        wx.showToast({ title: res.msg, icon: 'none' })
      }
      this.refresh()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: (e && e.msg) || '操作失败', icon: 'none' })
    }
  },

  async unbind() {
    wx.showModal({
      title: '解绑情侣关系',
      content: '解绑后所有共享数据（天气、日历、愿望）会保留，你随时可以用邀请码再绑定回来。确认解绑？',
      confirmText: '申请解绑',
      confirmColor: '#FF6B6B',
      success: async (r) => {
        if (r.confirm) {
          try {
            wx.showLoading({ title: '解绑中…', mask: true })
            await app.unbindCouple()
            wx.hideLoading()
            wx.removeStorageSync('coupleInfo')
            app.globalData.coupleInfo = null
            this.setData({
              bound: false,
              togetherDays: 0,
              bindDate: '',
              ta: {},
              inviteCode: genCode(),
              rawInput: '',
              inputCode: ['','','','','','']
            })
            wx.showToast({ title: '已解绑', icon: 'none' })
          } catch (e) { wx.hideLoading() }
        }
      }
    })
  },

  goHome() { wx.switchTab({ url: '/pages/index/index' }) },

  onShareAppMessage() {
    const code = this.data.inviteCode.join('')
    if (this.data.bound) {
      return {
        title: '【情侣心情录】我们已经在一起第 ' + this.data.togetherDays + ' 天啦 💕',
        path: '/pages/profile/profile'
      }
    }
    return {
      title: '【情侣心情录】邀请你和我绑定：邀请码 ' + code + ' 💕',
      path: '/pages/bind/bind?invite=' + code
    }
  },

  onShareTimeline() {
    return { title: '情侣心情录 · 绑定你的另一半 💍' }
  }
})
