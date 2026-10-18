const app = getApp()

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 四阶段配置（用于时间轴展示，颜色与后端 PHASE_DETAILS 对齐）
const PHASE_META = {
  period: { key: 'period', label: '月经期', emoji: '🩸', color: '#FF6B9D', bg: '#FFD6E4' },
  follicular: { key: 'follicular', label: '卵泡期', emoji: '🌸', color: '#A8E6CF', bg: '#DCEDC8' },
  ovulation: { key: 'ovulation', label: '排卵期', emoji: '🥚', color: '#B8A9FF', bg: '#E8E0FF' },
  luteal: { key: 'luteal', label: '黄体期', emoji: '🌙', color: '#FFB347', bg: '#FFE5B4' }
}

// 根据状态构建周期时间轴（1-indexed 日）
function buildTimeline(status) {
  if (!status || !status.hasData) return null
  const cycle = Number(status.cycle) || 28
  const periodLen = Number(status.periodLen) || 5
  const periodStart = status.periodStart
  if (!periodStart) return null

  // day-of-cycle（1-indexed）
  const todayIdx = status.asOf ? diffDays(periodStart, status.asOf) : diffDays(periodStart, today())
  const dayOfCycle = todayIdx + 1

  // 排卵日 = 下次月经 - 14 天 => day-of-cycle = cycle - 14 + 1
  const ovulationDay = cycle - 14 + 1
  const fertileStartDay = ovulationDay - 5
  const fertileEndDay = ovulationDay + 4
  const lutealStartDay = fertileEndDay + 1

  // 各阶段起止日（1-indexed，含端点）
  const segs = [
    { ...PHASE_META.period, start: 1, end: periodLen },
    { ...PHASE_META.follicular, start: periodLen + 1, end: fertileStartDay - 1 },
    { ...PHASE_META.ovulation, start: fertileStartDay, end: fertileEndDay },
    { ...PHASE_META.luteal, start: lutealStartDay, end: cycle }
  ]
  // 计算每个段宽度占比、日期范围
  segs.forEach(s => {
    s.days = Math.max(0, s.end - s.start + 1)
    s.percent = cycle > 0 ? (s.days / cycle) * 100 : 0
    s.active = dayOfCycle >= s.start && dayOfCycle <= s.end
    s.startDate = formatShortDate(addDays(periodStart, s.start - 1))
    s.endDate = formatShortDate(addDays(periodStart, s.end - 1))
    s.dateRange = `${s.startDate} - ${s.endDate}`
  })

  const progressPercent = cycle > 0 ? Math.min(100, Math.max(0, (dayOfCycle / cycle) * 100)) : 0

  return {
    cycle,
    dayOfCycle,
    progressPercent,
    segs,
    ovulationDay,
    nextPeriodStart: status.nextPeriodStart,
    periodStart
  }
}

