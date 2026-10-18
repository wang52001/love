const app = getApp()

Page({
  data: {
    dateStr: '',
    streak: 0,
    moodList: [],
    selectedKey: '',
    selected: null,
    tempVal: 24,
    visibility: 70,
    note: '',
    taRating: 0,
    taRatingText: '',
    taMood: null,
    taRatingForMe: null,
    mergeResult: null,
    realWeather: null,
    submitting: false,
    submitted: false,
    showCustomPicker: false,
    customEmoji: '',
    customName: ''
  },

  onLoad() {
    this.setData({
      dateStr: app.formatDate(new Date(), 'MM月DD日') + ' · ' + ['周日','周一','周二','周三','周四','周五','周六'][new Date().getDay()],
      moodList: this.buildMoodList()
    })
    this.refresh()
  },

  onShow() { this.refresh() },

  buildMoodList() {
    const map = app.globalData.emotionMap
    return Object.keys(map).map(k => ({
      key: k,
      emoji: map[k].emoji,
      name: map[k].name,
      color1: map[k].color1,
      color2: map[k].color2,
      text: map[k].text,
      category: map[k].category
    }))
  },

  async refresh() {
    try {
      const weather = await app.getWeatherToday() || {}
      if (weather && weather.my_mood && weather.my_mood.weather) {
        const selected = this.data.moodList.find((m) => m.key === weather.my_mood.weather)
        this.setData({
          selectedKey: weather.my_mood.weather,
          selected: selected || { key: weather.my_mood.weather, emoji: '🌟', name: weather.my_mood.weather, color1: '#B0C4DE', color2: '#E6EEF8', text: '#3A4A66' },
          note: weather.my_mood.note || '',
          tempVal: Number(weather.my_mood.temperature) || 24,
          visibility: Number(weather.my_mood.visibility) || 70,
          taRating: Number(weather.my_mood.ta_rating) || 0,
          taRatingText: this.ratingText(Number(weather.my_mood.ta_rating) || 0),
          submitted: true
        })
        this.computeMerge()
      }
      if (weather && weather.ta_mood && weather.ta_mood.weather) {
        const tm = this.data.moodList.find((m) => m.key === weather.ta_mood.weather)
        this.setData({
          taMood: tm ? { ...tm, note: weather.ta_mood.note || '' } : { key: weather.ta_mood.weather, emoji: '🌟', name: weather.ta_mood.weather, color1: '#B0C4DE', color2: '#E6EEF8', text: '#3A4A66', note: weather.ta_mood.note || '' },
          taRatingForMe: Number(weather.ta_mood.ta_rating) || 0
        })
        this.computeMerge()
      }
      const kpi = await app.getProfileKpi() || {}
      if (kpi) this.setData({ streak: kpi.streak || 0 })

      // 获取真实天气
      const rw = await app.fetchRealWeather()
      if (rw) this.setData({ realWeather: rw })
    } catch (e) {}
  },

  selectMood(e) {
    const key = e.currentTarget.dataset.key
    const selected = this.data.moodList.find((m) => m.key === key)
    this.setData({
      selectedKey: key,
      selected,
      submitted: false
    }, () => this.computeMerge())
  },

  ratingText(r) {
    if (r <= 0) return '还没打分'
    if (r === 1) return '今天不太行 😅'
    if (r === 2) return '还需努力 🤔'
    if (r === 3) return '还行吧 😊'
    if (r === 4) return '表现不错 💪'
    if (r === 5) return '太棒了 🏆'
    return ''
  },

  onRatingTap(e) {
    const r = Number(e.currentTarget.dataset.r) || 0
    const newRating = this.data.taRating === r ? 0 : r
    this.setData({
      taRating: newRating,
      taRatingText: this.ratingText(newRating),
      submitted: false
    })
  },

  onNoteInput(e) { this.setData({ note: e.detail.value }) },

  onTempChange(e) { this.setData({ tempVal: Number(e.detail.value) || 24 }) },

  onVisChange(e) { this.setData({ visibility: Number(e.detail.value) || 70 }) },

  computeMerge() {
    const my = this.data.selectedKey
    const ta = (this.data.taMood && this.data.taMood.key) || ''
    if (!my) return
    const merge = app.getMergeMood(my, ta)
    const quotes = app.globalData.quotes
    const quote = quotes[Math.floor(Math.random() * quotes.length)]
    this.setData({
      mergeResult: {
        name: merge.name,
        emoji: merge.emoji,
        colors: merge.colors,
        text: merge.text,
        quoteColor: 'rgba(255,255,255,0.85)',
        quote
      }
    })
  },

  async submitMood() {
    const { selectedKey, note, submitted, submitting } = this.data
    if (!selectedKey) {
      wx.showToast({ title: '先选一个心情吧 🌸', icon: 'none' })
      return
    }
    if (submitting) return

    const payload = {
      weather: selectedKey,
      note: (note || '').slice(0, 120),
      temperature: Number(this.data.tempVal) || 24,
      visibility: Number(this.data.visibility) || 70,
      ta_rating: this.data.taRating || null,
      record_date: ''
    }

    this.setData({ submitting: true })
    try {
      const saved = await app.submitMood(payload)
      this.setData({ submitting: false, submitted: true, _lastError: null })
      wx.showToast({ title: saved && saved.shared_weather ? `合成：${saved.shared_weather} 💕` : '已发给 TA 💕', icon: 'none' })
      this.refresh()
    } catch (e) {
      this.setData({ submitting: false })
      const code = Number(e && e.code)
      const statusCode = Number(e && e.statusCode)
      const msg = (e && (e.msg || e.message || e.errMsg)) + ''
      let title = '提交失败'
      let lines = ['点下方「重试一次」重新发送，或换网络再试']
      if (code === 400) {
        if (/请先绑定|绑定|情侣|couple/i.test(msg)) {
          title = '还没绑定情侣 💕'
          lines = ['先去「我的 → 邀请码绑定」生成或输入TA的邀请码', '绑定成功后就能发啦 🌸']
        } else {
          lines = [msg || '请求参数错误']
        }
      } else if (code === 401 || statusCode === 401) {
        title = '需要重新微信登录'
        lines = ['点「去登录」，登录后回来再发一次']
      } else if (msg) {
        lines.unshift('错误信息：' + msg.substring(0, 100))
      }

      wx.showModal({
        title,
        content: lines.join('\n'),
        showCancel: true,
        cancelText: code === 401 ? '取消' : '关闭',
        confirmText: code === 401 ? '去登录' : '重试一次',
        success: (r) => {
          if (!r.confirm) return
          if (code === 401 || statusCode === 401) {
            wx.removeStorageSync('token')
            wx.removeStorageSync('userInfo')
            wx.removeStorageSync('coupleInfo')
            app.globalData.token = ''
            app.globalData.userInfo = null
            app.globalData.coupleInfo = null
            wx.switchTab({ url: '/pages/profile/profile' })
            return
          }
          if (code === 400 && /请先绑定|绑定|情侣|couple/i.test(msg)) {
            wx.switchTab({
              url: '/pages/profile/profile',
              success: () => setTimeout(() => wx.navigateTo({ url: '/pages/bind/bind' }), 150)
            })
            return
          }
          this.submitMood()
        }
      })
    }
  },

  goShare() { wx.navigateTo({ url: '/pages/share/share' }) },

  onShareAppMessage() {
    const wname = this.data.selected ? this.data.selected.name : '今天的心情'
    return {
      title: '💕 情侣心情录｜今天给你发了一朵：' + wname + ' 🌸',
      path: '/pages/profile/profile'
    }
  },

  onShareTimeline() {
    const wname = this.data.selected ? this.data.selected.name : '今天的心情'
    return { title: '情侣心情录｜' + wname + ' ✨' }
  }
})
