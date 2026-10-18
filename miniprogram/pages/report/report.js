const app = getApp()

Page({
  data: {
    year: 2026,
    month: 8,
    periodLabel: '月度报告',
    togetherDays: 0,
    avgTemp: 22,
    dist: [],
    streaks: { sun: 0, rain: 0, wish: 0 },
    analyst: { p1: '加载中…', p2: '', p3: '' },
    weekTrend: [],
    majorWeather: '平静',
    majorEmoji: '😌',
    aiInsight: '',
    aiInsightTip: '',
    aiInsightStats: null,
    aiInsightLoading: false
  },

  onLoad(options) {
    if (options.year) this.setData({ year: Number(options.year) })
    if (options.month) this.setData({ month: Number(options.month) })
    const coupleInfo = wx.getStorageSync('coupleInfo')
    if (coupleInfo && coupleInfo.bind_date) {
      const days = app.daysBetween(coupleInfo.bind_date, new Date())
      this.setData({ togetherDays: days + 1 })
    }
    this.buildWeekTrend()
    this.loadReport()
    this.loadAIInsight()
  },

  buildWeekTrend() {
    const temps = []
    for (let i = 0; i < 7; i++) {
      const t = 12 + Math.round(Math.random() * 18)
      temps.push({ day: ['一','二','三','四','五','六','日'][i], temp: t, height: Math.max(20, t * 3) })
    }
    this.setData({ weekTrend: temps })
  },

  async loadReport() {
    try {
      const yyyymm = this.data.year + '-' + String(this.data.month).padStart(2, '0')
      const r = await app.getMonthlyReport(yyyymm)
      const daysInMonth = new Date(this.data.year, this.data.month, 0).getDate()
      const emotionNames = ['心动', '开心', '兴奋', '惊喜', '平静', '疲惫', '难过', '生气', '委屈', '焦虑']
      let dist, analyst, avgTemp, streaks
      if (r) {
        const distribution = (r && r.distribution && typeof r.distribution === 'object') ? r.distribution
                          : (r && r.dist && typeof r.dist === 'object') ? r.dist : {}
        dist = emotionNames.map((k) => {
          const count = Number(distribution[k] || 0)
          const meta = app.getEmotionMeta(k)
          return {
            key: k,
            name: k,
            emoji: meta.emoji,
            count,
            pct: Math.min(100, Math.round((count / Math.max(1, daysInMonth)) * 100)),
            colors: app.getEmotionColors(k)
          }
        }).sort((a, b) => b.count - a.count)
        analyst = {
          p1: app.toStr(r.p1 || r.summary, '本月心情报告已生成，快来看看你们的专属心情吧～'),
          p2: app.toStr(r.p2, '一起记录心情，就是最好的情书。'),
          p3: app.toStr(r.p3, '月底安排一次小约会，给这个月画上甜甜的句号吧 🌸')
        }
        avgTemp = Number(r.avg_temperature || r.avgTemp || 22) || 22
        const s = (r.streaks && typeof r.streaks === 'object') ? r.streaks : {}
        streaks = {
          sun: Number(s.sun || r.sunny_streak || 0) || 0,
          rain: Number(s.rain || r.rainy_streak || 0) || 0,
          wish: Number(s.wish || r.wish_fulfilled || 0) || 0
        }
      } else {
        const fallback = { '心动': 6, '开心': 12, '兴奋': 4, '惊喜': 3, '平静': 10, '疲惫': 4, '难过': 2, '生气': 1, '委屈': 1, '焦虑': 2 }
        dist = emotionNames.map((k) => {
          const meta = app.getEmotionMeta(k)
          return {
            key: k,
            name: k,
            emoji: meta.emoji,
            count: fallback[k],
            pct: Math.round((fallback[k] / Math.max(1, daysInMonth)) * 100),
            colors: app.getEmotionColors(k)
          }
        }).sort((a, b) => b.count - a.count)
        analyst = {
          p1: '本月你们一起记录了心情，每一笔都是甜甜的回忆～',
          p2: '阴天和小雨都会过去，和你在一起的每一天都是晴天 🌤️',
          p3: '记得月底安排一次小约会，给这个月画上甜甜的句号吧 🌸'
        }
        avgTemp = 23
        streaks = { sun: 7, rain: 2, wish: 3 }
      }

      const major = dist[0] || dist[1]
      this.setData({
        dist: app.toArr(dist),
        analyst,
        avgTemp,
        streaks,
        majorWeather: major ? major.name : '平静',
        majorEmoji: major ? major.emoji : '😌'
      })
    } catch (e) {
      const msg = (e && (e.msg || e.message)) || '报告加载失败'
      app.safeToast({ title: msg, icon: 'none', duration: 1500 })
    }
  },

  goShare() { wx.navigateTo({ url: '/pages/share/share?type=report' }) },
  goHome() { wx.switchTab({ url: '/pages/index/index' }) },

  async loadAIInsight() {
    const coupleInfo = wx.getStorageSync('coupleInfo')
    if (!coupleInfo || !coupleInfo.bind_date) {
      this.setData({ aiInsightTip: '绑定情侣后，AI 会为你们分析情感趋势 💫' })
      return
    }
    if (this.data.aiInsightLoading) return
    this.setData({ aiInsightLoading: true, aiInsight: '', aiInsightTip: '' })
    try {
      const res = await app.getAIInsight()
      if (res) {
        const insight = res.insight || ''
        const tip = res.tip || ''
        if (insight) {
          this.setData({
            aiInsight: insight,
            aiInsightStats: res.stats || null,
            aiInsightTip: '',
            aiInsightLoading: false
          })
        } else {
          this.setData({
            aiInsight: '',
            aiInsightStats: res.stats || null,
            aiInsightTip: tip || '最近 7 天还没有心情记录，记几笔让 AI 帮你们看看趋势吧 📒',
            aiInsightLoading: false
          })
        }
      } else {
        this.setData({ aiInsightTip: 'AI 小憩一下，稍后再来～', aiInsightLoading: false })
      }
    } catch (e) {
      this.setData({ aiInsightTip: 'AI 走神了，点这里重试 ↻', aiInsightLoading: false })
    }
  },

  refreshAIInsight() {
    this.loadAIInsight()
  },

  onShareAppMessage() {
    return {
      title: '🌈 情侣心情录｜我们 ' + this.data.year + '年' + this.data.month + '月 的心情报告出来啦！一起来看 💕',
      path: '/pages/profile/profile'
    }
  },

  onShareTimeline() {
    return { title: '情侣心情录｜' + this.data.year + '年' + this.data.month + '月 心情报告 📊' }
  }
})
