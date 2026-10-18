const app = getApp()

const emotionMap = app.globalData.emotionMap
const options = Object.keys(emotionMap).map(k => ({
  key: k, name: emotionMap[k].name, emoji: emotionMap[k].emoji,
  colors: [emotionMap[k].color1, emotionMap[k].color2]
}))

Page({
  data: {
    options,
    selected: '',
    reason: '',
    myWish: null,
    taWish: null,
    matched: false,
    wishStats: { total: 0, matched: 0, rate: 0 },
    list: []
  },

  onShow() { this.refresh() },

  async refresh() {
    try {
      const list = app.toArr(await app.getWishList())
      // 兜底：确保每条都有唯一 id，没有就补本地临时键
      list.forEach((w, idx) => {
        if (w.id === undefined || w.id === null || w.id === '') w.id = 'local_w_' + Date.now() + '_' + idx
        // 补充情绪展示信息（emoji/颜色/名称）供列表渲染使用
        const meta = app.getEmotionMeta(w.weather)
        w.emoji = meta.emoji
        w.colors = meta.colors
        w.emotionName = meta.name
      })
      const total = list.length
      const matched = list.filter((w) => w.status === 'done' || w.matched || Number(w.fulfilled) === 1).length
      const rate = total ? Math.round((matched / total) * 100) : 0
      this.setData({
        list,
        wishStats: { total, matched, rate }
      })
      const pending = list.filter((w) => w.status !== 'done' && Number(w.fulfilled) !== 1)
      if (pending.length) {
        const me = wx.getStorageSync('userInfo') || {}
        const uid = me.id
        const mine = pending.find((w) => String(w.owner_id || w.user_id) === String(uid)) || pending[0]
        const ta = pending.find((w) => String(w.owner_id || w.user_id) !== String(uid))
        const pick = (w) => {
          if (!w) return null
          const meta = app.getEmotionMeta(w.weather)
          return {
            name: meta.name,
            emoji: meta.emoji,
            colors: meta.colors,
            reason: w.reason || w.title || w.content || ''
          }
        }
        const my = pick(mine)
        const tas = pick(ta)
        this.setData({
          myWish: my,
          taWish: tas,
          matched: !!(mine && ta && (mine.weather === (ta ? ta.weather : null)))
        })
      }
    } catch (e) {}
  },

  pick(e) { this.setData({ selected: e.currentTarget.dataset.key }) },

  onInput(e) { this.setData({ reason: e.detail.value }) },

  async submit() {
    if (!this.data.selected) {
      wx.showToast({ title: '选一个心愿心情吧 🌸', icon: 'none' })
      return
    }
    const opt = this.data.options.find((o) => o.key === this.data.selected)
    try {
      wx.showLoading({ title: '许愿中…', mask: true })
      await app.saveWish({
        weather: this.data.selected,
        reason: this.data.reason || '',
        status: 'pending'
      })
      wx.hideLoading()
      this.setData({
        myWish: {
          name: opt.name, emoji: opt.emoji, colors: opt.colors, reason: this.data.reason
        },
        selected: '',
        reason: ''
      })
      wx.showToast({ title: '心愿已送达 💌', icon: 'none' })
      this.refresh()
    } catch (e) { wx.hideLoading() }
  },

  async toggleStatus(e) {
    const id = e.currentTarget.dataset.id
    const status = e.currentTarget.dataset.status
    if (!id) return
    try {
      const toServer = (status === 'done' || status === 'fulfilled') ? 'fulfilled' : 'pending'
      await app.updateWishStatus(id, toServer)
      this.refresh()
      wx.showToast({ title: (toServer === 'fulfilled') ? '🌈 心愿兑现！' : '状态已更新', icon: 'none' })
    } catch (e) {}
  },

  async delWish(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.showModal({
      title: '删除愿望',
      content: '确定要删除这条愿望吗？',
      confirmColor: '#FF6B6B',
      success: async (r) => {
        if (r.confirm) { try { await app.deleteWish(id); this.refresh() } catch (e) {} }
      }
    })
  },

  reset() { this.setData({ myWish: null, selected: '', reason: '' }) },

  onShareAppMessage() {
    const extra = this.data.taWish ? ('TA 希望明天是：' + this.data.taWish.name) : '来许个明天的心愿心情吧 💌'
    return {
      title: '🌈 情侣心情录｜' + extra,
      path: '/pages/profile/profile'
    }
  },

  onShareTimeline() {
    return { title: '情侣心情录 · 心愿心情 🌈' }
  }
})
