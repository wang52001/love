const app = getApp()

const SPORT_TYPES = {
  walk: { name: '散步', emoji: '🚶' },
  run: { name: '跑步', emoji: '🏃' },
  bike: { name: '骑行', emoji: '🚴' },
  hike: { name: '徒步', emoji: '🥾' },
  other: { name: '运动', emoji: '💪' }
}

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
    sportType: 'walk',
    typeName: '散步',
    typeEmoji: '🚶',
    isTracking: false,
    elapsed: 0,
    distance: 0,
    speed: '0.0',
    points: [],
    centerLat: 30.2741,
    centerLng: 120.1551,
    polyline: [],
    markers: []
  },

  timer: null,
  locationListener: null,
  startTime: 0,
  pausedElapsed: 0,
  lastPoint: null,

  onLoad(options) {
    const type = options.type || 'walk'
    const t = SPORT_TYPES[type] || SPORT_TYPES.walk
    this.setData({ sportType: type, typeName: t.name, typeEmoji: t.emoji })
    this.initLocation()
  },

  onUnload() {
    this.stopAll()
  },

  stopAll() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.locationListener) {
      try { wx.offLocationChange(this.locationListener) } catch (_) {}
      this.locationListener = null
    }
    try { wx.stopLocationUpdate({ fail: () => {} }) } catch (_) {}
    try { if (wx.stopLocationUpdateBackground) wx.stopLocationUpdateBackground({ fail: () => {} }) } catch (_) {}
  },

  initLocation() {
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({
          centerLat: res.latitude,
          centerLng: res.longitude
        })
      },
      fail: () => {
        wx.showToast({ title: '请授权位置权限', icon: 'none' })
      }
    })
  },

  startTrack() {
    this.setData({ isTracking: true })
    this.startTime = Date.now() - this.data.elapsed * 1000
    this.startTimer()
    this.startLocation()
  },

  pauseTrack() {
    this.setData({ isTracking: false })
    this.pausedElapsed = this.data.elapsed
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  resumeTrack() {
    this.setData({ isTracking: true })
    this.startTime = Date.now() - this.pausedElapsed * 1000
    this.startTimer()
  },

  finishTrack() {
    if (this.data.isTracking) this.pauseTrack()
    const { elapsed, distance, points, sportType, typeName, typeEmoji } = this.data
    if (elapsed < 3 && points.length < 2) {
      wx.showModal({ title: '运动时间太短', content: '确定要结束吗？', showCancel: true })
      return
    }
    const payload = {
      sport_type: sportType,
      duration: elapsed,
      distance: Number(distance.toFixed(2)),
      steps: Math.floor(distance * 1300),
      note: `${typeName}打卡 · ${formatDuration(elapsed)}`,
      sport_date: today(),
      track: points.slice(0, 500)
    }
    wx.showLoading({ title: '保存中' })
    app.request({ url: '/api/sport/checkin', method: 'POST', data: payload })
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '保存成功', icon: 'success' })
        setTimeout(() => {
          wx.navigateBack()
        }, 800)
      })
      .catch((e) => {
        wx.hideLoading()
        wx.showToast({ title: e.msg || '保存失败', icon: 'none' })
      })
  },

  startTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000)
      this.setData({ elapsed })
    }, 1000)
  },

  startLocation() {
    if (this.locationListener) {
      wx.offLocationChange(this.locationListener)
    }
    this.locationListener = (res) => {
      const point = {
        latitude: res.latitude,
        longitude: res.longitude,
        timestamp: Date.now()
      }
      let newDistance = this.data.distance
      if (this.lastPoint) {
        const d = this.getDistance(this.lastPoint.latitude, this.lastPoint.longitude, point.latitude, point.longitude)
        if (d > 0.001) newDistance += d
      }
      this.lastPoint = point
      const points = [...this.data.points, point]
      const speed = this.data.elapsed > 0 ? ((newDistance / (this.data.elapsed || 1)) * 3600).toFixed(1) : '0.0'
      const polyline = points.length >= 2 ? [{
        points: points.map(p => ({ latitude: p.latitude, longitude: p.longitude })),
        color: '#A8E6CF',
        width: 6,
        arrowLine: false
      }] : []
      this.setData({
        points,
        distance: newDistance,
        speed,
        centerLat: point.latitude,
        centerLng: point.longitude,
        polyline,
        markers: [{
          id: 1,
          latitude: point.latitude,
          longitude: point.longitude,
          width: 24,
          height: 24,
          title: '当前位置'
        }]
      })
    }
    wx.onLocationChange(this.locationListener)
    wx.startLocationUpdate({
      fail: (err) => {
        console.error('start location update fail', err)
        wx.showToast({ title: '定位启动失败', icon: 'none' })
      }
    })
  },

  getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }
})
