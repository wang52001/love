const app = getApp()

Page({
  data: {
    isLogin: false,
    userInfo: {},
    coupleInfo: null,
    togetherDays: 0,
    avatarChar: '小',
    kpi: { days: 0, sunny: 0, rainbow: 0 },
    hasAlert: false,
    locVisible: true,
    pendingAvatar: '',
    pendingNick: '',
    loginLoading: false,
    _authFailed: false,
    needFixProfile: false,
    showFixer: false,
    fixAvatar: '',
    fixNick: '',
    fixerSaving: false,
    agreeProtocol: false,
    subscribeStatus: { alert: 0, report: 0, greeting: 0 },
    vipIsVip: false,
    vipDaysLeft: 0
  },

  _isDefaultNick(n) {
    if (!n) return true
    const s = String(n).trim()
    if (!s) return true
    if (s === '情侣心情录用户' || s === '情侣心情录' || s === '用户') return true
    return false
  },

  _updateNeedFix() {
    const u = this.data.userInfo || {}
    const need = this._isDefaultNick(u.nickname) || !u.avatar_url
    this.setData({ needFixProfile: !!need })
  },

  // 登录后自动展开完善资料卡片（仅在需要完善时调用）
  _expandFixerIfNeeded() {
    const u = this.data.userInfo || {}
    const need = this._isDefaultNick(u.nickname) || !u.avatar_url
    if (need) {
      this.setData({
        needFixProfile: true,
        showFixer: true,
        fixAvatar: u.avatar_url || '',
        fixNick: !this._isDefaultNick(u.nickname) ? (u.nickname || '') : ''
      })
      return true
    }
    return false
  },

  onLoad() {
    this.refreshLogin(true)
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      try { this.getTabBar().setData({ selected: 2 }) } catch(e) {}
    }
    this.refreshLogin(true)
    // 游客模式：未登录时不请求需要鉴权的接口，避免 401 刷屏
    const token = wx.getStorageSync('token')
    if (!token) {
      this.setData({
        coupleInfo: null,
        togetherDays: 0,
        kpi: { days: 0, sunny: 0, rainbow: 0 },
        hasAlert: false
      })
      return
    }
    wx.showLoading({ title: '加载中…', mask: true })
    Promise.all([
      app.getBindInfo().then((couple) => {
        if (couple) {
          this.setData({
            coupleInfo: couple,
            locVisible: couple.visible_to_me !== false,
            _authFailed: false
          })
          wx.setStorageSync('coupleInfo', couple)
          app.globalData.coupleInfo = couple
          if (couple.bind_date) {
            const d = app.daysBetween(couple.bind_date, new Date()) + 1
            this.setData({ togetherDays: d })
          }
        }
      }).catch((e) => {
        // 如果 couple/kpi 任意一个接口返回 401/无效，说明虽然有 token 但无效，立刻回登录态
        const needLogout = this._isAuthFail(e)
        if (needLogout) this._clearAuthAndShowLogin()
      }),
      app.getProfileKpi().then((kpi) => {
        if (kpi) this.setData({ kpi: { days: kpi.days || 0, sunny: kpi.sunny || 0, rainbow: kpi.rainbow || 0 }, _authFailed: false })
      }).catch((e) => {
        const needLogout = this._isAuthFail(e)
        if (needLogout) this._clearAuthAndShowLogin()
      }),
      app.getAlertList().then((list) => {
        if (list && Array.isArray(list) && list.length) {
          const urgent = list.some((a) => Number(a.days_left) <= 3)
          this.setData({ hasAlert: urgent, _authFailed: false })
        } else {
          this.setData({ hasAlert: false, _authFailed: false })
        }
      }).catch(() => {}),
      app.getVipInfo().then((vip) => {
        if (vip) this.setData({ vipIsVip: !!vip.is_vip, vipDaysLeft: Number(vip.days_left) || 0 })
      }).catch(() => {}),
      this.loadSubscribeStatus()
    ]).then(() => wx.hideLoading(), () => wx.hideLoading())
  },

  _isAuthFail(e) {
    if (!e) return false
    const code = Number(e.code)
    const statusCode = Number(e.statusCode)
    const msg = (e.msg || e.message || e.errMsg || '') + ''
    if (code === 401 || statusCode === 401) return true
    if (/401|未登录|invalid.*token|token.*invalid|expired|unauthorized/i.test(msg)) return true
    return false
  },

  _clearAuthAndShowLogin() {
    wx.removeStorageSync('token')
    wx.removeStorageSync('userInfo')
    wx.removeStorageSync('coupleInfo')
    app.globalData.token = ''
    app.globalData.userInfo = null
    app.globalData.coupleInfo = null
    this.setData({
      pendingAvatar: '',
      pendingNick: '',
      _authFailed: true
    })
    this.refreshLogin(false)
  },

  async refreshLogin(verifyRemote) {
    const token = wx.getStorageSync('token')
    const userInfo = wx.getStorageSync('userInfo') || {}
    const hasLocalToken = !!token
    this.setData({
      isLogin: hasLocalToken,
      userInfo,
      avatarChar: (userInfo.nickname || userInfo.nick_name || '小').slice(0, 1)
    })
    if (token) app.globalData.token = token
    if (userInfo) app.globalData.userInfo = userInfo
    this._updateNeedFix()

    if (hasLocalToken && verifyRemote !== false) {
      try {
        const kpi = await app.getProfileKpi()
        if (kpi && typeof kpi === 'object') {
          this.setData({ _authFailed: false })
          if (typeof kpi.days !== 'undefined') this.setData({ kpi: { days: kpi.days || 0, sunny: kpi.sunny || 0, rainbow: kpi.rainbow || 0 } })
        } else {
          this._clearAuthAndShowLogin()
        }
      } catch (e) {
        if (this._isAuthFail(e)) {
          this._clearAuthAndShowLogin()
        }
      }
    }
  },

  async onChooseAvatar(e) {
    const url = e.detail && e.detail.avatarUrl
    if (!url) return
    if (this.data.isLogin) {
      wx.showLoading({ title: '更新头像…', mask: true })
      try {
        const base64 = await app.avatarToBase64(url)
        const user = await app.updateProfileApi({ avatar_base64: base64 })
        wx.hideLoading()
        const avatarUrl = user && user.avatar_url ? ('https://api.jdhsf.top' + user.avatar_url) : ('https://api.jdhsf.top/api/avatar/' + (user && user.id ? user.id : this.data.userInfo.id))
        const next = { ...this.data.userInfo, ...(user || {}), avatar_url: avatarUrl }
        wx.setStorageSync('userInfo', next)
        app.globalData.userInfo = next
        this.refreshLogin(false)
        wx.showToast({ title: '头像已更新 ✨', icon: 'none' })
      } catch (e) {
        wx.hideLoading()
        wx.showToast({ title: '头像更新失败', icon: 'none' })
      }
    }
  },

  onNickBlur(e) {
    const nick = e.detail && e.detail.value
    if (!nick) return
    if (this.data.isLogin) {
      app.updateProfileApi({ nickname: nick }).then((user) => {
        const next = { ...this.data.userInfo, ...(user || {}), nickname: nick }
        wx.setStorageSync('userInfo', next)
        app.globalData.userInfo = next
        this.refreshLogin(false)
      })
    }
  },

  onNickInput(e) {
    this.setData({ pendingNick: e.detail.value || '' })
  },

  toggleFixer() {
    const nextShow = !this.data.showFixer
    const ui = this.data.userInfo || {}
    this.setData({
      showFixer: nextShow,
      fixAvatar: nextShow ? (ui.avatar_url || '') : this.data.fixAvatar,
      fixNick: nextShow ? (!this._isDefaultNick(ui.nickname) ? (ui.nickname || '') : '') : this.data.fixNick
    })
  },
  closeFixer() {
    this.setData({ showFixer: false, fixerSaving: false })
  },

  onAvatarError(e) {
    const userInfo = this.data.userInfo || {}
    if (userInfo.avatar_url) {
      this.setData({ userInfo: { ...userInfo, avatar_url: '' } })
    }
  },

  onAvatarTap() {
    this.editProfile()
  },

  async uploadAvatar(tempPath) {
    wx.showLoading({ title: '上传头像…', mask: true })
    try {
      const base64 = await app.avatarToBase64(tempPath)
      const user = await app.updateProfileApi({ avatar_base64: base64 })
      wx.hideLoading()
      const avatarUrl = user && user.avatar_url ? ('https://api.jdhsf.top' + user.avatar_url) : ('https://api.jdhsf.top/api/avatar/' + (user && user.id ? user.id : this.data.userInfo.id))
      const next = { ...this.data.userInfo, ...(user || {}), avatar_url: avatarUrl }
      wx.setStorageSync('userInfo', next)
      app.globalData.userInfo = next
      this.refreshLogin(false)
      wx.showToast({ title: '头像已更新 ✨', icon: 'none' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '头像更新失败', icon: 'none' })
    }
  },

  onFixAvatar(e) {
    const url = e.detail && e.detail.avatarUrl
    if (!url) return
    this.setData({ fixAvatar: url })
  },
  onFixNickBlur(e) {
    const nick = e.detail && e.detail.value
    if (typeof nick !== 'string') return
    this.setData({ fixNick: nick })
  },
  onFixNickInput(e) {
    this.setData({ fixNick: e.detail.value || '' })
  },
  async saveFixer() {
    const { fixAvatar, fixNick, userInfo, fixerSaving } = this.data
    if (fixerSaving) return
    if (!fixAvatar && !fixNick) {
      wx.showToast({ title: '先选头像或填昵称 🌸', icon: 'none' })
      return
    }
    this.setData({ fixerSaving: true })
    wx.showLoading({ title: '保存中…', mask: true })
    try {
      const patch = {}
      if (fixNick && !this._isDefaultNick(fixNick)) patch.nickname = fixNick
      // 头像转 base64 再上传（微信临时路径或本地文件都转）
      const isTemp = fixAvatar && (/^http:\/\/tmp\//.test(fixAvatar) || /^wxfile:\/\//.test(fixAvatar) || /^\/storage\//.test(fixAvatar) || /^file:\/\//.test(fixAvatar) || /^blob:/.test(fixAvatar))
      if (fixAvatar && isTemp) {
        const base64 = await app.avatarToBase64(fixAvatar)
        patch.avatar_base64 = base64
      } else if (fixAvatar) {
        patch.avatar_url = fixAvatar
      }
      const updated = Object.keys(patch).length ? await app.updateProfileApi(patch) : null
      const avatarUrl = updated && updated.avatar_url ? ('https://api.jdhsf.top' + updated.avatar_url) : (userInfo.avatar_url || '')
      const next = {
        ...userInfo,
        ...(updated || {}),
        avatar_url: avatarUrl,
        ...(patch.nickname ? { nickname: patch.nickname } : {})
      }
      wx.setStorageSync('userInfo', next)
      app.globalData.userInfo = next
      this.refreshLogin(false)
      this.setData({ showFixer: false, fixAvatar: '', fixNick: '' })
      wx.hideLoading()
      this.setData({ fixerSaving: false })
      wx.showToast({ title: '资料已更新 ✨', icon: 'none' })
    } catch (e) {
      wx.hideLoading()
      this.setData({ fixerSaving: false })
      const msg = (e && (e.msg || e.message)) || '保存失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  async wxLogin() {
    const { isLogin, agreeProtocol } = this.data
    if (isLogin) return
    // ============== 微信审核要求：必须先由用户主动勾选同意 ==============
    if (!agreeProtocol) {
      wx.showModal({
        title: '请先同意协议',
        content: '为了保护你的隐私与账号安全，请先阅读并同意《用户协议》和《隐私政策》后再进行登录。\n\n你可以点击下方文字直接查看完整内容。',
        confirmText: '去查看并勾选',
        cancelText: '知道了',
        confirmColor: '#FF8FAB',
        success: (r) => {
          if (r.confirm) {
            // 自动打开用户协议给审核/用户看
            if (typeof this.openAgreement === 'function') this.openAgreement()
          }
        }
      })
      return
    }
    this.setData({ loginLoading: true })
    wx.showLoading({ title: '登录中…', mask: true })
    try {
      const data = await app.wxLogin(null)
      wx.hideLoading()
      this.setData({ loginLoading: false })
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
      this.refreshLogin(false)
      // 登录成功后立即拉取绑定信息，避免切到「我的」页时显示未绑定
      try {
        const couple = await app.getBindInfo()
        if (couple) {
          wx.setStorageSync('coupleInfo', couple)
          app.globalData.coupleInfo = couple
          this.setData({ coupleInfo: couple })
          if (couple.bind_date) {
            this.setData({ togetherDays: app.daysBetween(couple.bind_date, new Date()) + 1 })
          }
        }
      } catch (e) {}
      // 如果需要完善资料（新用户/默认昵称/无头像），停留在「我的」页并自动展开完善卡片
      const expanded = this._expandFixerIfNeeded()
      if (!expanded) {
        setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 700)
      } else {
        setTimeout(() => {
          try { wx.pageScrollTo({ selector: '.profile-fixer-card', duration: 280 }) } catch(e) {}
        }, 300)
      }
    } catch (e) {
      this.setData({ loginLoading: false })
      wx.hideLoading()
      const msg = (e && (e.msg || e.message)) || '登录失败，请稍后重试'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  toggleAgree() {
    this.setData({ agreeProtocol: !this.data.agreeProtocol })
  },

  editProfile() {
    const ui = this.data.userInfo || {}
    // 强制显示完善资料卡片并展开，让用户编辑头像和昵称
    this.setData({
      needFixProfile: true,
      showFixer: true,
      fixAvatar: ui.avatar_url || '',
      fixNick: !this._isDefaultNick(ui.nickname) ? (ui.nickname || '') : ''
    }, () => {
      // 等 DOM 渲染完成后再滚动到卡片位置
      setTimeout(() => {
        try {
          wx.pageScrollTo({ selector: '.profile-fixer-card', duration: 280 })
        } catch(e) {}
      }, 120)
    })
  },

  logout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出吗？',
      confirmText: '退出',
      confirmColor: '#FF6B6B',
      success: (r) => {
        if (r.confirm) {
          wx.removeStorageSync('token')
          wx.removeStorageSync('userInfo')
          wx.removeStorageSync('coupleInfo')
          app.globalData.token = ''
          app.globalData.userInfo = null
          app.globalData.coupleInfo = null
          this.setData({ pendingAvatar: '', pendingNick: '' })
          this.refreshLogin()
        }
      }
    })
  },

  async subscribe() {
    try {
      // 1. 获取模板 ID
      const tplIds = await app.request({ url: '/api/subscribe/templates' })
      const ids = []
      if (tplIds && tplIds.alert) ids.push(tplIds.alert)
      if (tplIds && tplIds.report) ids.push(tplIds.report)
      if (tplIds && tplIds.greeting) ids.push(tplIds.greeting)

      if (!ids.length) {
        wx.showModal({
          title: '模板未配置',
          content: '订阅消息模板尚未配置，请先在微信公众平台申请订阅消息模板，然后通过管理员接口配置模板 ID。',
          showCancel: false,
          confirmText: '知道了'
        })
        return
      }

      // 2. 调起微信订阅授权
      const res = await new Promise((resolve, reject) => {
        wx.requestSubscribeMessage({
          tmplIds: ids,
          success: resolve,
          fail: reject
        })
      })

      // 3. 解析授权结果
      const subscribed = { alert: false, report: false, greeting: false }
      if (tplIds.alert && res[tplIds.alert] === 'accept') subscribed.alert = true
      if (tplIds.report && res[tplIds.report] === 'accept') subscribed.report = true
      if (tplIds.greeting && res[tplIds.greeting] === 'accept') subscribed.greeting = true

      const anyAccepted = subscribed.alert || subscribed.report || subscribed.greeting
      if (!anyAccepted) {
        wx.showToast({ title: '未授权订阅', icon: 'none' })
        return
      }

      // 4. 保存到后端
      await app.request({
        url: '/api/subscribe/save',
        method: 'POST',
        data: subscribed
      })

      const names = []
      if (subscribed.alert) names.push('气象预警')
      if (subscribed.report) names.push('气候报告')
      if (subscribed.greeting) names.push('TA的问候')
      wx.showToast({ title: '已订阅：' + names.join('、'), icon: 'none', duration: 2500 })

      // 5. 刷新订阅状态
      this.loadSubscribeStatus()
    } catch (e) {
      const msg = (e && (e.errMsg || e.msg || e.message)) || '订阅失败'
      if (msg.includes('cancel')) {
        wx.showToast({ title: '已取消', icon: 'none' })
      } else {
        wx.showToast({ title: String(msg).slice(0, 40), icon: 'none', duration: 2000 })
      }
    }
  },

  async loadSubscribeStatus() {
    try {
      const res = await app.request({ url: '/api/subscribe/status' })
      if (res && res.status) {
        this.setData({ subscribeStatus: res.status })
      }
    } catch (_) {}
  },

  async testSubscribe() {
    try {
      wx.showLoading({ title: '发送中…', mask: true })
      const res = await app.request({ url: '/api/subscribe/test', method: 'POST' })
      wx.hideLoading()
      wx.showModal({
        title: '测试已发送',
        content: res.msg || '请留意微信「服务通知」',
        showCancel: false,
        confirmText: '知道了'
      })
      this.loadSubscribeStatus()
    } catch (e) {
      wx.hideLoading()
      const msg = (e && (e.msg || e.message)) || '测试发送失败'
      wx.showModal({
        title: '发送失败',
        content: String(msg),
        showCancel: false,
        confirmText: '知道了'
      })
    }
  },

  toggleLocVisible() {
    const next = !this.data.locVisible
    this.setData({ locVisible: next })
  },

  forceShowLogin() {
    wx.removeStorageSync('token')
    wx.removeStorageSync('coupleInfo')
    app.globalData.token = ''
    app.globalData.coupleInfo = null
    this.setData({
      isLogin: false,
      pendingAvatar: '',
      pendingNick: '',
      _authFailed: false,
      coupleInfo: null,
      kpi: { days: 0, sunny: 0, rainbow: 0 },
      showFixer: false,
      fixAvatar: '',
      fixNick: '',
      fixerSaving: false,
      needFixProfile: false
    })
  },

  goAlert() { wx.navigateTo({ url: '/pages/alert/alert' }) },
  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }) },
  goVip() { wx.navigateTo({ url: '/pages/vip/vip' }) },
  goQuiz() { wx.navigateTo({ url: '/pages/quiz/quiz' }) },
  goBill() { wx.navigateTo({ url: '/pages/bill/bill' }) },
  goSport() { wx.navigateTo({ url: '/pages/sport/sport' }) },
  goTimer() { wx.navigateTo({ url: '/pages/timer/timer' }) },
  goPeriod() { wx.navigateTo({ url: '/pages/period/period' }) },
  goCook() { wx.navigateTo({ url: '/pages/cook/cook' }) },
  goCalendar() { wx.switchTab({ url: '/pages/calendar/calendar' }) },
  goReport() { wx.navigateTo({ url: '/pages/report/report' }) },
  goWish() { wx.navigateTo({ url: '/pages/wish/wish' }) },
  goLocation() { wx.navigateTo({ url: '/pages/location/location' }) },
  goShareSet() { wx.navigateTo({ url: '/pages/share/share' }) },

  // ========== 用户协议 / 隐私政策 / 关于情侣心情录 ==========
  openAgreement() {
    const content = [
      '【用户协议（情侣心情录 v1.0.0）】',
      '',
      '欢迎使用「情侣心情录·情侣气象站」💕',
      '本协议是你与情侣心情录团队之间，关于使用本小程序服务所订立的协议。',
      '',
      '一、服务内容',
      '· 情侣绑定与邀请码关联',
      '· 每日心情天气记录、双方天气合成',
      '· 共同日历、月度气候报告、心愿清单、纪念日提醒、定位共享、海报卡片生成与保存',
      '',
      '二、账号规则',
      '· 你使用微信一键登录后，系统会为你生成唯一的用户标识',
      '· 你仅可绑定一对情侣关系，解绑后可用同一邀请码重新绑定',
      '· 请勿将账号转借给他人使用，否则由此产生的后果由你自行承担',
      '',
      '三、用户行为规范',
      '· 不得在昵称、头像、心情、心愿、备注中发布违法、侵权、低俗、辱骂等内容',
      '· 不得利用本小程序从事任何违反法律法规或公序良俗的行为',
      '',
      '四、数据与版权',
      '· 你上传的昵称、头像、心情、定位等信息，仅用于你和绑定的情侣之间展示，不会向未绑定的第三方公开',
      '· 本小程序内所有文案、图标、UI 设计的知识产权归情侣心情录团队所有',
      '',
      '五、服务变更、中断与终止',
      '· 因业务调整，情侣心情录团队可能会对部分服务内容做变更，届时将在小程序内公告',
      '· 若你严重违反本协议，我们有权中止或终止向你提供服务',
      '',
      '六、免责声明',
      '· 本小程序仅为记录和辅助情感沟通之用，不构成任何法律、医疗、心理层面的建议',
      '· 因网络波动、微信平台策略变化等不可抗力导致的服务中断，情侣心情录团队不承担责任',
      '',
      '七、协议更新',
      '· 本协议如有更新，将通过小程序公告或弹窗方式提醒你。继续使用即视为同意最新版本。',
      '',
      '八、联系我们',
      '· 任何问题或建议，可在小程序内向我们反馈，或通过公众号「情侣心情录」联系我们。',
      '',
      '最后更新日期：2026年8月'
    ].join('\n')
    wx.showModal({
      title: '用户协议',
      content,
      showCancel: false,
      confirmText: '我已阅读',
      confirmColor: '#FF8FAB'
    })
  },

  openPrivacy() {
    const content = [
      '【隐私政策（情侣心情录 v1.0.0）】',
      '',
      '我们非常重视你的隐私，承诺按法律法规保护你的个人信息。你使用本小程序，即代表同意本政策内容。',
      '',
      '一、我们收集的信息',
      '1) 微信登录信息',
      '· 使用 wx.login 获取你的微信 openid（匿名标识，非手机号），用于生成账号、情侣关系绑定',
      '· 你主动授权选择的微信头像和微信昵称，将作为你在小程序内的公开资料',
      '',
      '2) 你主动填写的数据',
      '· 每日心情天气（天气、温度、能见度、备注文字）',
      '· 心愿清单、纪念日/生日提醒、定位（仅你主动开启时采集经纬度）',
      '',
      '3) 设备与日志',
      '· 为了排查故障，服务端会记录少量请求日志（请求时间、接口、状态码），不记录微信密码等敏感信息',
      '',
      '二、我们如何使用信息',
      '· 用于你和绑定情侣之间的互相展示、合成共同天气、生成日历/报告/海报',
      '· 用于纪念日提醒、消息订阅推送（只有你主动订阅时才会推送）',
      '· 用于改进产品体验，例如统计打卡率，但不会把你的个人内容公开给第三方',
      '',
      '三、信息存储与安全',
      '· 你的数据存储在经 HTTPS 加密传输的云端服务（Cloudflare D1）',
      '· 我们采取合理的技术和管理手段（访问权限控制、传输加密等）保障信息安全',
      '',
      '四、信息共享',
      '· 除以下情况外，我们不会向任何第三方出售、出租或披露你的个人信息：',
      '   a) 法律法规要求或有权机关的合法请求；',
      '   b) 为完成服务所必需的第三方（例如 HTTPS 云服务商，均受保密协议约束）。',
      '',
      '五、你的权利',
      '· 查看权：在「我的」页可随时查看你的资料',
      '· 修改权：在「编辑资料」中随时更换头像昵称、修改打卡内容',
      '· 删除权：可申请注销账号，删除后我们将按法规要求匿名化处理相关数据',
      '· 撤回同意：关闭定位权限、取消订阅消息授权等，可在微信「设置 → 权限管理」中操作',
      '',
      '六、未成年人保护',
      '· 若你是未满14周岁的未成年人，请在监护人陪同下阅读本政策并使用本小程序',
      '',
      '七、政策更新',
      '· 隐私政策如有变更，我们会在小程序内弹窗或公告提示你。',
      '',
      '八、联系我们',
      '· 如有隐私相关问题、投诉或申请注销，请通过公众号「情侣心情录」联系我们，我们会在 15 个工作日内回复。',
      '',
      '最后更新日期：2026年8月'
    ].join('\n')
    wx.showModal({
      title: '隐私政策',
      content,
      showCancel: false,
      confirmText: '我已阅读',
      confirmColor: '#7A6BD6'
    })
  },

  openAbout() {
    const content = [
      '【关于情侣心情录 · 我们俩的私人天气台】',
      '',
      '品牌名：情侣心情录',
      '英文名：Couple Weather',
      '当前版本：v1.0.0',
      '上线时间：2026年',
      '',
      '🌤️  产品理念',
      '把两个人每天的心情，变成专属于你们的「天气」。',
      '晴、多云、阴、小雨、雷暴、彩虹——',
      '每一次打卡，都会合成彼此共享的「共同天气」，',
      '成为你们专属的气候记忆。',
      '',
      '💕  核心功能',
      '· 6 种心情天气 + 温度 / 能见度 / 120 字悄悄话',
      '· 双方天气自动合成（晴 + 多云 = 多云转晴，晴 + 彩虹 = 晴后彩虹…）',
      '· 情侣共享日历 + 月度气候报告（分布、连晴、报告分析）',
      '· 心愿清单（可切换「已实现」）+ 纪念日/生日倒计时预警',
      '· 双方定位共享 + 距离显示',
      '· 6 款海报风格一键保存到相册，或者转发给 TA',
      '',
      '🌈  产品小彩蛋',
      '· 10+ 条精选金句语录自动随机出现在今日心情卡上',
      '· 合成天气超过 20+ 种，双方打卡不同会自动碰撞出有趣天气名',
      '· 纪念日预警自动刷新，<=3天会在「我的」铃铛上小红点提醒',
      '',
      '🏗️  技术栈',
      '· 前端：微信小程序原生框架',
      '· 后端：Cloudflare Workers + D1 数据库',
      '· 接口域名：https://api.jdhsf.top',
      '',
      '✉️  联系与反馈',
      '· 如果你有功能建议 / bug 反馈 / 想加新的天气元素，',
      '    欢迎通过公众号「情侣心情录」告诉我们～',
      '',
      '特别感谢你使用情侣心情录 🌤️💕',
      '愿我们的天气，永远有彩虹。'
    ].join('\n')
    wx.showModal({
      title: '关于情侣心情录',
      content,
      showCancel: false,
      confirmText: '知道啦',
      confirmColor: '#FF8FAB'
    })
  }
})
