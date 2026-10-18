const app = getApp()

const SPORT_TYPES = {
  walk: { name: '散步', emoji: '🚶' },
  run: { name: '跑步', emoji: '🏃' },
  bike: { name: '骑行', emoji: '🚴' },
  hike: { name: '徒步', emoji: '🥾' },
  other: { name: '运动', emoji: '💪' }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

Page({
  data: {
    id: '',
    record: {},
    typeName: '运动',
    typeEmoji: '💪',
    centerLat: 30.2741,
    centerLng: 120.1551,
    points: [],
    polyline: [],
    markers: [],
    pace: '--',
    formatDuration: '00:00:00'
  },

  onLoad(options) {
    if (!options.id) {
      wx.showToast({ title: '缺少记录ID', icon: 'none' })
      return
    }
    this.setData({ id: options.id })
    this.loadDetail()
  },

  async loadDetail() {
    try {
      const res = await app.request({ url: `/api/sport/detail?id=${this.data.id}` })
      const t = SPORT_TYPES[res.sport_type] || SPORT_TYPES.other
      const points = Array.isArray(res.track) ? res.track : []
      const duration = parseInt(res.duration) || 0
      const distance = Number(res.distance) || 0
      const pace = distance > 0 && duration > 0
        ? (duration / 60 / distance).toFixed(2) + ' 分/公里'
        : '--'
      const center = points.length > 0 ? points[points.length - 1] : { latitude: 30.2741, longitude: 120.1551 }
      this.setData({
        record: res,
        typeName: t.name,
        typeEmoji: t.emoji,
        points,
        centerLat: center.latitude,
        centerLng: center.longitude,
        polyline: points.length >= 2 ? [{
          points: points.map(p => ({ latitude: Number(p.latitude) || 0, longitude: Number(p.longitude) || 0 })),
          color: '#A8E6CF',
          width: 6
        }] : [],
        markers: points.length > 0 ? [
          { id: 1, latitude: points[0].latitude, longitude: points[0].longitude, width: 24, height: 24, title: '起点' },
          { id: 2, latitude: points[points.length - 1].latitude, longitude: points[points.length - 1].longitude, width: 24, height: 24, title: '终点' }
        ] : [],
        pace,
        formatDuration: formatDuration(duration)
      })
    } catch (e) {
      wx.showToast({ title: e.msg || '加载失败', icon: 'none' })
    }
  }
})
