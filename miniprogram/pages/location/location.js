const app = getApp()

function formatAddr(row, fallback) {
  if (!row || row.hidden) return fallback || '— —'
  const province = row.province || ''
  const city = row.city || ''
  const district = row.district || ''
  const street = row.street || row.poi || ''
  const parts = [province, city, district, street].filter(Boolean)
  if (parts.length) return parts.join(' · ')
  return row.address || fallback || '位置已获取'
}

function getMapScale(km) {
  if (km == null || km <= 0) return 14
  if (km < 1) return 16
  if (km < 5) return 14
  if (km < 20) return 12
  if (km < 100) return 10
  if (km < 500) return 8
  return 6
}

function calcCenterAndScale(me, ta) {
  const hasMe = me && me.lat != null && me.lng != null
  const hasTa = ta && ta.lat != null && ta.lng != null && !ta.hidden
  if (!hasMe && !hasTa) return null
  if (hasMe && !hasTa) return { latitude: Number(me.lat), longitude: Number(me.lng), scale: 14 }
  if (!hasMe && hasTa) return { latitude: Number(ta.lat), longitude: Number(ta.lng), scale: 14 }
  const lat1 = Number(me.lat), lng1 = Number(me.lng)
  const lat2 = Number(ta.lat), lng2 = Number(ta.lng)
  const centerLat = (lat1 + lat2) / 2
  const centerLng = (lng1 + lng2) / 2
  const R = 6371
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLng = (lng2 - lng1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2
  const km = 2 * R * Math.asin(Math.sqrt(a))
  return { latitude: centerLat, longitude: centerLng, scale: getMapScale(km), distanceKm: km }
}

Page({
  data: {
    distance: '— —',
    updated: '暂无位置数据',
    myLoc: '未设置',
    myCity: '',
    taLoc: '— —',
    taCity: '',
    isSameCity: false,
    visible: true,
    showMap: false,
    mapLatitude: 39.9042,
    mapLongitude: 116.4074,
    mapScale: 14,
    markers: [],
    polyline: [],
    inputAddr: '',
    searching: false
  },

  onLoad() { this.loadData() },
  onShow() {
    this.loadData()
    this.startAutoRefresh()
  },
  onHide() { this.stopAutoRefresh() },
  onUnload() { this.stopAutoRefresh() },

  startAutoRefresh() {
    this.stopAutoRefresh()
    this._refreshTimer = setInterval(() => { this.loadData() }, 60000)
  },
  stopAutoRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer)
      this._refreshTimer = null
    }
  },

  async loadData() {
    try {
      const snap = await app.getLocationSnap() || {}
      const me = snap.my || snap.me || {}
      const ta = snap.ta || {}
      const myVisible = snap.visible_to_ta !== false && (me.visible === undefined || me.visible !== 0)
      app.setLocationVisible(myVisible)
      const dist = snap.distance_km
      let distance = '— —'
      if (typeof dist === 'number') distance = dist.toFixed(1) + ' 公里'
      else if (typeof dist === 'string' && dist) distance = dist.includes('公里') ? dist : (dist + ' 公里')

      // 如果还没有设置过位置，首次进入时尝试自动定位
      if (!me.lat && !me.lng) {
        this.autoLocateOnce()
      }

      const hasMe = !!(me.lat != null && me.lng != null)
      const hasTa = !!(ta.lat != null && ta.lng != null)
      const taHidden = !!ta.hidden

      const mapData = calcCenterAndScale(me, ta)
      const markers = []
      const polyline = []
      if (mapData) {
        if (hasMe) {
          markers.push({
            id: 1,
            latitude: Number(me.lat),
            longitude: Number(me.lng),
            title: '我',
            iconPath: '/assets/marker.png',
            width: 1,
            height: 1,
            callout: { content: '我', color: '#FFFFFF', fontSize: 14, borderRadius: 12, bgColor: '#8B5CF6', padding: 6, display: 'ALWAYS', anchorX: 0, anchorY: -36 },
            anchor: { x: 0.5, y: 1 }
          })
        }
        if (hasTa && !taHidden) {
          markers.push({
            id: 2,
            latitude: Number(ta.lat),
            longitude: Number(ta.lng),
            title: 'TA',
            iconPath: '/assets/marker.png',
            width: 1,
            height: 1,
            callout: { content: 'TA', color: '#FFFFFF', fontSize: 14, borderRadius: 12, bgColor: '#FF6B8B', padding: 6, display: 'ALWAYS', anchorX: 0, anchorY: -36 },
            anchor: { x: 0.5, y: 1 }
          })
        }
        if (hasMe && hasTa && !taHidden) {
          polyline.push({
            points: [
              { latitude: Number(me.lat), longitude: Number(me.lng) },
              { latitude: Number(ta.lat), longitude: Number(ta.lng) }
            ],
            color: '#FF8FAB',
            width: 3,
            dottedLine: true,
            arrowLine: false
          })
        }
      }

      this.setData({
        myLoc: hasMe ? formatAddr(me, '位置已设置') : '未设置',
        myCity: me.city || (hasMe ? '已设置' : ''),
        taLoc: taHidden
          ? 'TA 已隐藏位置'
          : (hasTa ? formatAddr(ta, '位置已设置') : 'TA 没设置位置'),
        taCity: taHidden ? '' : (ta.city || (hasTa ? '已设置' : '')),
        isSameCity: !!(me.city && ta.city && me.city === ta.city),
        visible: myVisible,
        distance,
        updated: me.updated_at ? (new Date(me.updated_at).toLocaleString() + ' 更新') : '还没设置过位置',
        showMap: !!mapData,
        mapLatitude: mapData ? mapData.latitude : 39.9042,
        mapLongitude: mapData ? mapData.longitude : 116.4074,
        mapScale: mapData ? mapData.scale : 14,
        markers,
        polyline
      })
    } catch (e) {
      const msg = (e && (e.msg || e.message)) || '位置加载失败'
      app.safeToast({ title: msg, icon: 'none', duration: 2000 })
    }
  },

  onAddrInput(e) {
    this.setData({ inputAddr: e.detail.value || '' })
  },

  async submitLocation() {
    const addr = (this.data.inputAddr || '').trim()
    if (!addr) {
      wx.showToast({ title: '输入你的位置，如「北京海淀」', icon: 'none' })
      return
    }
    if (this.data.searching) return
    this.setData({ searching: true })
    wx.showLoading({ title: '搜索位置…', mask: true })
    try {
      const geo = await app.searchLocation(addr)
      wx.hideLoading()
      if (!geo || !geo.lat) {
        wx.showToast({ title: '没找到这个地方，换个词试试', icon: 'none' })
        this.setData({ searching: false })
        return
      }
      wx.showLoading({ title: '保存中…', mask: true })
      await app.saveLocation({
        latitude: geo.lat,
        longitude: geo.lng,
        lat: geo.lat,
        lng: geo.lng,
        province: geo.province || '',
        city: geo.city || '',
        district: geo.district || '',
        street: geo.street || '',
        poi: geo.poi || '',
        address: geo.address || geo.full_address || '',
        visible: this.data.visible,
        visible_to_ta: this.data.visible
      })
      app.setLocationVisible(this.data.visible)
      wx.hideLoading()
      wx.setStorageSync('lastLocation', {
        lat: geo.lat,
        lng: geo.lng,
        city: geo.city || '',
        district: geo.district || '',
        address: geo.address || ''
      })
      this.setData({ searching: false, inputAddr: '' })
      wx.showToast({ title: '位置已设置 🌍', icon: 'none' })
      this.loadData()
    } catch (e) {
      wx.hideLoading()
      this.setData({ searching: false })
      const msg = (e && (e.msg || e.message)) || '设置失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  async toggleVisible() {
    const next = !this.data.visible
    try {
      const me = wx.getStorageSync('lastLocation') || {}
      if (me.lat == null || me.lng == null) {
        wx.showToast({ title: '先更新你的位置', icon: 'none' })
        return
      }
      wx.showLoading({ title: '更新中…', mask: true })
      await app.saveLocation({
        lat: me.lat,
        lng: me.lng,
        latitude: me.lat,
        longitude: me.lng,
        province: me.province || '',
        city: me.city || '',
        district: me.district || '',
        address: me.address || '',
        visible: next,
        visible_to_ta: next
      })
      app.setLocationVisible(next)
      wx.hideLoading()
      this.setData({ visible: next })
      wx.showToast({ title: next ? '已开启位置可见' : '已对 TA 隐藏位置', icon: 'none' })
    } catch (e) {
      wx.hideLoading()
      const msg = (e && (e.msg || e.message)) || '更新失败'
      wx.showToast({ title: msg, icon: 'none' })
    }
  },

  // 首次进入且未设置位置时自动定位一次
  async autoLocateOnce() {
    if (this._autoLocating || this._autoLocated) return
    this._autoLocating = true
    try {
      await this.doGetLocation()
      this._autoLocated = true
    } catch (_) {}
    this._autoLocating = false
  },

  // 用户手动触发自动定位
  async updateMyLocation() {
    return this.doGetLocation(true)
  },

  async doGetLocation(showToast = false) {
    try {
      // 1. 检查权限状态
      const setting = await new Promise((resolve) => wx.getSetting({ success: resolve, fail: () => resolve({ authSetting: {} }) }))
      const authSetting = (setting && setting.authSetting) || {}
      if (authSetting['scope.userLocation'] === false) {
        wx.showModal({
          title: '需要位置权限',
          content: '请前往设置开启「位置信息」权限，以便在地图上显示你的位置。',
          confirmText: '去设置',
          confirmColor: '#FF8FAB',
          success: (r) => { if (r.confirm) wx.openSetting() }
        })
        return
      }

      wx.showLoading({ title: '定位中…', mask: true })

      // 2. 调用 wx.getLocation，8 秒超时
      const loc = await Promise.race([
        new Promise((resolve, reject) => {
          wx.getLocation({
            type: 'gcj02',
            isHighAccuracy: false,
            success: resolve,
            fail: reject
          })
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('定位超时，请重试')), 8000))
      ])

      // 3. 反解地址
      const geo = await app.reverseGeocode(loc.latitude, loc.longitude)

      // 4. 保存到后端
      await app.saveLocation({
        latitude: loc.latitude,
        longitude: loc.longitude,
        lat: loc.latitude,
        lng: loc.longitude,
        province: geo.province || '',
        city: geo.city || '',
        district: geo.district || '',
        street: geo.street || '',
        address: geo.address || geo.full_address || '',
        poi: geo.poi || '',
        visible: this.data.visible,
        visible_to_ta: this.data.visible
      })
      app.setLocationVisible(this.data.visible)

      wx.setStorageSync('lastLocation', {
        lat: loc.latitude,
        lng: loc.longitude,
        city: geo.city || '',
        district: geo.district || '',
        address: geo.address || ''
      })

      wx.hideLoading()
      if (showToast) wx.showToast({ title: '位置已更新 📍', icon: 'none' })
      this.loadData()
    } catch (e) {
      wx.hideLoading()
      const raw = (e && (e.errMsg || e.msg || e.message)) || '定位失败'
      if (showToast) {
        wx.showToast({ title: String(raw).slice(0, 40), icon: 'none', duration: 2500 })
      }
      throw e
    }
  },

  goHome() {
    try { wx.switchTab({ url: '/pages/index/index' }) } catch (e) {}
  },

  onShareAppMessage() {
    return {
      title: '情侣心情录｜知道你在，就很安心 💕',
      path: '/pages/profile/profile'
    }
  },

  onShareTimeline() {
    return { title: '情侣心情录 · 知道你在就很安心 📍' }
  }
})
