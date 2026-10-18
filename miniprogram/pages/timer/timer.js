const app = getApp()

const CATEGORIES = [
  { key: 'focus', name: '专注', emoji: '🎯' },
  { key: 'study', name: '学习', emoji: '📚' },
  { key: 'read', name: '阅读', emoji: '📖' },
  { key: 'meditate', name: '冥想', emoji: '🧘' },
  { key: 'work', name: '工作', emoji: '💼' },
  { key: 'custom', name: '自定义', emoji: '✨' }
]

// 把后端 category 字段转换为展示信息（支持自定义名称）
// category 存储格式：预设分类用 key（如 'focus'），自定义用 'custom:用户输入的名称'
function parseCategory(category) {
  if (!category) return { key: 'custom', name: '未分类', emoji: '✨' }
  if (category.startsWith('custom:')) {
    const name = category.slice(7).trim()
    return { key: 'custom', name: name || '自定义', emoji: '✨' }
  }
  const meta = CATEGORIES.find(t => t.key === category)
  return meta || { key: 'custom', name: String(category), emoji: '✨' }
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatTime(seconds) {
  seconds = Math.max(0, parseInt(seconds) || 0)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatMin(seconds) {
  seconds = Math.max(0, parseInt(seconds) || 0)
  if (seconds < 60) return `${seconds}秒`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}分钟`
  const h = Math.floor(m / 60)
  return `${h}小时${m % 60}分`
}

Page({
  data: {
    categories: CATEGORIES,
    // 计时状态
    isRunning: false,
    isPaused: false,
    elapsed: 0,
    displayTime: '00:00:00',
    selectedCategory: 'focus',
    // 模式：single/together
    timerMode: 'single',
    // 后端会话信息
    sessionId: null,
    recordId: null,
    // 邀请弹窗
    showStartModal: false,
    startMode: 'single',
    startCategory: 'focus',
    startCustomName: '',
    selectedCategoryName: '专注',
    // 结束弹窗
    showFinishModal: false,
    finishNote: '',
    // 数据展示
    stats: { weekly: [], categories: [], summary: {}, week_start: '', week_end: '' },
    historyList: [],
    pendingList: [],
    maxDaily: 1
  },

  timer: null,
  startTime: 0,
  pausedElapsed: 0,

  onLoad() {
    this.loadAll()
  },

  onShow() {
    this.loadAll()
  },

  onUnload() {
    this.stopTimer()
  },

  async loadAll() {
    await Promise.all([this.loadStats(), this.loadHistory(), this.loadPending()])
  },

  async loadStats() {
    try {
      const res = await app.request({ url: '/api/timer/stats' })
      const weekly = app.toArr(res.weekly).map(w => ({
        ...w,
        total: Number(w.total) || 0,
        minutes: Math.floor((Number(w.total) || 0) / 60)
      }))
      const maxDaily = Math.max(1, ...weekly.map(w => w.total))
      const cats = app.toArr(res.categories).map(c => {
        const meta = parseCategory(c.category)
        return { ...c, name: meta.name, emoji: meta.emoji, category_key: meta.key, pct: 0 }
      })
      const totalCat = cats.reduce((s, c) => s + (Number(c.total) || 0), 0)
      cats.forEach(c => { c.pct = totalCat > 0 ? Math.round((c.total / totalCat) * 100) : 0 })
      this.setData({
        stats: { weekly, categories: cats, summary: res.summary || {}, week_start: res.week_start, week_end: res.week_end },
        maxDaily
      })
    } catch (e) {
      console.error('load stats err', e)
    }
  },

  async loadHistory() {
    try {
      const res = await app.request({ url: '/api/timer/history?limit=30' })
      const list = app.toArr(res.list).map(r => {
        const meta = parseCategory(r.category)
        return {
          ...r,
          category_name: meta.name,
          category_emoji: meta.emoji,
          format_duration: formatMin(r.duration),
          is_mine: r.user_id === (app.globalData.userInfo && app.globalData.userInfo.id)
        }
      })
      this.setData({ historyList: list })
    } catch (e) {
      console.error('load history err', e)
    }
  },

  async loadPending() {
    try {
      const res = await app.request({ url: '/api/timer/pending' })
      const list = app.toArr(res.list).map(r => {
        const meta = parseCategory(r.category)
        return { ...r, category_name: meta.name, category_emoji: meta.emoji }
      })
      this.setData({ pendingList: list })
    } catch (e) {
      console.error('load pending err', e)
    }
  },

  // ============ 开始计时弹窗 ============
  openStartModal() {
    if (this.data.isRunning) {
      wx.showToast({ title: '请先结束当前计时', icon: 'none' })
      return
    }
    this.setData({ showStartModal: true, startMode: 'single', startCategory: 'focus', startCustomName: '' })
  },
  closeStartModal() {
    this.setData({ showStartModal: false })
  },
  selectStartMode(e) {
    this.setData({ startMode: e.currentTarget.dataset.mode })
  },
  selectStartCategory(e) {
    this.setData({ startCategory: e.currentTarget.dataset.key })
  },
  onCustomNameInput(e) {
    this.setData({ startCustomName: e.detail.value })
  },

  async confirmStart() {
    const { startMode, startCategory, startCustomName } = this.data
    // 自定义分类：把用户输入的名称拼进 category 字段
    let category = startCategory
    let displayName = ''
    if (startCategory === 'custom') {
      const name = (startCustomName || '').trim()
      if (!name) {
        wx.showToast({ title: '请输入自定义名称', icon: 'none' })
        return
      }
      if (name.length > 10) {
        wx.showToast({ title: '名称最多10个字', icon: 'none' })
        return
      }
      category = 'custom:' + name
      displayName = name
    } else {
      const meta = CATEGORIES.find(t => t.key === startCategory)
      displayName = meta ? meta.name : '计时'
    }
    try {
      const res = await app.request({
        url: '/api/timer/start',
        method: 'POST',
        data: { mode: startMode, category }
      })
      this.setData({
        showStartModal: false,
        isRunning: true,
        isPaused: false,
        elapsed: 0,
        displayTime: '00:00:00',
        selectedCategory: category,
        selectedCategoryName: displayName,
        timerMode: startMode,
        sessionId: res.session_id,
        recordId: res.id
      })
      this.startTime = Date.now()
      this.startTimer()
      wx.showToast({
        title: startMode === 'together' ? '已邀请TA一起计时' : '开始计时',
        icon: 'none'
      })
    } catch (e) {
      wx.showToast({ title: e.msg || '启动失败', icon: 'none' })
    }
  },

  // ============ 加入双人邀请 ============
  async joinSession(e) {
    const sessionId = e.currentTarget.dataset.session
    try {
      const res = await app.request({
        url: '/api/timer/join',
        method: 'POST',
        data: { session_id: sessionId }
      })
      const host = this.data.pendingList.find(p => p.session_id === sessionId)
      const catMeta = host ? parseCategory(host.category) : parseCategory('focus')
      this.setData({
        isRunning: true,
        isPaused: false,
        elapsed: 0,
        displayTime: '00:00:00',
        selectedCategory: host ? host.category : 'focus',
        selectedCategoryName: catMeta.name,
        timerMode: 'together',
        sessionId: res.session_id,
        recordId: res.id
      })
      this.startTime = Date.now()
      this.startTimer()
      wx.showToast({ title: '已加入，开始计时', icon: 'success' })
      this.loadPending()
    } catch (e) {
      wx.showToast({ title: e.msg || '加入失败', icon: 'none' })
    }
  },

  // ============ 计时器 ============
  startTimer() {
    this.stopTimer()
    this.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000)
      this.setData({ elapsed, displayTime: formatTime(elapsed) })
    }, 1000)
  },
  stopTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  pauseTimer() {
    if (!this.data.isRunning || this.data.isPaused) return
    this.stopTimer()
    this.pausedElapsed = this.data.elapsed
    this.setData({ isPaused: true })
  },

  resumeTimer() {
    if (!this.data.isPaused) return
    this.startTime = Date.now() - this.pausedElapsed * 1000
    this.setData({ isPaused: false })
    this.startTimer()
  },

  openFinishModal() {
    if (this.data.isPaused) {
      // 已暂停，直接打开结束弹窗
    } else {
      this.pauseTimer()
    }
    this.setData({ showFinishModal: true, finishNote: '' })
  },
  closeFinishModal() {
    this.setData({ showFinishModal: false })
    // 恢复计时
    if (this.data.isRunning && this.data.isPaused) {
      this.resumeTimer()
    }
  },
  onNoteInput(e) {
    this.setData({ finishNote: e.detail.value })
  },

  async confirmFinish() {
    const { recordId, elapsed, finishNote } = this.data
    if (!recordId) {
      wx.showToast({ title: '会话异常', icon: 'none' })
      return
    }
    if (elapsed < 1) {
      wx.showToast({ title: '时长太短', icon: 'none' })
      return
    }
    wx.showLoading({ title: '保存中' })
    try {
      await app.request({
        url: '/api/timer/finish',
        method: 'POST',
        data: { id: recordId, duration: elapsed, note: finishNote }
      })
      wx.hideLoading()
      this.stopTimer()
      this.setData({
        isRunning: false,
        isPaused: false,
        elapsed: 0,
        displayTime: '00:00:00',
        showFinishModal: false,
        recordId: null,
        sessionId: null,
        finishNote: ''
      })
      wx.showToast({ title: '已保存', icon: 'success' })
      this.loadAll()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.msg || '保存失败', icon: 'none' })
    }
  },

  giveUpTimer() {
    wx.showModal({
      title: '放弃计时',
      content: '本次计时不会保存，确定放弃吗？',
      showCancel: true,
      success: (r) => {
        if (r.confirm) {
          this.stopTimer()
          this.setData({
            isRunning: false,
            isPaused: false,
            elapsed: 0,
            displayTime: '00:00:00',
            showFinishModal: false,
            recordId: null,
            sessionId: null
          })
        }
      }
    })
  },

  // ============ 删除记录 ============
  async deleteRecord(e) {
    const id = e.currentTarget.dataset.id
    const res = await wx.showModal({ title: '删除记录', content: '确定删除这条计时记录吗？', showCancel: true })
    if (!res.confirm) return
    try {
      await app.request({ url: '/api/timer/delete', method: 'POST', data: { id } })
      this.loadAll()
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.msg || '删除失败', icon: 'none' })
    }
  }
})
