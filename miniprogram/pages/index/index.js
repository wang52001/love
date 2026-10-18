const app = getApp()

Page({
  data: {
    isGuest: false,
    togetherDays: 0,
    heroColors: ['#B0C4DE', '#E6EEF8'],
    heroTextColor: '#3A4A66',
    heroQuoteColor: 'rgba(58, 74, 102, 0.8)',
    todayWeather: {
      emoji: '⛅',
      name: '今天还没有心情记录哦',
      quote: ''
    },
    partialHint: '',
    hasRecordedToday: false,
    coupleInfo: null,
    weekData: [],
    alertInfo: null,
    wishInfo: null,
    coupleWeather: null,
    taRating: 0,
    myRating: 0,
    aiReport: '',
    aiShared: '',
    aiReportTip: '',
    aiReportLoading: false,
    aiReportLoadingTask: null
  },

  onLoad() {
    this.loadAll(true)
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      try { this.getTabBar().setData({ selected: 0 }) } catch(e) {}
    }
    this.loadAll(false)
  },

  onPullDownRefresh() {
    this.loadAll(true).finally(() => wx.stopPullDownRefresh())
  },

  async loadAll(showLoading) {
    const userInfo = wx.getStorageSync('userInfo')
    const token = wx.getStorageSync('token')
    // 游客模式：未登录时不跳转，正常浏览首页
    if (!userInfo || !token) {
      this.setData({
        isGuest: true,
        coupleInfo: null,
        togetherDays: 0,
        todayWeather: {
          emoji: '🌤️',
          name: '欢迎来到情侣心情录',
          quote: '登录后，和 TA 一起记录每天的心情 ~'
        },
        heroColors: ['#FFD6E4', '#E8E0FF'],
        heroTextColor: '#5A3D66',
        heroQuoteColor: 'rgba(90, 61, 102, 0.75)',
        hasRecordedToday: false,
        weekData: [],
        alertInfo: null,
        wishInfo: null,
        partialHint: ''
      })
      return
    }
    this.setData({ isGuest: false })
    if (showLoading) wx.showLoading({ title: '加载中…', mask: true })

    try {
      const [couple, weather] = await Promise.all([
        app.getBindInfo().then((c) => {
          if (c) {
            wx.setStorageSync('coupleInfo', c)
            app.globalData.coupleInfo = c
            this.setData({ coupleInfo: c })
            if (c.bind_date) {
              const days = app.daysBetween(c.bind_date, new Date()) + 1
              this.setData({ togetherDays: days })
            }
            this.setBindAlert(c)
          } else {
            this.setData({ bindAlert: null })
          }
          return c
        }),
        app.getWeatherToday()
      ])

      if (weather) {
        const sharedName = weather.shared_name
        if (sharedName) {
          // today 接口的 shared_name 仅在双方都记录时才返回合成天气
          const meta = app.getEmotionMeta(sharedName)
          this.setData({
            todayWeather: {
              emoji: meta.emoji,
              name: meta.name,
              quote: weather.shared_quote || ''
            },
            heroColors: meta.colors,
            heroTextColor: meta.text,
            heroQuoteColor: meta.text + 'CC',
            partialHint: ''
          })
        } else if (weather.my_mood || weather.ta_mood) {
          const partial = weather.my_mood ? weather.my_mood : (weather.ta_mood || {})
          const meta = app.getEmotionMeta(partial.weather)
          const who = weather.my_mood ? 'TA 还没记' : '你还没记'
          this.setData({
            todayWeather: {
              emoji: meta.emoji,
              name: '等待另一半的心情汇入',
              quote: weather.shared_quote || ''
            },
            heroColors: meta.colors,
            heroTextColor: meta.text,
            heroQuoteColor: meta.text + 'BB',
            partialHint: who + '，点下面按钮一起打卡吧 🌸'
          })
        } else {
          this.setData({
            todayWeather: {
              emoji: '🌤️',
              name: '今天还没有心情记录哦',
              quote: '点下面按钮来记录今天的第一朵云吧～'
            },
            heroColors: ['#FFD6E4', '#E8E0FF'],
            heroTextColor: '#5A3D66',
            heroQuoteColor: 'rgba(90, 61, 102, 0.75)',
            partialHint: ''
          })
        }
        this.setData({ hasRecordedToday: !!(weather.my_mood && weather.my_mood.recorded_at) })

        // 提取评分
        if (weather.my_mood) this.setData({ taRating: Number(weather.my_mood.ta_rating) || 0 })
        if (weather.ta_mood) this.setData({ myRating: Number(weather.ta_mood.ta_rating) || 0 })

        // 获取双方真实天气
        try {
          const cw = await app.fetchCoupleWeather()
          if (cw) this.setData({ coupleWeather: cw })
        } catch (_) {}
      }

      const weekRes = await app.getWeatherWeek()
      const weekDays = app.toArr((weekRes && weekRes.days) || weekRes)
      const weekData = weekDays.map((d) => {
        const ds = d.date || ''
        const dateObj = ds ? new Date(ds + 'T00:00:00') : new Date()
        const weatherName = d.shared || d.weather || null
        const meta = weatherName ? app.getEmotionMeta(weatherName) : null
        const isToday = app.formatDate(new Date()) === (ds || app.formatDate(new Date()))
        return {
          date: ds,
          label: isToday ? '今' : ['日','一','二','三','四','五','六'][dateObj.getDay()],
          dayNum: dateObj.getDate(),
          monthDay: `${dateObj.getMonth() + 1}/${dateObj.getDate()}`,
          weather: weatherName,
          emoji: meta ? meta.emoji : '',
          colors: meta ? meta.colors : ['#F0E8EE', '#F7F2F4'],
          textColor: meta ? meta.text : '#5D5168',
          my: d.my || null,
          ta: d.ta || null,
          isToday
        }
      })
      this.setData({ weekData })

      const alerts = app.toArr(await app.getAlertList())
      if (alerts.length) {
        alerts.sort((a, b) => Number(a.days_left) - Number(b.days_left))
        const top = alerts[0]
        const days = Number(top.days_left != null ? top.days_left : top.days)
        let icon = '🎁', type = 'rainbow', title = top.title || top.name || '重要日子', desc = '还有 ' + days + ' 天'
        if (days <= 0) { icon = '🎉'; type = 'sunny'; desc = '就是今天！' }
        else if (days <= 3) { icon = '⚠️'; type = 'rainy'; desc = '还有 ' + days + ' 天，记得准备礼物呀' }
        else { desc = '还有 ' + days + ' 天：' + (top.note || top.content || '标记了哦') }
        this.setData({ alertInfo: { icon, type, title, desc } })
      } else {
        this.setData({ alertInfo: null })
      }

      const wishes = app.toArr(await app.getWishList())
      if (wishes.length) {
        const pending = wishes.filter((w) => w.status !== 'done' && w.status !== 'fulfilled' && Number(w.fulfilled) !== 1)
        const w = pending[0] || wishes[0]
        const weatherName = w.weather || w.wish_weather || '心动'
        const meta = app.getEmotionMeta(weatherName)
        this.setData({
          wishInfo: {
            emoji: meta.emoji,
            weather: weatherName,
            reason: w.reason || w.content || w.title || ''
          }
        })
      } else {
        this.setData({ wishInfo: null })
      }
    } catch (e) {
      // 不打印带对象的 console.error，避免 DevTools 把对象格式化成 [] [object Object]
      const msg = (e && (e.msg || e.message)) || '首页数据加载失败'
      wx.showToast({ title: msg, icon: 'none', duration: 1500 })
    }
    if (showLoading) wx.hideLoading()

    // AI 心情日报：非游客且已绑定时加载（不阻塞主流程）
    this.loadAIReport(false)
  },

  noop() {},

  async loadAIReport(forceRefresh) {
    if (this.data.isGuest) return
    const couple = this.data.coupleInfo
    if (!couple || !couple.bind_date) {
      this.setData({ aiReport: '', aiShared: '', aiReportTip: '绑定情侣后，AI 会为你们生成专属心情日报 ✨' })
      return
    }
    if (this.data.aiReportLoading) return
    this.setData({ aiReportLoading: true, aiReport: forceRefresh ? '' : this.data.aiReport, aiReportTip: '' })
    try {
      const res = await app.getAIMoodReport()
      if (res) {
        const report = res.report || ''
        const tip = res.tip || ''
        if (report) {
          this.setData({ aiReport: report, aiShared: res.shared || '', aiReportTip: '', aiReportLoading: false })
        } else {
          this.setData({ aiReport: '', aiShared: '', aiReportTip: tip || '今天还没有心情记录哦，记一笔让 AI 写日报吧 🌤️', aiReportLoading: false })
        }
      } else {
        this.setData({ aiReport: '', aiShared: '', aiReportTip: 'AI 小憩一下，稍后再来～', aiReportLoading: false })
      }
    } catch (e) {
      this.setData({ aiReport: '', aiShared: '', aiReportTip: 'AI 走神了，点这里重试 ↻', aiReportLoading: false })
    }
  },

  refreshAIReport() {
    this.loadAIReport(true)
  },

  setBindAlert(c) {
    if (!c || c.bound) {
      this.setData({ bindAlert: null })
      return
    }
    const isA = c.is_a !== false
    const taName = (c.ta && c.ta.nickname) || 'TA'
    if (c.pending) {
      this.setData({
        bindAlert: {
          type: 'pending',
          icon: '⏳',
          title: isA ? taName + ' 申请和你绑定' : '等待 TA 确认绑定',
          desc: isA ? 'TA 输入了你的邀请码，点击处理' : '已发送申请，TA 确认后即可绑定',
          action: 'goBind'
        }
      })
    } else if (c.rejected) {
      this.setData({
        bindAlert: {
          type: 'rejected',
          icon: '💔',
          title: isA ? '你已拒绝绑定申请' : taName + ' 拒绝了绑定申请',
          desc: isA ? '点击重新生成邀请码再试一次' : '点击重新输入邀请码',
          action: 'goBind'
        }
      })
    } else {
      this.setData({ bindAlert: null })
    }
  },

  goMood() {
    if (this.data.isGuest) { this.guestHint(); return }
    wx.navigateTo({ url: '/pages/mood/mood' })
  },
  goCalendar() { wx.switchTab({ url: '/pages/calendar/calendar' }) },
  goReport() {
    if (this.data.isGuest) { this.guestHint(); return }
    wx.navigateTo({ url: '/pages/report/report' })
  },
  goLocation() {
    if (this.data.isGuest) { this.guestHint(); return }
    wx.navigateTo({ url: '/pages/location/location' })
  },
  goWeatherDetail(e) {
    if (this.data.isGuest) { this.guestHint(); return }
    const { lat, lon, city, address } = e.currentTarget.dataset
    if (!lat || !lon) {
      wx.showToast({ title: '缺少位置信息', icon: 'none' })
      return
    }
    const url = '/pages/weather-detail/weather-detail?lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lon) + '&city=' + encodeURIComponent(city || '') + '&address=' + encodeURIComponent(address || '')
    wx.navigateTo({ url })
  },
  goWish() {
    if (this.data.isGuest) { this.guestHint(); return }
    wx.navigateTo({ url: '/pages/wish/wish' })
  },
  goAlert() {
    if (this.data.isGuest) { this.guestHint(); return }
    wx.navigateTo({ url: '/pages/alert/alert' })
  },
  goShare() {
    if (this.data.isGuest) { this.guestHint(); return }
    wx.navigateTo({ url: '/pages/share/share' })
  },
  goBind() {
    if (this.data.isGuest) { this.guestHint(); return }
    wx.navigateTo({ url: '/pages/bind/bind' })
  },
  guestHint() {
    wx.showModal({
      title: '登录后体验',
      content: '这个功能需要登录后才能使用哦，去「我的」页面登录吧 ~',
      confirmText: '去登录',
      confirmColor: '#FF8FAB',
      success: (r) => { if (r.confirm) wx.switchTab({ url: '/pages/profile/profile' }) }
    })
  },
  goLogin() {
    wx.switchTab({ url: '/pages/profile/profile' })
  },

  onShareAppMessage() {
    const coupleInfo = wx.getStorageSync('coupleInfo') || {}
    const weatherName = this.data.todayWeather && this.data.todayWeather.name ? this.data.todayWeather.name : '今天的心情是秘密'
    const extra = (coupleInfo.bind_date ? ('· 在一起第 ' + this.data.togetherDays + ' 天 💕') : '')
    return {
      title: '💕 情侣心情录｜' + weatherName + ' ' + extra,
      path: '/pages/profile/profile'
    }
  },

  onShareTimeline() {
    const weatherName = this.data.todayWeather && this.data.todayWeather.name ? this.data.todayWeather.name : '我们今天的心情'
    return { title: '情侣心情录｜' + weatherName + ' ✨' }
  }
})
