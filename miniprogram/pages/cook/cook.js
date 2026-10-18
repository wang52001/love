const app = getApp()
const STATUS_TEXT = { pending: '待做', done: '已做好', cancel: '已取消' }

Page({
  data: {
    isCook: false,
    cookUser: null,
    ta: null,
    dishes: [],
    orders: [],
    announcements: [],
    selectedDishIds: {},
    selectedDishNotes: {},
    selectedDishList: [],
    newDish: '',
    newDishImage: '',
    orderNote: '',
    announceText: '',
    meals: ['早餐', '午餐', '晚餐', '夜宵'],
    mealIndex: 1,
    apiBase: app.globalData.apiBase
  },

  onShow() {
    this.loadAll()
    this.setMealIndexByHour()
  },

  setMealIndexByHour() {
    const h = new Date().getHours()
    let idx = 1
    if (h < 10) idx = 0
    else if (h < 15) idx = 1
    else if (h < 20) idx = 2
    else idx = 3
    this.setData({ mealIndex: idx })
  },

  async loadAll() {
    wx.showLoading({ title: '加载中' })
    try {
      const status = await app.request({ url: '/api/cook/status' })
      const base = app.globalData.apiBase
      const dishes = (status.dishes || []).map(d => ({
        ...d,
        imageUrl: d.image ? (base + d.image) : ''
      }))
      const orders = (status.orders || []).map(o => {
        const ids = this.parseIds(o.dish_ids)
        const notesMap = this.parseNotes(o.dish_notes)
        const names = ids.map(id => {
          const d = dishes.find(x => x.id === id)
          return d ? d.name : '未知菜品'
        }).join('、')
        // 每道菜的备注
        const dishNotes = ids.map(id => {
          const d = dishes.find(x => x.id === id)
          const n = notesMap[id] || ''
          return { id, name: d ? d.name : '未知菜品', note: n }
        }).filter(x => x.note)
        return { ...o, statusText: STATUS_TEXT[o.status] || o.status, dishNames: names, dishNotes }
      })
      this.setData({
        isCook: status.isCook,
        cookUser: status.cookUser,
        ta: status.ta,
        dishes,
        orders,
        announcements: status.announcements || []
      })
    } catch (e) {
      app.safeToast({ title: e.msg || '加载失败', icon: 'none' })
    }
    wx.hideLoading()
  },

  parseIds(v) {
    if (!v) return []
    try {
      const arr = JSON.parse(v)
      return Array.isArray(arr) ? arr : [v]
    } catch (_) { return [v] }
  },

  parseNotes(v) {
    if (!v) return {}
    try {
      const obj = JSON.parse(v)
      return (obj && typeof obj === 'object') ? obj : {}
    } catch (_) { return {} }
  },

  toggleDish(e) {
    const id = e.currentTarget.dataset.id
    const map = { ...this.data.selectedDishIds }
    const notesMap = { ...this.data.selectedDishNotes }
    if (map[id]) {
      delete map[id]
      delete notesMap[id]
    } else {
      map[id] = true
    }
    this.setData({ selectedDishIds: map, selectedDishNotes: notesMap })
    this.refreshSelectedList()
  },

  onDishNoteInput(e) {
    const id = e.currentTarget.dataset.id
    const notesMap = { ...this.data.selectedDishNotes }
    notesMap[id] = e.detail.value
    this.setData({ selectedDishNotes: notesMap })
    this.refreshSelectedList()
  },

  refreshSelectedList() {
    const { selectedDishIds, selectedDishNotes, dishes } = this.data
    const list = Object.keys(selectedDishIds).map(id => {
      const d = dishes.find(x => x.id === id)
      return { id, name: d ? d.name : '未知菜品', note: selectedDishNotes[id] || '' }
    })
    this.setData({ selectedDishList: list })
  },

  onDishInput(e) { this.setData({ newDish: e.detail.value }) },

  chooseDishImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const tempPath = res.tempFiles && res.tempFiles[0] && res.tempFiles[0].tempFilePath
        if (tempPath) this.setData({ newDishImage: tempPath })
      }
    })
  },

  removeDishImage() {
    this.setData({ newDishImage: '' })
  },

  async addDish() {
    const name = this.data.newDish.trim()
    if (!name) { app.safeToast({ title: '请输入菜品名称', icon: 'none' }); return }
    wx.showLoading({ title: '添加中' })
    try {
      let image_base64 = ''
      if (this.data.newDishImage) {
        image_base64 = await app.avatarToBase64(this.data.newDishImage)
      }
      await app.request({ url: '/api/cook/dish', method: 'POST', data: { name, image_base64 } })
      this.setData({ newDish: '', newDishImage: '' })
      app.safeToast({ title: '添加成功', icon: 'success' })
      this.loadAll()
    } catch (e) { app.safeToast({ title: e.msg || '添加失败', icon: 'none' }) }
    wx.hideLoading()
  },

  async deleteDish(e) {
    const id = e.currentTarget.dataset.id
    try {
      await app.request({ url: '/api/cook/dish/delete', method: 'POST', data: { id } })
      this.loadAll()
    } catch (e) { app.safeToast({ title: e.msg || '删除失败', icon: 'none' }) }
  },

  previewDishImage(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const urls = this.data.dishes.map(d => d.imageUrl).filter(Boolean)
    wx.previewImage({ current: url, urls })
  },

  async assignMe() {
    const userInfo = wx.getStorageSync('userInfo') || {}
    try {
      await app.request({ url: '/api/cook/assign', method: 'POST', data: { cook_user_id: userInfo.id } })
      this.loadAll()
    } catch (e) { app.safeToast({ title: e.msg || '设置失败', icon: 'none' }) }
  },

  async assignTa() {
    if (!this.data.ta) return
    try {
      await app.request({ url: '/api/cook/assign', method: 'POST', data: { cook_user_id: this.data.ta.id } })
      this.loadAll()
    } catch (e) { app.safeToast({ title: e.msg || '设置失败', icon: 'none' }) }
  },

  switchCook() {
    wx.showActionSheet({
      itemList: ['我来做饭', '让 TA 做饭'],
      success: (res) => {
        if (res.tapIndex === 0) this.assignMe()
        else this.assignTa()
      }
    })
  },

  onMealChange(e) { this.setData({ mealIndex: Number(e.detail.value) }) },
  onOrderNoteInput(e) { this.setData({ orderNote: e.detail.value }) },

  async submitOrder() {
    const ids = Object.keys(this.data.selectedDishIds)
    if (!ids.length) { app.safeToast({ title: '请至少选一道菜', icon: 'none' }); return }
    try {
      await app.request({
        url: '/api/cook/order',
        method: 'POST',
        data: {
          meal_type: this.data.meals[this.data.mealIndex],
          dish_ids: ids,
          note: this.data.orderNote,
          dish_notes: this.data.selectedDishNotes
        }
      })
      this.setData({ selectedDishIds: {}, selectedDishNotes: {}, selectedDishList: [], orderNote: '' })
      app.safeToast({ title: '下单成功', icon: 'success' })
      this.loadAll()
    } catch (e) { app.safeToast({ title: e.msg || '下单失败', icon: 'none' }) }
  },

  async setOrderStatus(e) {
    const { id, status } = e.currentTarget.dataset
    try {
      await app.request({ url: '/api/cook/order/status', method: 'POST', data: { id, status } })
      this.loadAll()
    } catch (e) { app.safeToast({ title: e.msg || '操作失败', icon: 'none' }) }
  },

  onAnnounceInput(e) { this.setData({ announceText: e.detail.value }) },

  async postAnnounce() {
    const content = this.data.announceText.trim()
    if (!content) return
    try {
      await app.request({ url: '/api/cook/announcement', method: 'POST', data: { content, active_days: 7 } })
      this.setData({ announceText: '' })
      app.safeToast({ title: '发布成功', icon: 'success' })
      this.loadAll()
    } catch (e) { app.safeToast({ title: e.msg || '发布失败', icon: 'none' }) }
  }
})