function diffDays(a, b) {
  // b - a 的天数
  const da = new Date(a + 'T00:00:00')
  const db = new Date(b + 'T00:00:00')
  return Math.round((db - da) / 86400000)
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatShortDate(dateStr) {
  if (!dateStr) return '-'
  const m = dateStr.match(/\d{4}-(\d{2})-(\d{2})/)
  return m ? `${m[1]}/${m[2]}` : dateStr
}

Page({
  data: {
    gender: 0,
    status: {},
    partnerStatus: {},
    settings: { cycle_length: 28, period_length: 5 },
    records: [],
    aiText: '',
    aiLoading: false,
    // 时间轴
    timeline: null,
    partnerTimeline: null,
    // 阶段信息
    phaseInfo: null,
    partnerPhaseInfo: null,
    selfTips: [],
    partnerTips: [],
    // 关怀动作
    careActions: [],
    sendingKey: '',
    careHistory: [],
    // tab 切换：女生视角 self / partner
    activeTab: 'self'
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      try { this.getTabBar().setData({ selected: 3 }) } catch (e) {}
    }
    const userInfo = wx.getStorageSync('userInfo') || {}
    this.setData({ gender: userInfo.gender || 0 })
    if (!this.data.gender) return
    this.loadAll()
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh())
  },

  async loadAll() {
    wx.showLoading({ title: '加载中', mask: true })
    try {
      if (this.data.gender === 2) {
        // 女生：加载自己的状态 + 历史记录 + 收到的关怀
        const [statusRes, recordsRes] = await Promise.all([
          app.request({ url: '/api/period/status' }).catch(e => { throw e }),
          app.request({ url: '/api/period/records' }).catch(() => ({ list: [] }))
        ])
        const status = statusRes || {}
        const phaseInfo = status.phaseInfo || null
        const timeline = buildTimeline(status)
        this.setData({
          status,
          settings: status.settings || { cycle_length: 28, period_length: 5 },
          records: (recordsRes && recordsRes.list) || [],
          phaseInfo,
          selfTips: (phaseInfo && phaseInfo.tips) || [],
          timeline
        })
        // 加载收到的关怀（不阻塞主流程）
        this.loadCareHistory()
        // 自动拉取 AI 分析（仅当有数据时）
        if (status.hasData && !this.data.aiText) {
          this.analyze(true)
        }
      } else if (this.data.gender === 1) {
        // 男生：加载伴侣状态 + 关怀动作列表 + 已发送关怀
        const [partnerRes, actionsRes] = await Promise.all([
          app.request({ url: '/api/period/partner' }).catch(e => { throw e }),
          app.request({ url: '/api/period/care-actions' }).catch(() => ({ list: [] }))
        ])
        const partner = partnerRes || {}
        const phaseInfo = partner.phaseInfo || null
        const partnerTimeline = buildTimeline(partner)
        this.setData({
          partnerStatus: partner,
          partnerPhaseInfo: phaseInfo,
          partnerTips: (phaseInfo && phaseInfo.partnerTips) || [],
          careActions: (actionsRes && actionsRes.list) || [],
          partnerTimeline
        })
        this.loadCareHistory()
      }
    } catch (e) {
      app.safeToast({ title: (e && (e.msg || e.message)) || '加载失败', icon: 'none' })
    }
    wx.hideLoading()
  },

  async loadCareHistory() {
    try {
      const res = await app.request({ url: '/api/period/cares' })
      this.setData({ careHistory: (res && res.list) || [] })
    } catch (e) {
      this.setData({ careHistory: [] })
    }
  },

  async setGender(e) {
    const g = Number(e.currentTarget.dataset.g)
    try {
      await app.request({ url: '/api/user/gender', method: 'POST', data: { gender: g } })
      const userInfo = wx.getStorageSync('userInfo') || {}
      userInfo.gender = g
      wx.setStorageSync('userInfo', userInfo)
      app.globalData.userInfo = userInfo
      this.setData({ gender: g })
      this.loadAll()
    } catch (e) {
      app.safeToast({ title: (e && (e.msg || e.message)) || '设置失败', icon: 'none' })
    }
  },

  async startPeriod() {
    const inPeriod = this.data.status.inPeriod
    const date = today()
    try {
      if (inPeriod) {
        const latest = this.data.status.latest || {}
        await app.request({
          url: '/api/period/record',
          method: 'POST',
          data: { id: latest.id, start_date: latest.start_date, end_date: date }
        })
        app.safeToast({ title: '已标记结束', icon: 'success' })
      } else {
        await app.request({
          url: '/api/period/record',
          method: 'POST',
          data: { start_date: date }
        })
        app.safeToast({ title: '已记录经期', icon: 'success' })
      }
      this.loadAll()
    } catch (e) {
      app.safeToast({ title: (e && (e.msg || e.message)) || '记录失败', icon: 'none' })
    }
  },

  async analyze(silent) {
    if (this.data.gender !== 2) return
    if (!this.data.status.hasData) {
      app.safeToast({ title: '请先记录一次经期', icon: 'none' })
      return
    }
    this.setData({ aiLoading: true })
    if (!silent) wx.showLoading({ title: 'AI 分析中', mask: true })
    try {
      const res = await app.request({ url: '/api/period/analyze' })
      this.setData({ aiText: (res && res.text) || '' })
      if (!res || (res.ok === false)) {
        if (!silent) app.safeToast({ title: 'AI 暂不可用，稍后再试', icon: 'none' })
      }
    } catch (e) {
      if (!silent) app.safeToast({ title: (e && (e.msg || e.message)) || '分析失败', icon: 'none' })
    }
    this.setData({ aiLoading: false })
    if (!silent) wx.hideLoading()
  },

  async sendCare(e) {
    const key = e.currentTarget.dataset.key
    if (!key || this.data.sendingKey) return
    this.setData({ sendingKey: key })
    try {
      await app.request({ url: '/api/period/care', method: 'POST', data: { action_key: key } })
      const action = this.data.careActions.find(a => a.key === key)
      app.safeToast({ title: (action && action.label) + ' 已送达', icon: 'success' })
      this.loadCareHistory()
    } catch (e) {
      app.safeToast({ title: (e && (e.msg || e.message)) || '发送失败', icon: 'none' })
    }
    this.setData({ sendingKey: '' })
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.tab })
  },

  onCycleInput(e) {
    this.setData({ 'settings.cycle_length': Number(e.detail.value) || 28 })
  },

  onPeriodLenInput(e) {
    this.setData({ 'settings.period_length': Number(e.detail.value) || 5 })
  },

  async saveSettings() {
    try {
      await app.request({ url: '/api/period/settings', method: 'POST', data: this.data.settings })
      app.safeToast({ title: '保存成功', icon: 'success' })
      this.loadAll()
    } catch (e) {
      app.safeToast({ title: (e && (e.msg || e.message)) || '保存失败', icon: 'none' })
    }
  }
})
