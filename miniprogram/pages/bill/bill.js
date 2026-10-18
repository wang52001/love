const app = getApp()

const CATEGORY_LIST = [
  { key: 'food', name: '吃饭', emoji: '🍔' },
  { key: 'travel', name: '旅行', emoji: '✈️' },
  { key: 'gift', name: '礼物', emoji: '🎁' },
  { key: 'entertainment', name: '娱乐', emoji: '🎬' },
  { key: 'living', name: '生活', emoji: '🏠' },
  { key: 'other', name: '其他', emoji: '📝' }
]

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

Page({
  data: {
    categoryList: CATEGORY_LIST,
    list: [],
    stats: { total: 0, count: 0, by_category: {} },
    categories: CATEGORY_LIST.map(c => ({ ...c, amount: '0.00' })),
    fund: null,
    advice: '',
    adviceLoading: false,
    showBillModal: false,
    showFundModal: false,
    billForm: { amount: '', category: 'food', note: '', bill_date: today() },
    fundForm: { name: '', target_amount: '', saved_amount: '', deadline: '' }
  },

  onLoad() {
    this.loadAll()
  },

  onShow() {
    this.loadAll()
  },

  async loadAll() {
    await Promise.all([this.loadBills(), this.loadFund(), this.loadAdvice()])
  },

  async loadBills() {
    try {
      const res = await app.request({ url: '/api/bills/list' })
      const list = app.toArr(res.list).map(r => ({
        ...r,
        amount: Number(r.amount || 0).toFixed(2),
        cat_emoji: CATEGORY_LIST.find(c => c.key === r.category)?.emoji || '📝'
      }))
      const by = res.stats && res.stats.by_category ? res.stats.by_category : {}
      const categories = CATEGORY_LIST.map(c => ({
        ...c,
        amount: Number(by[c.key] || 0).toFixed(2)
      }))
      this.setData({
        list,
        stats: {
          total: Number(res.stats && res.stats.total || 0).toFixed(2),
          count: res.stats && res.stats.count || 0,
          by_category: by
        },
        categories
      })
    } catch (e) {
      console.error('load bills err', e)
    }
  },

  async loadFund() {
    try {
      const fund = await app.request({ url: '/api/funds/get' })
      if (fund) {
        fund.target_amount = Number(fund.target_amount || 0).toFixed(2)
        fund.saved_amount = Number(fund.saved_amount || 0).toFixed(2)
        const pct = Number(fund.target_amount) > 0 ? (Number(fund.saved_amount) / Number(fund.target_amount)) * 100 : 0
        fund.progressPct = Math.min(100, pct).toFixed(1)
      }
      this.setData({ fund })
    } catch (e) {
      console.error('load fund err', e)
    }
  },

  async loadAdvice() {
    this.setData({ adviceLoading: true })
    try {
      const res = await app.request({ url: '/api/bills/advice' })
      this.setData({ advice: res.advice || '', adviceLoading: false })
    } catch (e) {
      this.setData({ advice: 'AI 建议加载失败，稍后再试', adviceLoading: false })
    }
  },

  openBillModal() {
    this.setData({ showBillModal: true, billForm: { amount: '', category: 'food', note: '', bill_date: today() } })
  },
  closeBillModal() {
    this.setData({ showBillModal: false })
  },
  onAmountInput(e) {
    this.setData({ 'billForm.amount': e.detail.value })
  },
  onNoteInput(e) {
    this.setData({ 'billForm.note': e.detail.value })
  },
  onDateChange(e) {
    this.setData({ 'billForm.bill_date': e.detail.value })
  },
  selectCategory(e) {
    this.setData({ 'billForm.category': e.currentTarget.dataset.key })
  },

  async saveBill() {
    const { amount, category, note, bill_date } = this.data.billForm
    if (!amount || Number(amount) <= 0) {
      wx.showToast({ title: '请输入金额', icon: 'none' })
      return
    }
    try {
      await app.request({
        url: '/api/bills/add',
        method: 'POST',
        data: { amount: Number(amount).toFixed(2), category, note, bill_date }
      })
      this.closeBillModal()
      this.loadAll()
      wx.showToast({ title: '记账成功', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.msg || '记账失败', icon: 'none' })
    }
  },

  async deleteBill(e) {
    const id = e.currentTarget.dataset.id
    const res = await wx.showModal({ title: '删除账单', content: '确定删除这条账单吗？', showCancel: true })
    if (!res.confirm) return
    try {
      await app.request({ url: '/api/bills/delete', method: 'POST', data: { id } })
      this.loadAll()
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.msg || '删除失败', icon: 'none' })
    }
  },

  openFundModal() {
    const f = this.data.fund
    this.setData({
      showFundModal: true,
      fundForm: {
        name: f ? f.name : '',
        target_amount: f ? String(f.target_amount) : '',
        saved_amount: f ? String(f.saved_amount) : '',
        deadline: f ? (f.deadline || '') : ''
      }
    })
  },
  closeFundModal() {
    this.setData({ showFundModal: false })
  },
  onFundNameInput(e) {
    this.setData({ 'fundForm.name': e.detail.value })
  },
  onFundTargetInput(e) {
    this.setData({ 'fundForm.target_amount': e.detail.value })
  },
  onFundSavedInput(e) {
    this.setData({ 'fundForm.saved_amount': e.detail.value })
  },
  onFundDateChange(e) {
    this.setData({ 'fundForm.deadline': e.detail.value })
  },

  async saveFund() {
    const { name, target_amount, saved_amount, deadline } = this.data.fundForm
    if (!name || !target_amount || Number(target_amount) <= 0) {
      wx.showToast({ title: '请填写目标名称和金额', icon: 'none' })
      return
    }
    try {
      await app.request({
        url: '/api/funds/set',
        method: 'POST',
        data: { name, target_amount: Number(target_amount).toFixed(2), saved_amount: Number(saved_amount || 0).toFixed(2), deadline }
      })
      this.closeFundModal()
      this.loadAll()
      wx.showToast({ title: '已保存', icon: 'success' })
    } catch (e) {
      wx.showToast({ title: e.msg || '保存失败', icon: 'none' })
    }
  }
})
