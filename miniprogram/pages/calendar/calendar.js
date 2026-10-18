const app = getApp()

Page({
  data: {
    year: 2026,
    month: 8,
    weekdays: ['日', '一', '二', '三', '四', '五', '六'],
    calendarData: [],
    stats: { sunny: 0, rainy: 0, streak: 0, rainbow: 0 },
    selectedDate: null,
    realWeather: null,
    legendItems: [
      { key: 'positive', name: '积极', colors: ['#FF8FAB', '#FFD6E8'] },
      { key: 'neutral', name: '中性', colors: ['#B0C4DE', '#E6EEF8'] },
      { key: 'negative', name: '消极', colors: ['#7393B3', '#B4C7DA'] },
      { key: 'merge', name: '合成', colors: ['#FF6B9D', '#FFC5DC'] }
    ]
  },

  onLoad() {
    const now = new Date()
    this.setData({ year: now.getFullYear(), month: now.getMonth() + 1 }, () => this.buildCalendar())
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      try { this.getTabBar().setData({ selected: 1 }) } catch(e) {}
    }
    this.buildCalendar()
    this.loadRealWeather()
  },

  async loadRealWeather() {
    try {
      const rw = await app.fetchRealWeather()
      if (rw) this.setData({ realWeather: rw })
    } catch (e) {}
  },

  prevMonth() {
    let { year, month } = this.data
    month--
    if (month < 1) { month = 12; year-- }
    this.setData({ year, month, selectedDate: null }, () => this.buildCalendar())
  },

  nextMonth() {
    let { year, month } = this.data
    month++
    if (month > 12) { month = 1; year++ }
    this.setData({ year, month, selectedDate: null }, () => this.buildCalendar())
  },

  async buildCalendar() {
    try {
      const { year, month } = this.data
      const daysInMonth = new Date(year, month, 0).getDate()
      const firstDay = new Date(year, month - 1, 1).getDay()
      const today = app.formatDate(new Date())
      // 合成心情通过 app.getEmotionMeta 回退到基础情绪 emoji/颜色

      const cells = []
      for (let i = 0; i < firstDay; i++) cells.push({ empty: true, key: 'e' + i })

      const stats = { sunny: 0, rainy: 0, streak: 0, rainbow: 0 }
      let curStreak = 0, maxStreak = 0

      // 游客模式：未登录时直接渲染空日历
      const token = wx.getStorageSync('token')
      const dayMap = {}
      let calRes = {}
      if (token) {
        calRes = await app.getCalendar(year, month) || {}
        if (calRes && Array.isArray(calRes.days)) {
          calRes.days.forEach((d) => {
            const k = app.formatDate(d.date || d.day_key)
            if (k) dayMap[k] = d
          })
        }
      }

      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
        const isToday = dateStr === today
        const rec = dayMap[dateStr]
        // 后端返回 shared/my/ta，兼容旧字段 weather/my_weather/ta_weather
        const shared = (rec && (rec.shared || rec.weather)) || null
        const myR = (rec && rec.my) || null
        const taR = (rec && rec.ta) || null
        const myWeather = (myR && myR.weather) || shared || null
        const taWeather = (taR && taR.weather) || null
        const taRating = (taR && Number(taR.ta_rating)) || 0
        const weather = shared || myWeather || taWeather
        const note = (myR && myR.note) || (taR && taR.note) || (rec && rec.note) || ''

        const category = weather ? app.getEmotionCategory(weather) : null
        if (category === 'positive') { stats.sunny++; curStreak++; if (curStreak > maxStreak) maxStreak = curStreak }
        else { curStreak = 0 }
        if (category === 'negative') stats.rainy++
        if (myWeather && taWeather) stats.rainbow++

        const meta = weather ? app.getEmotionMeta(weather) : null
        cells.push({
          key: dateStr,
          empty: false,
          dateStr,
          dayNum: d,
          weather,
          myWeather: myWeather || weather,
          taWeather,
          taRating,
          note,
          emoji: meta ? meta.emoji : '',
          colors: meta ? meta.colors : ['#F4EFF2', '#F9F5F7'],
          textColor: meta ? meta.text : '#8B7A88',
          isToday
        })
      }

      stats.streak = maxStreak
      if (calRes && (calRes.stats || calRes.sunny !== undefined)) {
        stats.sunny = calRes.stats && calRes.stats.sunny ? calRes.stats.sunny : (calRes.sunny || stats.sunny)
        stats.rainy = calRes.stats && calRes.stats.rainy ? calRes.stats.rainy : (calRes.rainy || stats.rainy)
        stats.rainbow = calRes.stats && calRes.stats.rainbow ? calRes.stats.rainbow : (calRes.rainbow || stats.rainbow)
        stats.streak = calRes.stats && calRes.stats.streak ? calRes.stats.streak : (calRes.streak || stats.streak)
      }

      this.setData({ calendarData: app.toArr(cells), stats })
    } catch (e) {
      const msg = (e && (e.msg || e.message)) || '日历加载失败'
      app.safeToast({ title: msg, icon: 'none', duration: 1500 })
    }
  },

  async pickDate(e) {
    const dateStr = e.currentTarget.dataset.date
    if (!dateStr) return
    const cell = this.data.calendarData.find((c) => c.dateStr === dateStr)
    if (!cell || cell.empty) return

    const calendarData = this.data.calendarData.map((c) => {
      c.isSelected = c.dateStr === dateStr
      return c
    })

    const myW = cell.myWeather || cell.weather || '平静'
    const taW = cell.taWeather || (cell.weather ? cell.weather : '平静')
    const merge = app.getMergeMood(myW, taW)
    const myMeta = app.getEmotionMeta(myW)
    const taMeta = app.getEmotionMeta(taW)
    const taRating = cell.taRating || 0
    const taRatingStars = taRating ? '⭐'.repeat(taRating) : ''

    this.setData({
      calendarData,
      selectedDate: {
        display: `${this.data.year}年${this.data.month}月${cell.dayNum}日`,
        weatherName: cell.weather ? merge.name : null,
        emoji: cell.weather ? merge.emoji : '',
        myWeather: myW,
        myEmoji: myMeta.emoji,
        myColors: myMeta.colors,
        myNote: cell.note || null,
        taWeather: taW,
        taEmoji: taMeta.emoji,
        taColors: taMeta.colors,
        taNote: null,
        taRating,
        taRatingStars
      }
    })
  },

  goReport() {
    wx.navigateTo({ url: `/pages/report/report?year=${this.data.year}&month=${this.data.month}` })
  },

  onShareAppMessage() {
    const month = this.data.year + '年' + this.data.month + '月'
    return {
      title: '🌈 情侣心情录｜我们 '+ month +' 的心情日历，每一页都是回忆 💕',
      path: '/pages/profile/profile'
    }
  },

  onShareTimeline() {
    const month = this.data.year + '年' + this.data.month + '月'
    return { title: '情侣心情录｜' + month + ' 心情日历 📅' }
  }
})
