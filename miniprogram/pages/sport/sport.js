const app = getApp()

const SPORT_TYPES = [
  { key: 'walk', name: '散步', emoji: '🚶' },
  { key: 'run', name: '跑步', emoji: '🏃' },
  { key: 'bike', name: '骑行', emoji: '🚴' },
  { key: 'hike', name: '徒步', emoji: '🥾' },
  { key: 'other', name: '其他', emoji: '💪' }
]

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

Page({
  data: {
    sportTypes: SPORT_TYPES,
    stats: {},
    goal: { daily_steps: 6000, weekly_days: 5 },
    goalProgress: 0,
    today: { my_count: 0, ta_count: 0 },
    weeklyList: [],
    showCheckinModal: false,
    showGoalModal: false,
    showStartModal: false,
    startType: 'walk',
    checkinForm: { sport_type: 'walk', duration: '', distance: '', steps: '', note: '', sport_date: today() },
    goalForm: { daily_steps: '6000', weekly_days: '5' }
  },

  onLoad() {
    this.loadAll()
  },

  onShow() {
    this.loadAll()
  },

  async loadAll() {
    await Promise.all([this.loadWeekly(), this.loadGoal(), this.loadToday()])
  },

  async loadWeekly() {
    try {
      const res = await app.request({ url: '/api/sport/weekly' })
      const list = app.toArr(res.list).map(r => {
        let track = []
        if (r.track) {
          try {
            track = typeof r.track === 'string' ? JSON.parse(r.track) : r.track
          } catch (_) {}
        }
        return {
          ...r,
          type_emoji: SPORT_TYPES.find(t => t.key === r.sport_type)?.emoji || '💪',
          type_name: SPORT_TYPES.find(t => t.key === r.sport_type)?.name || '运动',
          distance: Number(r.distance || 0).toFixed(2),
          format_duration: formatDuration(parseInt(r.duration) || 0),
          track_count: track.length
        }
      })
      this.setData({ stats: res.stats || {}, weeklyList: list })
      this.updateGoalProgress()
    } catch (e) {
      console.error('load weekly err', e)
    }
  },

  async loadGoal() {
    try {
      const goal = await app.request({ url: '/api/sport/goal' })
      if (goal) {
        this.setData({ goal, goalForm: { daily_steps: String(goal.daily_steps), weekly_days: String(goal.weekly_days) } })
        this.updateGoalProgress()
      }
    } catch (e) {
      console.error('load goal err', e)
    }
  },

  async loadToday() {
    try {
      const res = await app.request({ url: '/api/sport/today' })
      this.setData({ today: { my_count: res.my_count || 0, ta_count: res.ta_count || 0 } })
    } catch (e) {
      console.error('load today err', e)
    }
  },

  updateGoalProgress() {
    const days = this.data.stats.checkin_days || 0
    const target = this.data.goal.weekly_days || 5
    const pct = target > 0 ? Math.min(100, (days / target) * 100) : 0
    this.setData({ goalProgress: pct.toFixed(1) })
  },

  openCheckinModal() {
    this.setData({
      showCheckinModal: true,
      checkinForm: { sport_type: 'walk', duration: '', distance: '', steps: '', note: '', sport_date: today() }
    })
  },
  closeCheckinModal() {
    this.setData({ showCheckinModal: false })
  },
  openStartModal() {
    this.setData({ showStartModal: true, startType: 'walk' })
  },
  closeStartModal() {
    this.setData({ showStartModal: false })
  },
  selectStartType(e) {
    this.setData({ startType: e.currentTarget.dataset.key })
  },
  startRealSport() {
    this.closeStartModal()
    wx.navigateTo({ url: `/pages/sport-track/sport-track?type=${this.data.startType}` })
  },
  selectType(e) {
    this.setData({ 'checkinForm.sport_type': e.currentTarget.dataset.key })
  },
  onDurationInput(e) {
    this.setData({ 'checkinForm.duration': e.detail.value })
  },
  onDistanceInput(e) {
    this.setData({ 'checkinForm.distance': e.detail.value })
  },
  onStepsInput(e) {
    this.setData({ 'checkinForm.steps': e.detail.value })
  },
  onNoteInput(e) {
    this.setData({ 'checkinForm.note': e.detail.value })
  },
  onDateChange(e) {
    this.setData({ 'checkinForm.sport_date': e.detail.value })
  },

  async saveCheckin() {
    const f = this.data.checkinForm
    if (!f.duration && !f.distance && !f.steps) {
      wx.showToast({ title: '至少填写一项数据', icon: 'none' })
      return
    }
    try {
      await app.request({
        url: '/api/sport/checkin',
        method: 'POST',
        data: {
          sport_type: f.sport_type,
          duration: parseInt(f.duration) || 0,
          distance: Number(f.distance) || 0,
          steps: parseInt(f.steps) || 0,
          note: f.note,
          sport_date: f.sport_date
        }
      })
      this.closeCheckinModal()
      this.loadAll()
      wx.showToast({ title: '打卡成功', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.msg || '打卡失败', icon: 'none' })
    }
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/sport-detail/sport-detail?id=${id}` })
  },

  async deleteRecord(e) {
    const id = e.currentTarget.dataset.id
    const res = await wx.showModal({ title: '删除记录', content: '确定删除这条运动记录吗？', showCancel: true })
    if (!res.confirm) return
    try {
      await app.request({ url: '/api/sport/delete', method: 'POST', data: { id } })
      this.loadAll()
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.msg || '删除失败', icon: 'none' })
    }
  },

  openGoalModal() {
    this.setData({ showGoalModal: true, goalForm: { daily_steps: String(this.data.goal.daily_steps), weekly_days: String(this.data.goal.weekly_days) } })
  },
  closeGoalModal() {
    this.setData({ showGoalModal: false })
  },
  onGoalStepsInput(e) {
    this.setData({ 'goalForm.daily_steps': e.detail.value })
  },
  onGoalDaysInput(e) {
    this.setData({ 'goalForm.weekly_days': e.detail.value })
  },

  async saveGoal() {
    const { daily_steps, weekly_days } = this.data.goalForm
    if (!daily_steps || Number(daily_steps) < 1000) {
      wx.showToast({ title: '每日步数至少1000', icon: 'none' })
      return
    }
    try {
      await app.request({
        url: '/api/sport/goal',
        method: 'POST',
        data: { daily_steps: parseInt(daily_steps), weekly_days: parseInt(weekly_days) || 5 }
      })
      this.closeGoalModal()
      this.loadGoal()
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.msg || '保存失败', icon: 'none' })
    }
  }
})
