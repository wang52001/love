const app = getApp()

// 官方示例：基础库 >= 2.19.2 才支持 wx.requestVirtualPayment
function canUseVirtualPay() {
  try {
    if (wx.canIUse('requestVirtualPayment')) return true
    const v = String(wx.getSystemInfoSync().SDKVersion || '').split('.').map(Number)
    const base = [2, 19, 2]
    for (let i = 0; i < 3; i++) {
      if ((v[i] || 0) > base[i]) return true
      if ((v[i] || 0) < base[i]) return false
    }
    return true
  } catch (_) { return false }
}

// 官方要求：iOS 端需微信客户端 >= 8.0.68
function checkIosWechatVersion() {
  try {
    const sys = wx.getSystemInfoSync()
    if (sys.platform !== 'ios') return true
    const cur = String(sys.version || '').split('.').map(Number)
    const base = [8, 0, 68]
    for (let i = 0; i < 3; i++) {
      if ((cur[i] || 0) > base[i]) return true
      if ((cur[i] || 0) < base[i]) break
    }
    return false
  } catch (_) { return true }
}

Page({
  data: {
    isLogin: true,
    isVip: false,
    expiresLabel: '',
    daysLeft: 0,
    tiers: [],
    mode: 'sandbox',
    orders: [],
    perks: [
      { id: 'badge', emoji: '💎', title: '专属会员徽章', desc: '「我的」页闪耀展示你们的爱' },
      { id: 'style', emoji: '🎨', title: '会员专属心情卡风格', desc: '限定样式持续上新（敬请期待）' },
      { id: 'bless', emoji: '💌', title: '节日祝福模板', desc: '会员专属节日贺卡模板（敬请期待）' },
      { id: 'support', emoji: '❤️', title: '支持我们', desc: '你的支持让我们持续开发新功能' }
    ],
    buying: false
  },

  onShow() {
    const token = wx.getStorageSync('token')
    this.setData({ isLogin: !!token })
    if (token) this.refresh()
  },

  goLogin() {
    try { wx.switchTab({ url: '/pages/profile/profile' }) } catch (_) {}
  },

  async refresh() {
    try {
      const info = await app.getVipInfo()
      if (info) {
        this.setData({
          isVip: !!info.is_vip,
          daysLeft: Number(info.days_left) || 0,
          expiresLabel: String(info.expires_at || '').slice(0, 10),
          tiers: app.toArr(info.tiers),
          mode: info.mode || 'sandbox'
        })
      }
      const ord = await app.getVipOrders()
      const list = app.toArr(ord && ord.list).map((o) => ({
        ...o,
        dateLabel: String(o.created_at || '').slice(0, 10),
        statusLabel: o.status === 'paid' ? '已支付' : (o.status === 'sandbox_paid' ? '模拟支付 · 已开通' : '待支付'),
        statusPaid: o.status === 'paid' || o.status === 'sandbox_paid'
      }))
      this.setData({ orders: list })
    } catch (e) {}
  },

  async onBuy(e) {
    if (this.data.buying) return
    const tier = e.currentTarget.dataset.tier
    const t = this.data.tiers.find((x) => x.tier === tier)
    if (!t) return
    if (this.data.mode === 'wechat' && !t.available) {
      app.safeToast({ title: '该套餐道具暂未配置，请联系开发者', icon: 'none' })
      return
    }
    this.setData({ buying: true })
    try {
      const order = await this.createOrder(tier)
      if (order.mode === 'wechat') {
        await this.payWithWechat(order)
      } else {
        await this.paySandbox(order, t)
      }
    } catch (e) {
      const raw = String((e && (e.errMsg || e.msg || e.message)) || '支付失败，请重试')
      if (!/cancel/i.test(raw)) {
        app.safeToast({ title: raw.slice(0, 60), icon: 'none', duration: 2500 })
      }
    } finally {
      this.setData({ buying: false })
    }
  },

  // 下单：真实模式先取新 wx.login code，让后端刷新 session_key 用于用户态签名
  createOrder(tier) {
    return new Promise(async (resolve, reject) => {
      try {
        let code = ''
        if (this.data.mode === 'wechat') {
          code = await new Promise((r, j) => {
            try {
              wx.login({ success: (res) => r(res.code || ''), fail: j })
            } catch (e) { r('') }
          })
        }
        const order = await app.createPayOrder(tier, code)
        if (!order || !order.out_trade_no) throw new Error('下单失败，请重试')
        resolve(order)
      } catch (e) { reject(e) }
    })
  },

  // 沙盒模拟支付（未开通虚拟支付能力时：不产生真实扣款，点击确认即开通）
  paySandbox(order, t) {
    return new Promise((resolve, reject) => {
      try {
        wx.showModal({
          title: '模拟支付（沙盒）',
          content: '当前尚未开通微信虚拟支付能力，本次为沙盒模拟支付，不产生真实扣款。确认后立即开通「' + (t ? t.name : '会员') + '」💎',
          confirmText: '确认开通',
          confirmColor: '#FF8FAB',
          success: async (r) => {
            if (!r || !r.confirm) {
              app.safeToast({ title: '已取消', icon: 'none' })
              resolve(null)
              return
            }
            try {
              await app.confirmPay(order.out_trade_no)
              app.safeToast({ title: '开通成功 💎', icon: 'none' })
              this.refresh()
              resolve(null)
            } catch (err) { reject(err) }
          },
          fail: () => resolve(null)
        })
      } catch (e) { resolve(null) }
    })
  },

  // 真实微信虚拟支付（官方流程：服务端已返回 signData + paySig + signature）
  payWithWechat(order) {
    return new Promise((resolve, reject) => {
      if (typeof wx.requestVirtualPayment !== 'function' || !canUseVirtualPay()) {
        wx.showModal({
          title: '暂不支持虚拟支付',
          content: '当前微信版本基础库过低（要求 ≥ 2.19.2），请更新微信到最新版本后再购买。',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: '#FF8FAB'
        })
        resolve(null)
        return
      }
      if (!checkIosWechatVersion()) {
        wx.showModal({
          title: '提示',
          content: '请将微信更新至 8.0.68 及以上版本后再进行支付',
          showCancel: false,
          confirmText: '知道了',
          confirmColor: '#FF8FAB'
        })
        resolve(null)
        return
      }
      const pd = order.pay_data || {}
      if (!pd.signData || !pd.paySig || !pd.signature) {
        reject(new Error('支付参数缺失，请稍后重试'))
        return
      }
      try {
        wx.requestVirtualPayment({
          signData: pd.signData,
          mode: pd.mode || 'short_series_goods',
          paySig: pd.paySig,
          signature: pd.signature,
          success: async () => {
            // 官方提示：success 回调可能丢失，最终以服务端查单/发货推送为准
            try {
              const r = await app.queryPayOrder(order.out_trade_no)
              if (r && r.paid) {
                app.safeToast({ title: '开通成功 💎', icon: 'none' })
                this.refresh()
                resolve(null)
              } else {
                // 支付成功但查单未同步（一般几秒内），稍后再查一次
                setTimeout(async () => {
                  try {
                    const r2 = await app.queryPayOrder(order.out_trade_no)
                    if (r2 && r2.paid) {
                      app.safeToast({ title: '开通成功 💎', icon: 'none' })
                    } else {
                      app.safeToast({ title: '支付确认中，稍后自动到账', icon: 'none', duration: 2500 })
                    }
                    this.refresh()
                  } catch (_) { this.refresh() }
                  resolve(null)
                }, 3000)
              }
            } catch (err) { reject(err) }
          },
          fail: (err) => {
            const msg = String((err && err.errMsg) || '支付失败')
            const code = err && err.errCode
            if (code === -2 || /cancel/i.test(msg)) {
              app.safeToast({ title: '已取消', icon: 'none' })
            } else if (code === -15007) {
              app.safeToast({ title: '登录态已过期，请退出小程序后重新登录再购买', icon: 'none', duration: 3000 })
            } else if (code === -15013) {
              app.safeToast({ title: '道具价格配置有变动，请联系开发者', icon: 'none', duration: 3000 })
            } else if (code === -15010) {
              app.safeToast({ title: '会员商品刚上架，约10分钟后生效，稍后再试', icon: 'none', duration: 3000 })
            }
            reject({ message: msg, errMsg: msg })
          }
        })
      } catch (e) {
        reject(e)
      }
    })
  }
})
