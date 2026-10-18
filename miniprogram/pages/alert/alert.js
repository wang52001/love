const app = getApp()

Page({
  data: {
    list: [],
    showForm: false,
    form: { title: '', date: '', type: '纪念日', note: '' },
    types: ['纪念日', '生日', '节日', '约会', '其他'],
    alert: null,
    tips: [
      { title: '提前 3 天就会高亮提醒', desc: '重要的日子，我们都不会忘。' },
      { title: '点击卡片可删除', desc: '过时的节日，一键清理。' },
      { title: '生日和纪念日会触发黄色预警', desc: '帮你做最浪漫的那一个 💕' }
    ]
  },

  onLoad() { this.refresh() },
  onShow() { this.refresh() },

  async refresh() {
    wx.showLoading({ title: '加载中…', mask: true })
    try {
      const list = app.toArr(await app.getAlertList())
      const safeStr = (v) => {
        const s = (v == null) ? '' : String(v)
        if (s.startsWith('{') || s.startsWith('[')) {
          try { const p = JSON.parse(s); return p.note || p.title || p.desc || '' }
          catch (e) { return s }
        }
        return s
      }
      const sorted = list.slice().sort((a, b) => Number(a.days_left) - Number(b.days_left))
      sorted.forEach((it) => {
        it.note = safeStr(it.note)
        it.title = safeStr(it.title)
      })
      // 补兜底：确保每条都有唯一 id（wx:key="id" 必需），没有就按顺序补
      sorted.forEach((it, idx) => {
        if (it.id === undefined || it.id === null || it.id === '') it.id = 'local_' + Date.now() + '_' + idx
      })
      const top = sorted[0]
      let alert = null
      if (top) {
        const d = Number(top.days_left)
        let emoji = '🎁', level = '普通提醒'
        if (d <= 0) { emoji = '🎉'; level = '今天就是！' }
        else if (d <= 3) { emoji = '⚠️'; level = '黄色预警 · 还有 ' + d + ' 天' }
        else if (d <= 7) { emoji = '📅'; level = '7 天内 · 还有 ' + d + ' 天' }
        else { level = '还有 ' + d + ' 天' }
        alert = {
          id: top.id, emoji, levelLabel: level, title: top.title,
          desc: top.note || (top.type ? ('类型：' + top.type) : '别忘了给 TA 准备惊喜哦 💕'),
          days: d, date: top.date || ''
        }
      }
      const urgentCount = sorted.filter((a) => Number(a.days_left) >= 0 && Number(a.days_left) <= 3).length
      const yearlyCount = sorted.filter((a) => a.type === '纪念日' || a.type === '生日' || a.type === '节日').length
      this.setData({ list: sorted, alert, urgentCount, yearlyCount })
    } catch (e) {}
    wx.hideLoading()
  },

  toggleForm() { this.setData({ showForm: !this.data.showForm }) },

  pickDate(e) {
    const d = e.detail && e.detail.value
    if (d) this.setData({ 'form.date': d })
  },

  pickType(e) {
    const idx = Number(e.detail.value) || 0
    this.setData({ 'form.type': this.data.types[idx] })
  },

  onFormInput(e) {
    const f = e.currentTarget.dataset.field
    this.setData({ ['form.' + f]: e.detail.value || '' })
  },

  async submit() {
    const { title, date, type, note } = this.data.form
    if (!title || !date) {
      wx.showToast({ title: '标题和日期必填', icon: 'none' })
      return
    }
    try {
      wx.showLoading({ title: '保存中…', mask: true })
      await app.createAlert({ title, date, type, note })
      wx.hideLoading()
      this.setData({ showForm: false, form: { title: '', date: '', type: '纪念日', note: '' } })
      wx.showToast({ title: '已添加 📅', icon: 'none' })
      this.refresh()
    } catch (e) {
      wx.hideLoading()
    }
  },

  async del(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '删除提醒',
      content: '确定要删掉这条预警吗？',
      confirmColor: '#FF6B6B',
      success: async (r) => {
        if (r.confirm) {
          try { await app.deleteAlert(id); this.refresh() } catch (e) {}
        }
      }
    })
  },

  goCalendar() { wx.switchTab({ url: '/pages/calendar/calendar' }) },

  onShareAppMessage() {
    const next = (this.data.alert && this.data.alert.title) ? '别忘了我们的：' + this.data.alert.title + ' 💕' : '一起记录每一个重要的日子吧'
    return {
      title: '🌈 情侣心情录｜' + next,
      path: '/pages/profile/profile'
    }
  },

  onShareTimeline() {
    return { title: '情侣心情录 · 把每一个纪念日都写成天气 🌤️' }
  }
})
