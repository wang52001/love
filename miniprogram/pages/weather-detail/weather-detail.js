const app = getApp()

Page({
  data: {
    city: '',
    address: '',
    displayAddress: '',
    displayDistrict: '',
    lat: 0,
    lon: 0,
    loading: true,
    current: null,
    hourly: [],
    daily: []
  },

  onLoad(options) {
    const city = this.safeDecode(options.city)
    const address = this.safeDecode(options.address)
    const lat = Number(options.lat) || 0
    const lon = Number(options.lon) || 0
    if (!lat || !lon) {
      wx.showToast({ title: '缺少位置信息', icon: 'none' })
      this.setData({ loading: false })
      return
    }
    const displayAddress = this.formatAddress(address)
    const displayDistrict = app.getDistrictLabel({ city, address })
    this.setData({ city, address, displayAddress, displayDistrict, lat, lon })
    const title = displayDistrict || city || '天气'
    try { wx.setNavigationBarTitle({ title: title + ' 天气' }) } catch (_) {}
    this.loadForecast(lat, lon)
  },

  safeDecode(v) {
    if (!v) return ''
    try { return decodeURIComponent(v) } catch (_) { return v }
  },

  formatAddress(address) {
    if (!address) return ''
    const parts = address.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    if (parts.length <= 1) return address
    return parts.slice().reverse().join(' · ')
  },

  async loadForecast(lat, lon) {
    try {
      const res = await app.getWeatherForecast(lat, lon)
      if (!res) throw new Error('获取预报失败')
      this.setData({
        current: res.current,
        hourly: app.toArr(res.hourly),
        daily: app.toArr(res.daily),
        loading: false
      })
    } catch (e) {
      this.setData({ loading: false })
      app.safeToast({ title: '预报加载失败', icon: 'none' })
    }
  },

  onPullDownRefresh() {
    const { lat, lon } = this.data
    if (lat && lon) {
      this.loadForecast(lat, lon).then(() => wx.stopPullDownRefresh())
    } else {
      wx.stopPullDownRefresh()
    }
  }
})
