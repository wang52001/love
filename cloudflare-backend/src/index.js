// ============================================================
// 小气候 - Cloudflare Worker API
// 技术：原生 JS + Web Crypto (HMAC JWT) + D1 + KV
// 部署：wrangler deploy
// ============================================================

// ---------- 工具函数 ----------
const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })

const nowISO = () => new Date().toISOString()
const today = () => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}
const tomorrow = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
const fmtDate = (iso) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
const rowsOf = (x) => {
  if (!x) return []
  if (Array.isArray(x)) return x
  if (Array.isArray(x.results)) return x.results
  if (Array.isArray(x.rows)) return x.rows
  if (Array.isArray(x.data)) return x.data
  try {
    const keys = Object.keys(x).filter(k => k !== 'success' && k !== 'meta' && k !== 'duration' && k !== 'error')
    for (const k of keys) if (Array.isArray(x[k])) return x[k]
  } catch (_) {}
  return []
}

// ---------- 情绪合成规则（基于情绪分类） ----------
// 情绪分类：positive(积极) / neutral(中性) / negative(消极)
const EMOTION_CATEGORIES = {
  '心动': 'positive', '开心': 'positive', '兴奋': 'positive', '惊喜': 'positive',
  '平静': 'neutral', '疲惫': 'neutral',
  '难过': 'negative', '生气': 'negative', '委屈': 'negative', '焦虑': 'negative'
}

// 分类组合 → 合成心情名
const MERGE_RULES = {
  'positive+positive': '甜蜜时刻',
  'neutral+neutral': '岁月静好',
  'negative+negative': '抱抱彼此',
  'neutral+positive': '晴空万里',
  'negative+positive': '冰火两重',
  'negative+neutral': '需要关怀'
}

// 同情绪合成
const SAME_EMOTION_MERGE = '心有灵犀'

// 消极情绪集合（用于预警）
const BAD_EMOTIONS = new Set(['难过', '生气', '委屈', '焦虑'])

function getEmotionCategory(emotion) {
  return EMOTION_CATEGORIES[emotion] || 'neutral'
}

function getMergeMood(a, b) {
  if (!a || !b) return null
  if (a === b) return SAME_EMOTION_MERGE
  const catA = getEmotionCategory(a)
  const catB = getEmotionCategory(b)
  const key = [catA, catB].sort().join('+')
  return MERGE_RULES[key] || '岁月静好'
}

// ---------- WMO 天气码映射（Open-Meteo） ----------
const WMO_CODES = {
  0: { desc: '晴朗', emoji: '☀️' },
  1: { desc: '少云', emoji: '🌤️' },
  2: { desc: '多云', emoji: '⛅' },
  3: { desc: '阴天', emoji: '☁️' },
  45: { desc: '雾', emoji: '🌫️' },
  48: { desc: '冻雾', emoji: '🌫️' },
  51: { desc: '小毛毛雨', emoji: '🌦️' },
  53: { desc: '毛毛雨', emoji: '🌦️' },
  55: { desc: '大毛毛雨', emoji: '🌧️' },
  61: { desc: '小雨', emoji: '🌧️' },
  63: { desc: '中雨', emoji: '🌧️' },
  65: { desc: '大雨', emoji: '🌧️' },
  71: { desc: '小雪', emoji: '🌨️' },
  73: { desc: '中雪', emoji: '🌨️' },
  75: { desc: '大雪', emoji: '❄️' },
  80: { desc: '阵雨', emoji: '🌦️' },
  81: { desc: '中阵雨', emoji: '🌧️' },
  82: { desc: '大阵雨', emoji: '⛈️' },
  95: { desc: '雷暴', emoji: '⛈️' },
  96: { desc: '雷暴冰雹', emoji: '⛈️' },
  99: { desc: '强雷暴冰雹', emoji: '⛈️' }
}

// ---------- HMAC JWT 简单实现 ----------
const b64urlEncode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
const b64urlDecode = (s) => {
  s = s.replace(/-/g,'+').replace(/_/g,'/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr.buffer
}
async function hmacSHA256(keyStr, msgStr) {
  const keyBuf = new TextEncoder().encode(keyStr)
  const msgBuf = new TextEncoder().encode(msgStr)
  const key = await crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, msgBuf)
  return b64urlEncode(sig)
}
async function signJWT(payload, secret) {
  const head = b64urlEncode(new TextEncoder().encode(JSON.stringify({alg:'HS256',typ:'JWT'})))
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    ...payload, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 30*24*3600
  })))
  const sig = await hmacSHA256(secret, `${head}.${body}`)
  return `${head}.${body}.${sig}`
}
async function verifyJWT(token, secret) {
  try {
    const [head, body, sig] = token.split('.')
    if (!head || !body || !sig) return null
    const expected = await hmacSHA256(secret, `${head}.${body}`)
    if (expected !== sig) return null
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)))
    if (payload.exp && payload.exp < Math.floor(Date.now()/1000)) return null
    return payload
  } catch (e) { return null }
}

// ---------- 返回 JSON ----------
const FALLBACK_JWT_SECRET = 'REDACTED'
const FALLBACK_ADMIN_PASS = 'REDACTED'
const FALLBACK_WECHAT_APPID = 'wxa35a4a7feac8ab7b'

function withEnv(env) {
  return new Proxy(env, {
    get(target, p) {
      const v = target[p]
      if (typeof v !== 'undefined') return v
      if (p === 'JWT_SECRET') return FALLBACK_JWT_SECRET
      if (p === 'ADMIN_PASS') return FALLBACK_ADMIN_PASS
      if (p === 'WECHAT_APPID') return FALLBACK_WECHAT_APPID
      // WECHAT_SECRET 不提供 fallback — 必须通过 wrangler secret put WECHAT_SECRET 配置真实 AppSecret
      // 未配置时返回 undefined，登录会走 mock_openid，小程序码会报错提示
      return v
    }
  })
}

function json(data, code=0, msg='ok', status=200, extraHeaders={}) {
  return new Response(JSON.stringify({ code, data, msg }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...extraHeaders
    }
  })
}

function corsOptions() {
  return new Response('', {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    }
  })
}

// ---------- 路由 Router ----------
class Router {
  constructor() { this.routes = [] }
  add(method, path, handler) {
    const regex = new RegExp('^' + path.replace(/:([^/]+)/g, '(?<$1>[^/]+)') + '/?$')
    this.routes.push({ method, regex, handler })
  }
  async match(method, url, env, ctx) {
    const safeEnv = withEnv(env)
    const path = new URL(url).pathname
    for (const r of this.routes) {
      if (r.method !== method) continue
      const m = path.match(r.regex)
      if (m) return r.handler(safeEnv, ctx, m.groups || {})
    }
    return json({ path }, 404, 'Not Found', 404)
  }
}

const router = new Router()

// ---------- 获取当前登录用户 ----------
async function currentUser(request, env) {
  const auth = request.headers.get('Authorization') || ''
  let token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  // 支持 query 参数传 token（用于 <image> 标签无法设置 header 的场景）
  if (!token) {
    try {
      const u = new URL(request.url)
      token = u.searchParams.get('token') || ''
    } catch (_) {}
  }
  if (!token) return null
  const payload = await verifyJWT(token, env.JWT_SECRET)
  if (!payload || !payload.uid) return null
  const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(payload.uid).first()
  return u || null
}

async function requireUser(request, env) {
  const u = await currentUser(request, env)
  if (!u) throw { code: 401, msg: '未登录或登录已过期' }
  return u
}

// 获取用户所在的绑定情侣
// 优先级：bound > pending > cooling > rejected；优先返回用户作为 B 被邀请的记录
async function getUserCouple(userId, env) {
  return await env.DB.prepare(`
    SELECT * FROM couples
    WHERE status != 'unbound' AND (user_a_id = ? OR user_b_id = ?)
    ORDER BY
      CASE status
        WHEN 'bound' THEN 1
        WHEN 'pending' THEN 2
        WHEN 'cooling' THEN 3
        WHEN 'rejected' THEN 4
        ELSE 5
      END,
      CASE WHEN user_b_id = ? THEN 0 ELSE 1 END,
      updated_at DESC
    LIMIT 1
  `).bind(userId, userId, userId).first()
}

// ---------- 1. 微信登录 ----------
router.add('POST', '/api/auth/login', async (env, ctx) => {
  try {
    const { code, nickname, avatar_url } = await ctx.request.json()
    if (!code) return json({}, 400, '缺少 code 参数', 400)

    // 调用微信 code2Session
    let openid = ''
    let sessionKey = ''
    let usingMock = false
    const wxSecret = env.WECHAT_SECRET
    if (!wxSecret) {
      console.error('[登录警告] WECHAT_SECRET 未配置，使用 mock_openid（账号不固定，仅供开发测试）')
      openid = 'mock_openid_' + code.slice(0, 10)
      usingMock = true
    } else {
      try {
        const resp = await fetch(
          `https://api.weixin.qq.com/sns/jscode2session?appid=${env.WECHAT_APPID}&secret=${wxSecret}&js_code=${code}&grant_type=authorization_code`
        )
        const wx = await resp.json()
        if (wx && wx.openid) {
          openid = wx.openid
          sessionKey = wx.session_key || ''
        } else {
          console.error('[登录错误] 微信 code2Session 失败:', JSON.stringify(wx))
          openid = 'mock_openid_' + code.slice(0, 10)
          usingMock = true
        }
      } catch (e) {
        console.error('[登录异常] code2Session 请求失败:', e.message || e)
        openid = 'mock_openid_' + code.slice(0, 10)
        usingMock = true
      }
    }

    // 查询或创建用户
    let user = await env.DB.prepare('SELECT * FROM users WHERE openid = ?').bind(openid).first()
    if (!user) {
      const id = uuid()
      const now = nowISO()
      await env.DB.prepare(
        'INSERT INTO users (id,openid,nickname,avatar_url,admin_level,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(id, openid, nickname || '', avatar_url || '', 0, now, now).run()
      user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first()
    } else if (nickname || avatar_url) {
      await env.DB.prepare('UPDATE users SET nickname = COALESCE(NULLIF(?,""), nickname), avatar_url = COALESCE(NULLIF(?,""), avatar_url), updated_at = ? WHERE id = ?')
        .bind(nickname || '', avatar_url || '', nowISO(), user.id).run()
      user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()
    }

    // 保存 session_key（虚拟支付「用户态签名」必需；columns 由 ensureVipTables / 此处兜底创建）
    if (sessionKey) {
      try { await env.DB.prepare('ALTER TABLE users ADD COLUMN session_key TEXT').run() } catch (_) {}
      try { await env.DB.prepare('UPDATE users SET session_key = ? WHERE id = ?').bind(sessionKey, user.id).run() } catch (_) {}
    }

    const token = await signJWT({ uid: user.id, openid: user.openid }, env.JWT_SECRET)
    return json({
      token,
      user: { id: user.id, nickname: user.nickname, avatar_url: user.avatar_url, gender: Number(user.gender || 0), admin_level: user.admin_level, created_at: user.created_at },
      using_mock: usingMock
    })
  } catch (e) {
    console.error('login err', e)
    return json({}, 500, e.message || '登录失败', 500)
  }
})

// 更新头像昵称
router.add('POST', '/api/auth/profile', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const body = await ctx.request.json()
    await env.DB.prepare('UPDATE users SET nickname = COALESCE(NULLIF(?,""), nickname), avatar_url = COALESCE(NULLIF(?,""), avatar_url), updated_at = ? WHERE id = ?')
      .bind(body.nickname || '', body.avatar_url || '', nowISO(), user.id).run()
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()
    return json({ id: u.id, nickname: u.nickname, avatar_url: u.avatar_url, gender: Number(u.gender || 0) })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 2. 情侣绑定 ----------
function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

router.add('POST', '/api/couple/generate', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    let couple = await getUserCouple(user.id, env)
    const now = nowISO()
    if (!couple) {
      const id = uuid()
      const code = genInviteCode()
      await env.DB.prepare(
        'INSERT INTO couples (id,user_a_id,user_b_id,bind_date,status,invite_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(id, user.id, null, null, 'pending', code, now, now).run()
      couple = await env.DB.prepare('SELECT * FROM couples WHERE id = ?').bind(id).first()
    } else if (!couple.invite_code) {
      const code = genInviteCode()
      await env.DB.prepare('UPDATE couples SET invite_code = ?, updated_at = ? WHERE id = ?')
        .bind(code, now, couple.id).run()
      couple.invite_code = code
    }
    return json({
      couple_id: couple.id,
      invite_code: couple.invite_code,
      status: couple.status,
      bind_date: couple.bind_date,
      ta_bound: !!couple.user_b_id
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

router.add('POST', '/api/couple/bind', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { invite_code } = await ctx.request.json()
    if (!invite_code) return json({}, 400, '邀请码不能为空', 400)
    const code = String(invite_code).toUpperCase().trim()
    const couple = await env.DB.prepare('SELECT * FROM couples WHERE invite_code = ? AND status != ? LIMIT 1').bind(code, 'unbound').first()
    if (!couple) return json({}, 404, '邀请码不存在或已失效，请让对方重新生成', 404)
    if (couple.user_a_id === user.id) return json({}, 400, '不能绑定自己', 400)
    if (couple.user_b_id && couple.user_b_id !== user.id) return json({}, 400, '该邀请码已被使用', 400)

    const now = nowISO()
    // 取消本人其他所有 pending 绑定（作为 A 或 B），避免两边都显示"等待确认"
    await env.DB.prepare("UPDATE couples SET status = 'unbound', updated_at = ? WHERE status = 'pending' AND (user_a_id = ? OR user_b_id = ?) AND id != ?")
      .bind(now, user.id, user.id, couple.id).run()

    // 如果还没设置 user_b_id，设置进去，状态保持 pending（等待 A 确认）
    if (!couple.user_b_id) {
      await env.DB.prepare("UPDATE couples SET user_b_id = ?, status = 'pending', updated_at = ? WHERE id = ?")
        .bind(user.id, now, couple.id).run()
      couple.user_b_id = user.id
      couple.status = 'pending'
    }

    const a = await env.DB.prepare('SELECT id,nickname,avatar_url FROM users WHERE id = ?').bind(couple.user_a_id).first()
    const b = await env.DB.prepare('SELECT id,nickname,avatar_url FROM users WHERE id = ?').bind(user.id).first()

    return json({
      ok: true,
      couple_id: couple.id,
      bind_date: couple.bind_date,
      ta_info: a || {},
      ta: a || {},
      my_info: b || {},
      bound: couple.status === 'bound',
      status: couple.status,
      pending: couple.status === 'pending' && !!couple.user_b_id
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

router.add('POST', '/api/couple/respond', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { action } = await ctx.request.json()
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({}, 404, '没有待处理的绑定', 404)
    if (couple.status !== 'pending') return json({}, 400, '当前没有待确认的绑定', 400)

    const isA = couple.user_a_id === user.id
    const isB = couple.user_b_id === user.id
    if (!isA && !isB) return json({}, 403, '无权操作', 403)

    const now = nowISO()
    if (action === 'accept' && isA) {
      // A（邀请方）确认 B 的绑定申请
      const today_ = today()
      await env.DB.prepare("UPDATE couples SET status = 'bound', bind_date = ?, updated_at = ? WHERE id = ?")
        .bind(today_, now, couple.id).run()
      return json({ ok: true, status: 'bound', bind_date: today_ })
    } else if (action === 'reject' && isA) {
      // A（邀请方）拒绝 B 的绑定申请
      await env.DB.prepare("UPDATE couples SET status = 'rejected', updated_at = ? WHERE id = ?")
        .bind(now, couple.id).run()
      return json({ ok: true, status: 'rejected' })
    } else if (action === 'cancel' && isB) {
      // B（被邀请方）取消自己的绑定申请
      await env.DB.prepare("UPDATE couples SET status = 'unbound', user_b_id = NULL, updated_at = ? WHERE id = ?")
        .bind(now, couple.id).run()
      return json({ ok: true, status: 'unbound' })
    } else if (action === 'cancel' && isA) {
      // A 撤销自己发出的邀请
      await env.DB.prepare("UPDATE couples SET status = 'unbound', updated_at = ? WHERE status = 'pending' AND user_a_id = ?")
        .bind(now, user.id).run()
      return json({ ok: true, status: 'unbound' })
    } else {
      return json({}, 400, '操作无效', 400)
    }
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

router.add('GET', '/api/couple/status', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({ bound: false })
    const isA = couple.user_a_id === user.id
    const taId = isA ? couple.user_b_id : couple.user_a_id
    let ta = null
    if (taId) {
      const t = await env.DB.prepare('SELECT id,nickname,avatar_url FROM users WHERE id = ?').bind(taId).first()
      ta = t || null
    }
    return json({
      bound: couple.status === 'bound',
      status: couple.status,
      bind_date: couple.bind_date,
      couple_id: couple.id,
      invite_code: couple.invite_code,
      ta,
      is_a: isA,
      pending: couple.status === 'pending' && !!couple.user_b_id,
      rejected: couple.status === 'rejected'
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

router.add('POST', '/api/couple/unbind', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({}, 404, '未绑定', 404)
    const coolUntil = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    await env.DB.prepare("UPDATE couples SET status = 'cooling', unbind_requester = ?, cooling_until = ?, updated_at = ? WHERE id = ?")
      .bind(user.id, coolUntil, nowISO(), couple.id).run()
    return json({ ok: true, cooling_until: coolUntil })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 3. 心情记录 ----------
router.add('POST', '/api/mood/submit', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const body = await ctx.request.json()
    const { weather, note, record_date, temperature, visibility, ta_rating } = body
    if (!weather) return json({}, 400, 'weather 必选', 400)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({}, 400, '还没绑定情侣：先去「我的 → 邀请码绑定」生成或输入TA的邀请码', 400)
    if (couple.status !== 'bound') return json({}, 400, '邀请码尚未确认：让TA也打开小程序 → 邀请码绑定，确认后就能发啦 💕', 400)
    const rd = record_date || today()
    const id = uuid()
    const now = nowISO()

    // 检测 mood_records 是否有 temperature / visibility / ta_rating 列（没有就跳过，保证旧库不炸）
    let hasTemp = false
    let hasVis = false
    let hasRating = false
    try {
      const cols = await env.DB.prepare('PRAGMA table_info(mood_records)').all()
      const names = new Set((cols.results || cols || []).map(c => (c && c.name) ? String(c.name).toLowerCase() : ''))
      hasTemp = names.has('temperature')
      hasVis = names.has('visibility')
      hasRating = names.has('ta_rating')
    } catch (_) { hasTemp = false; hasVis = false; hasRating = false }
    // Try to add the column if it doesn't exist
    if (!hasRating) {
      try { await env.DB.prepare('ALTER TABLE mood_records ADD COLUMN ta_rating INTEGER').run(); hasRating = true } catch (_) {}
    }

    const cols = ['id','user_id','couple_id','weather','note','record_date','created_at','updated_at']
    const vals = [id, user.id, couple.id, weather, note || '', rd, now, now]
    if (hasTemp) { cols.push('temperature'); vals.push(temperature == null ? null : Number(temperature) || null) }
    if (hasVis)  { cols.push('visibility');  vals.push(visibility == null ? null : Number(visibility) || null) }
    if (hasRating) { cols.push('ta_rating'); vals.push(ta_rating == null ? null : Math.min(5, Math.max(1, Number(ta_rating) || null))) }
    const placeholders = cols.map(() => '?').join(',')
    const updateSet = ['weather = excluded.weather', 'note = excluded.note', 'updated_at = excluded.updated_at']
    if (hasTemp) updateSet.push('temperature = excluded.temperature')
    if (hasVis)  updateSet.push('visibility = excluded.visibility')
    if (hasRating) updateSet.push('ta_rating = excluded.ta_rating')

    await env.DB.prepare(`
      INSERT INTO mood_records (${cols.join(',')})
      VALUES (${placeholders})
      ON CONFLICT(user_id, record_date) DO UPDATE SET
        ${updateSet.join(', ')}
    `).bind(...vals).run()

    // 计算共同天气并写入 shared_weather 缓存
    const rows = rowsOf(await env.DB.prepare(
      'SELECT user_id, weather FROM mood_records WHERE couple_id = ? AND record_date = ?'
    ).bind(couple.id, rd).all())

    const my = rows.find(r => r.user_id === user.id)?.weather
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const ta = rows.find(r => r.user_id === taId)?.weather
    let sharedName = null
    if (my && ta) sharedName = getMergeMood(my, ta)
    if (sharedName) {
      await env.DB.prepare(`
        INSERT INTO shared_weather (id,couple_id,weather_name,record_date,created_at)
        VALUES (?,?,?,?,?)
        ON CONFLICT(couple_id, record_date) DO UPDATE SET weather_name = excluded.weather_name
      `).bind(uuid(), couple.id, sharedName, rd, now).run()
    }
    // 检测预警
    await scheduleAlertCheck(couple.id, env)

    return json({ ok: true, shared_weather: sharedName, my_weather: my, ta_weather: ta || null })
  } catch (e) {
    console.error(e)
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

router.add('GET', '/api/mood/today', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const today_ = today()
    const result = {
      my: null, ta: null, shared: null, quote: null
    }
    if (couple && couple.status === 'bound') {
      const rows = rowsOf(await env.DB.prepare(
        'SELECT user_id, weather, note, ta_rating FROM mood_records WHERE couple_id = ? AND record_date = ?'
      ).bind(couple.id, today_).all())
      const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
      const myR = rows.find(r => r.user_id === user.id)
      const taR = rows.find(r => r.user_id === taId)
      if (myR) result.my = { weather: myR.weather, note: myR.note, ta_rating: myR.ta_rating }
      if (taR) result.ta = { weather: taR.weather, note: taR.note, ta_rating: taR.ta_rating }
      if (myR && taR) {
        const name = getMergeMood(myR.weather, taR.weather)
        result.shared = name
      }
    }
    const quotes = [
      '你的一句晚安，治愈了我一整天的疲惫。',
      '和你在一起的每一天，都值得收藏。',
      '你笑起来，我的世界就亮了。',
      '愿我们的心情，永远同频共振。',
      '风很温柔，花很浪漫，你很特别。',
      '把所有的温柔，都设置成仅你可见。',
      '你是我漫漫余生里，斩钉截铁的梦想。',
      '星河滚烫，你是人间理想。'
    ]
    result.quote = quotes[Math.floor(Math.random() * quotes.length)]
    return json(result)
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ============================================================
// 生理周期记录（经期 / 排卵期）+ AI 分析
// ============================================================
async function ensurePeriodTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS period_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_period_user ON period_records(user_id, start_date)`).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS user_period_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      cycle_length INTEGER NOT NULL DEFAULT 28,
      period_length INTEGER NOT NULL DEFAULT 5,
      reminder_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `).run()
  try { await env.DB.prepare(`ALTER TABLE users ADD COLUMN gender INTEGER NOT NULL DEFAULT 0`).run() } catch (_) {}
}

function daysDiff(a, b) {
  const da = new Date(a + 'T00:00:00')
  const db = new Date(b + 'T00:00:00')
  return Math.round((db - da) / (1000 * 60 * 60 * 24))
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

async function getPeriodSettings(userId, env) {
  let s = await env.DB.prepare('SELECT * FROM user_period_settings WHERE user_id = ?').bind(userId).first()
  if (!s) {
    await env.DB.prepare('INSERT INTO user_period_settings (user_id, cycle_length, period_length, reminder_enabled, updated_at) VALUES (?,?,?,?,?)')
      .bind(userId, 28, 5, 1, nowISO()).run()
    s = { cycle_length: 28, period_length: 5, reminder_enabled: 1 }
  }
  return s
}

async function computePeriodStatus(userId, env, asOf = today()) {
  await ensurePeriodTables(env)
  const settings = await getPeriodSettings(userId, env)
  const records = rowsOf(await env.DB.prepare('SELECT * FROM period_records WHERE user_id = ? ORDER BY start_date DESC LIMIT 12').bind(userId).all())
  if (!records.length) return { hasData: false, settings, phase: null, asOf }

  const latest = records[0]
  const cycle = Number(settings.cycle_length) || 28
  const periodLen = Number(settings.period_length) || 5
  const start = latest.start_date
  const end = latest.end_date

  // 阶段定义
  // 月经期: 经期开始 ~ 经期结束（periodLen 天）
  // 卵泡期: 月经结束之后 ~ 排卵日前
  // 排卵期: 排卵日前5天 ~ 排卵日后4天（共10天易孕窗口）
  // 黄体期: 排卵期结束 ~ 下次月经前
  const periodStart = start
  const periodEndActual = end || addDays(start, periodLen - 1)
  const periodEndDate = addDays(start, periodLen) // 月经结束后第一天
  const nextPeriodStart = addDays(start, cycle)
  const ovulationDay = addDays(nextPeriodStart, -14)
  const fertileStart = addDays(ovulationDay, -5)
  const fertileEnd = addDays(ovulationDay, +4)
  const lutealStart = addDays(fertileEnd, +1)
  const lutealEnd = addDays(nextPeriodStart, -1)

  // 当前所处阶段
  const todayIdx = daysDiff(start, asOf) // 距离本次月经开始的天数
  let phase = 'unknown'
  let phaseInfo = null
  let dayOfPhase = 0
  let daysUntilNext = 0

  if (todayIdx < 0) {
    phase = 'before'
  } else if (todayIdx >= 0 && todayIdx < periodLen && (!end || daysDiff(asOf, end) >= 0 || !end)) {
    phase = 'period'
    dayOfPhase = todayIdx + 1
    if (!end) {
      // 仍在经期中
    } else if (daysDiff(asOf, end) >= 0) {
      dayOfPhase = daysDiff(start, asOf) + 1
    }
  } else {
    // 月经已结束，根据排卵日判断
    const diffToOvulation = daysDiff(asOf, ovulationDay)
    if (diffToOvulation >= -5 && diffToOvulation <= 4) {
      phase = 'ovulation'
      dayOfPhase = diffToOvulation + 6
    } else if (diffToOvulation < -5) {
      phase = 'follicular'
      dayOfPhase = daysDiff(periodEndDate, asOf) + 1
    } else {
      phase = 'luteal'
      dayOfPhase = daysDiff(lutealStart, asOf) + 1
    }
  }

  daysUntilNext = daysDiff(asOf, nextPeriodStart)

  // 阶段详细描述
  const PHASE_DETAILS = {
    period: {
      label: '月经期',
      emoji: '🩸',
      color: '#FF6B9D',
      bgColor: '#FFD6E4',
      desc: '子宫内膜脱落，会出血。容易疲惫、小腹坠胀、腰酸、情绪烦躁。',
      tips: ['多喝温水，避免生冷食物', '注意休息，避免剧烈运动', '保持心情舒畅，可以热敷小腹', '补充铁质和维生素'],
      partnerTips: ['多包涵 TA 的情绪波动', '主动承担家务和跑腿', '准备红糖姜茶或暖宝宝', '给一个温暖的拥抱'],
      duration: periodLen
    },
    follicular: {
      label: '卵泡期',
      emoji: '🌸',
      color: '#A8E6CF',
      bgColor: '#DCEDC8',
      desc: '月经结束后到排卵前。身体雌激素慢慢升高，气色、精力普遍比较好。',
      tips: ['精力旺盛，适合运动和社交', '皮肤状态好，可以多做护肤', '新陈代谢加快，注意营养均衡', '适合做有挑战性的事情'],
      partnerTips: ['约 TA 出去玩，一起运动', 'TA 现在精力好，可以多交流', '适合一起做重要决定', '安排一次约会吧'],
      duration: daysDiff(periodEndDate, fertileStart)
    },
    ovulation: {
      label: '排卵期',
      emoji: '🥚',
      color: '#B8A9FF',
      bgColor: '#E8E0FF',
      desc: '下次月经往前推 14 天左右。白带变多、拉丝，少数人会一侧小腹轻微刺痛，这时候容易怀孕。',
      tips: ['注意个人卫生', '如需避孕请做好措施', '可能有轻微腹痛属正常现象', '保持规律作息'],
      partnerTips: ['体贴 TA 的身体变化', '这是受孕高峰期，注意避孕或备孕', '可以准备一些小惊喜', '多关心 TA 的感受'],
      duration: 10
    },
    luteal: {
      label: '黄体期',
      emoji: '🌙',
      color: '#FFB347',
      bgColor: '#FFE5B4',
      desc: '排卵结束到下次月经之前。很多人会出现经前期综合征（PMS）：胸胀、长痘、水肿、容易生气焦虑、小腹隐隐不舒服，等月经来了就缓解。',
      tips: ['少盐少糖，缓解水肿', '补充维生素 B6 和镁', '适度运动，缓解情绪', '保证充足睡眠'],
      partnerTips: ['TA 可能情绪敏感，多包容', '准备一些 TA 喜欢的小零食', '避免争吵，多倾听', '帮 TA 分担压力'],
      duration: daysDiff(lutealStart, nextPeriodStart)
    }
  }

  phaseInfo = PHASE_DETAILS[phase] || null

  return {
    hasData: true,
    settings,
    latest,
    records,
    cycle,
    periodLen,
    phase,
    phaseInfo,
    dayOfPhase,
    daysUntilNext,
    periodStart,
    periodEndActual: end,
    periodEndDate,
    nextPeriodStart,
    ovulationDay,
    fertileStart,
    fertileEnd,
    lutealStart,
    lutealEnd,
    inPeriod: phase === 'period',
    inFertile: phase === 'ovulation',
    asOf
  }
}

// 设置性别
router.add('POST', '/api/user/gender', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { gender } = await ctx.request.json()
    const g = Number(gender)
    if (![0,1,2].includes(g)) return json({}, 400, 'gender 只能是 0/1/2', 400)
    await ensurePeriodTables(env)
    await env.DB.prepare('UPDATE users SET gender = ? WHERE id = ?').bind(g, user.id).run()
    return json({ gender: g })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 获取经期状态
router.add('GET', '/api/period/status', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const status = await computePeriodStatus(user.id, env)
    return json(status)
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 获取伴侣经期状态（仅绑定情侣可见）
router.add('GET', '/api/period/partner', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') {
      return json({ debug: { uid: user.id, coupleId: couple && couple.id, status: couple && couple.status } }, 400, '未绑定情侣', 400)
    }
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const ta = await env.DB.prepare('SELECT id, nickname, avatar_url, gender FROM users WHERE id = ?').bind(taId).first()
    if (!ta) return json({}, 404, '未找到伴侣', 404)
    if (Number(ta.gender) !== 2) {
      return json({ partner: { id: ta.id, nickname: ta.nickname, avatar_url: ta.avatar_url, gender: ta.gender }, hasData: false, tip: 'TA 还不是女生身份，暂无周期数据' })
    }
    const status = await computePeriodStatus(taId, env)
    // 给伴侣的关怀建议
    const partnerCare = status.phaseInfo ? {
      phaseLabel: status.phaseInfo.label,
      phaseEmoji: status.phaseInfo.emoji,
      tips: status.phaseInfo.partnerTips || [],
      daysUntilNext: status.daysUntilNext,
      dayOfPhase: status.dayOfPhase
    } : null
    return json({
      partner: { id: ta.id, nickname: ta.nickname, avatar_url: ta.avatar_url, gender: ta.gender },
      ...status,
      partnerCare
    })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 伴侣发送关怀动作（贴贴/抱抱/倒水/做饭等）
const CARE_ACTIONS = [
  { key: 'hug', emoji: '🤗', label: '给个抱抱', msg: '给你一个大大的拥抱，今天辛苦啦' },
  { key: 'water', emoji: '💧', label: '倒杯热水', msg: '热水已备好，记得多喝温水哦' },
  { key: 'cook', emoji: '🍲', label: '做顿饭', msg: '今天我下厨，给你做顿好吃的' },
  { key: 'sweets', emoji: '🍫', label: '送小零食', msg: '准备了你爱吃的零食，甜一下心情' },
  { key: 'heat', emoji: '🔥', label: '准备暖宝宝', msg: '暖宝宝已就位，记得敷小腹' },
  { key: 'massage', emoji: '💆', label: '帮你揉揉腰', msg: '过来，帮你揉揉腰放松一下' }
]

router.add('GET', '/api/period/care-actions', async (env, ctx) => {
  return json({ list: CARE_ACTIONS })
})

router.add('POST', '/api/period/care', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const { action_key } = await ctx.request.json()
    const action = CARE_ACTIONS.find(a => a.key === action_key)
    if (!action) return json({}, 400, '未知的关怀动作', 400)
    await ensurePeriodTables(env)
    const id = uuid()
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS period_cares (
        id TEXT PRIMARY KEY,
        couple_id TEXT NOT NULL,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        action_emoji TEXT NOT NULL,
        action_label TEXT NOT NULL,
        action_msg TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run()
    await env.DB.prepare('INSERT INTO period_cares (id,couple_id,from_user_id,to_user_id,action_key,action_emoji,action_label,action_msg,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, couple.id, user.id, couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id, action.key, action.emoji, action.label, action.msg, nowISO()).run()
    return json({ ok: true, action })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 获取收到的关怀
router.add('GET', '/api/period/cares', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({ list: [] })
    await ensurePeriodTables(env)
    try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS period_cares (id TEXT PRIMARY KEY, couple_id TEXT NOT NULL, from_user_id TEXT NOT NULL, to_user_id TEXT NOT NULL, action_key TEXT NOT NULL, action_emoji TEXT NOT NULL, action_label TEXT NOT NULL, action_msg TEXT NOT NULL, created_at TEXT NOT NULL)').run() } catch (_) {}
    const rows = rowsOf(await env.DB.prepare('SELECT * FROM period_cares WHERE couple_id = ? AND (from_user_id = ? OR to_user_id = ?) ORDER BY created_at DESC LIMIT 20').bind(couple.id, user.id, user.id).all())
    rows.forEach(r => { r.direction = r.from_user_id === user.id ? 'sent' : 'received' })
    return json({ list: rows })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 记录经期（开始/结束）
router.add('POST', '/api/period/record', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const body = await ctx.request.json()
    const { id, start_date, end_date, note } = body
    if (!start_date || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return json({}, 400, 'start_date 格式错误', 400)
    await ensurePeriodTables(env)
    const now = nowISO()
    if (id) {
      // 修改
      await env.DB.prepare('UPDATE period_records SET start_date = ?, end_date = ?, note = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .bind(start_date, end_date || null, note || '', now, id, user.id).run()
    } else {
      // 新增：如果有未结束的经期，先结束它
      const open = await env.DB.prepare("SELECT * FROM period_records WHERE user_id = ? AND end_date IS NULL AND start_date <= ?").bind(user.id, today()).first()
      if (open && end_date) {
        await env.DB.prepare('UPDATE period_records SET end_date = ?, updated_at = ? WHERE id = ?')
          .bind(end_date, now, open.id).run()
      } else {
        await env.DB.prepare('INSERT INTO period_records (id,user_id,start_date,end_date,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .bind(uuid(), user.id, start_date, end_date || null, note || '', now, now).run()
      }
    }
    return json({ ok: true })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 获取经期历史
router.add('GET', '/api/period/records', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    await ensurePeriodTables(env)
    const rows = rowsOf(await env.DB.prepare('SELECT * FROM period_records WHERE user_id = ? ORDER BY start_date DESC LIMIT 50').bind(user.id).all())
    return json({ list: rows })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 更新经期设置
router.add('POST', '/api/period/settings', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const body = await ctx.request.json()
    const cycle = Math.max(21, Math.min(45, Number(body.cycle_length) || 28))
    const period = Math.max(2, Math.min(10, Number(body.period_length) || 5))
    const reminder = body.reminder_enabled === false ? 0 : 1
    await ensurePeriodTables(env)
    await env.DB.prepare(`
      INSERT INTO user_period_settings (user_id, cycle_length, period_length, reminder_enabled, updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        cycle_length=excluded.cycle_length, period_length=excluded.period_length,
        reminder_enabled=excluded.reminder_enabled, updated_at=excluded.updated_at
    `).bind(user.id, cycle, period, reminder, nowISO()).run()
    return json({ cycle_length: cycle, period_length: period, reminder_enabled: reminder })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// AI 分析身体状况
router.add('GET', '/api/period/analyze', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const status = await computePeriodStatus(user.id, env)
    const records = status.records || []
    const recent = records.slice(0, 6).map(r => `${r.start_date}${r.end_date ? '~' + r.end_date : ''}`).join('；')
    const phaseLabel = status.phaseInfo ? status.phaseInfo.label : (status.phase || '未知')
    const prompt = `请根据以下近期经期记录，给这位女生一段温柔、贴心的身体状况分析和护理建议（控制在200字以内，分点列出，避免医学诊断语气）：
当前状态：${phaseLabel}${status.dayOfPhase ? '，第' + status.dayOfPhase + '天' : ''}${status.ovulationDay ? '，预测排卵日：' + status.ovulationDay : ''}${status.daysUntilNext != null ? '，距下次月经约' + status.daysUntilNext + '天' : ''}
近期记录：${recent || '暂无'}
请用中文，语气像男朋友/闺蜜一样温暖。`
    const res = await callQianwenAPI(env, prompt, {
      system: '你是一位温柔体贴的健康生活助手，擅长用温暖、非医学诊断的语气给女生提供经期和排卵期的护理建议。',
      maxTokens: 400,
      temperature: 0.8
    })
    return json({ text: res.ok ? res.text : res.text, ok: res.ok })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// ============================================================
// AI 能力（通义千问）—— 心情日报 + 情感洞察
// ============================================================

// 阿里云百炼默认可用模型候选列表（按优先级，覆盖千问商业版/开源版/第三方模型）
// 同一 API Key 下每个模型通常有独立的 100 万 Token 免费额度，耗尽时自动轮询下一个
const DEFAULT_AI_MODELS = [
  // 千问 Max 系列（旗舰）
  'qwen3.8-max', 'qwen3.8-max-2026-05-20', 'qwen3.8-max-2026-06-08',
  'qwen3.7-max', 'qwen3.7-max-2026-05-20', 'qwen3.7-max-2026-06-08', 'qwen3.7-max-preview', 'qwen3.7-max-2026-05-17',
  'qwen3.6-max-preview',
  'qwen3-max', 'qwen3-max-2026-01-23', 'qwen3-max-preview',
  'qwen-max', 'qwen-max-longcontext', 'qwen-max-latest',
  // 千问 Plus 系列（均衡）
  'qwen3.7-plus', 'qwen3.7-plus-2026-05-26',
  'qwen3.6-plus', 'qwen3.6-plus-2026-04-02',
  'qwen3.5-plus', 'qwen3.5-plus-2026-04-20', 'qwen3.5-plus-2026-02-15',
  'qwen-plus', 'qwen-plus-latest', 'qwen-plus-2025-09-11',
  // 千问 Flash 系列（轻量快速）
  'qwen3.7-flash', 'qwen3.7-flash-2026-07-15',
  'qwen3.6-flash', 'qwen3.6-flash-2026-04-16',
  'qwen3.5-flash', 'qwen3.5-flash-2026-02-23',
  'qwen-flash', 'qwen-flash-2025-07-28',
  // 千问 Turbo 系列
  'qwen-turbo', 'qwen-turbo-latest',
  // 千问 Coder 系列
  'qwen3-coder-next', 'qwen3-coder-plus', 'qwen3-coder-plus-2025-09-23', 'qwen3-coder-flash',
  'qwen-coder-plus', 'qwen-coder-plus-latest', 'qwen-coder-turbo', 'qwen-coder-turbo-latest', 'qwen-coder-turbo-2024-09-19',
  // 千问 Math 系列
  'qwen3-math-plus', 'qwen3-math-flash',
  'qwen-math-plus', 'qwen-math-turbo',
  // 千问 2.5 开源系列
  'qwen2.5-72b-instruct', 'qwen2.5-32b-instruct', 'qwen2.5-14b-instruct', 'qwen2.5-7b-instruct', 'qwen2.5-3b-instruct', 'qwen2.5-0.5b-instruct',
  'qwen2.5-coder-32b-instruct', 'qwen2.5-coder-14b-instruct', 'qwen2.5-coder-7b-instruct', 'qwen2.5-coder-3b-instruct', 'qwen2.5-coder-1.5b-instruct',
  'qwen2.5-math-72b-instruct', 'qwen2.5-math-7b-instruct', 'qwen2.5-math-1.5b-instruct',
  // 千问 2 开源系列
  'qwen2-72b-instruct', 'qwen2-57b-a14b-instruct', 'qwen2-7b-instruct', 'qwen2-1.5b-instruct', 'qwen2-0.5b-instruct',
  'qwen2-math-72b-instruct', 'qwen2-math-7b-instruct', 'qwen2-math-1.5b-instruct',
  // 千问 1.5 / 1.0 系列
  'qwen1.5-110b-chat', 'qwen1.5-72b-chat', 'qwen1.5-32b-chat', 'qwen1.5-14b-chat', 'qwen1.5-7b-chat', 'qwen1.5-1.8b-chat',
  'qwen-72b-chat', 'qwen-14b-chat', 'qwen-7b-chat', 'qwen-1.8b-chat',
  // 第三方文本模型（如百炼开通了对应免费额度也可使用）
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-0731', 'deepseek-v3.2', 'deepseek-v3', 'deepseek-r1',
  'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking',
  'glm-5.2', 'glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6',
  'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1'
]

function isQuotaError(status, errText) {
  if (status === 429) return true
  if (status === 403) {
    const t = String(errText).toLowerCase()
    return t.includes('allocationquota') || t.includes('freetieronly') || t.includes('insufficientquota') || t.includes('quota')
  }
  const t = String(errText).toLowerCase()
  return t.includes('allocationquota.freetieronly') || t.includes('insufficient_quota')
}

// 调用通义千问 OpenAI 兼容接口（多模型自动轮询切换）
async function callQianwenAPI(env, prompt, opts = {}) {
  const apiKey = env.AI_API_KEY
  if (!apiKey) {
    return { ok: false, text: 'AI 功能尚未配置，请联系管理员设置 API Key。' }
  }
  const models = (env.AI_MODELS ? String(env.AI_MODELS).split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_AI_MODELS)
  if (opts.model) {
    models.unshift(opts.model)
  }
  if (models.length === 0) models.push('qwen-turbo')

  const url = 'https://ws-t1kz7z6f37d4gaam.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions'
  const tried = []

  for (const model of models) {
    tried.push(model)
    try {
      const controller = new AbortController()
      const perModelTimeout = opts.timeout || 12000
      const timeout = setTimeout(() => controller.abort(), perModelTimeout)
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: opts.system || '你是一位温暖、幽默、懂浪漫的情感博主，专门为情侣写温柔治愈的短文。语言要自然、有画面感，避免说教。' },
            { role: 'user', content: prompt }
          ],
          temperature: opts.temperature ?? 0.85,
          max_tokens: opts.maxTokens || 400
        }),
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '')
        console.error('qianwen api err', model, resp.status, errText.slice(0, 200))
        if (isQuotaError(resp.status, errText)) {
          continue
        }
        return { ok: false, text: 'AI 稍微走神了，稍后再试一下吧～', modelsTried: tried }
      }
      const data = await resp.json()
      const text = data?.choices?.[0]?.message?.content || ''
      return { ok: !!text, text: text || '今天 AI 暂时没有灵感，稍后再来看看吧～', modelsTried: tried }
    } catch (e) {
      console.error('callQianwenAPI err', model, e && e.message)
      if (e && e.name === 'AbortError') continue
      continue
    }
  }

  console.error('qianwen all models failed', tried.join(', '))
  return { ok: false, text: 'AI 暂时不可用，所有模型额度都用光啦，请稍后再试或联系管理员～', modelsTried: tried }
}

// 安全截断（避免 prompt 过长）
const clip = (s, n = 80) => {
  if (!s) return ''
  s = String(s)
  return s.length > n ? s.slice(0, n) + '…' : s
}

// 生成今日 AI 心情日报
router.add('GET', '/api/ai/mood-report', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') {
      return json({ report: '', tip: '绑定情侣后，AI 会为你们生成专属心情日报 ✨' })
    }
    const today_ = today()
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const rows = rowsOf(await env.DB.prepare(
      'SELECT user_id, weather, note FROM mood_records WHERE couple_id = ? AND record_date = ?'
    ).bind(couple.id, today_).all())
    const myR = rows.find(r => r.user_id === user.id)
    const taR = rows.find(r => r.user_id === taId)

    // 双方都还没记录
    if (!myR && !taR) {
      return json({ report: '', tip: '今天还没记录心情哦，记一笔让 AI 为你们写日报吧 🌤️' }
      )
    }
    // 只有一方记录
    if (!myR || !taR) {
      const who = myR ? '你' : 'TA'
      const r = myR || taR
      const prompt = `今天${who}的心情是「${r.weather || '未填写'}」，备注：${clip(r.note, 60)}。请用第一人称视角写一句30-50字的温柔小播报，像是给对方的一句悄悄话，可以提一个小建议。不要使用「亲」「宝贝」等过度称呼，语气自然温暖。`
      const res = await callQianwenAPI(env, prompt, { maxTokens: 200 })
      return json({ report: res.text, partial: true })
    }
    // 双方都记录了
    const shared = getMergeMood(myR.weather, taR.weather)
    const prompt = `今天是你们在一起的一天。
你的心情：「${myR.weather || '未填写'}」${myR.note ? '，备注：' + clip(myR.note, 60) : ''}
TA的心情：「${taR.weather || '未填写'}」${taR.note ? '，备注：' + clip(taR.note, 60) : ''}
你们的合体心情名：「${shared}」

请写一段 60-80 字的「情侣心情日报」，要求：
1. 像一位懂你们的朋友在播报，语气温暖幽默
2. 结合两人的心情给出一个小互动建议（如一起做的小事）
3. 结尾留一句甜甜的话
不要分点，直接成段。不要用 emoji。`
    const res = await callQianwenAPI(env, prompt, { maxTokens: 300 })
    return json({ report: res.text, shared })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 生成 AI 情感洞察（最近 7 天趋势分析）
router.add('GET', '/api/ai/insight', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') {
      return json({ insight: '', tip: '绑定情侣后，AI 会为你们分析情感趋势 💫' })
    }
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id

    // 取最近 7 天双方的心情记录
    const end = today()
    const startD = new Date()
    startD.setDate(startD.getDate() - 6)
    const start = `${startD.getFullYear()}-${String(startD.getMonth()+1).padStart(2,'0')}-${String(startD.getDate()).padStart(2,'0')}`
    const rows = rowsOf(await env.DB.prepare(
      'SELECT user_id, weather, note, record_date FROM mood_records WHERE couple_id = ? AND record_date BETWEEN ? AND ? ORDER BY record_date ASC'
    ).bind(couple.id, start, end).all())

    const myDays = rows.filter(r => r.user_id === user.id)
    const taDays = rows.filter(r => r.user_id === taId)

    if (myDays.length === 0 && taDays.length === 0) {
      return json({ insight: '', tip: '最近 7 天还没有心情记录，记几笔让 AI 帮你们看看趋势吧 📒' })
    }

    // 计算心情同步率
    const dateSet = new Set([...myDays.map(r => r.record_date), ...taDays.map(r => r.record_date)])
    let bothDays = 0, syncDays = 0
    for (const d of dateSet) {
      const m = myDays.find(r => r.record_date === d)
      const t = taDays.find(r => r.record_date === d)
      if (m && t) {
        bothDays++
        const mc = getEmotionCategory(m.weather)
        const tc = getEmotionCategory(t.weather)
        if (mc === tc) syncDays++
      }
    }
    const syncRate = bothDays > 0 ? Math.round((syncDays / bothDays) * 100) : null

    // 统计消极情绪天数
    const myBad = myDays.filter(r => BAD_EMOTIONS.has(r.weather)).length
    const taBad = taDays.filter(r => BAD_EMOTIONS.has(r.weather)).length

    // 构造简洁的周报数据给 AI
    const mySummary = myDays.length > 0
      ? myDays.map(r => `${r.record_date.slice(5)}:${r.weather || '无'}`).join('，')
      : '本周暂无记录'
    const taSummary = taDays.length > 0
      ? taDays.map(r => `${r.record_date.slice(5)}:${r.weather || '无'}`).join('，')
      : '本周暂无记录'

    const syncText = syncRate !== null ? `心情同步率约 ${syncRate}%` : '双方记录天数较少，暂无法计算同步率'
    const prompt = `请根据以下情侣最近7天的心情数据，写一段 80-120 字的「情感洞察」：
我的心情序列：${mySummary}
TA的心情序列：${taSummary}
${syncText}；我消极情绪天数 ${myBad} 天，TA消极情绪天数 ${taBad} 天。

要求：
1. 像一位贴心的情感分析师朋友，温柔地解读你们这周的状态
2. 如果一方连续疲惫/消极，提醒另一方多关心
3. 给一个本周小建议（具体可做的小事，如「一起看部老电影」「点一份对方爱的外卖」）
4. 结尾一句鼓励的话
不要分点，直接成段。不要用 emoji。语气自然，避免说教。`
    const res = await callQianwenAPI(env, prompt, { maxTokens: 400 })
    return json({
      insight: res.text,
      stats: {
        sync_rate: syncRate,
        my_records: myDays.length,
        ta_records: taDays.length,
        my_bad_days: myBad,
        ta_bad_days: taBad,
        both_days: bothDays
      }
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 4. 共同天气 (主页 hero) ----------
router.add('GET', '/api/weather/today', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const today_ = today()
    let shared = null, my = null, ta = null, alert = null
    if (couple && couple.status === 'bound') {
      const rows = rowsOf(await env.DB.prepare(
        'SELECT user_id, weather, note, ta_rating FROM mood_records WHERE couple_id = ? AND record_date = ?'
      ).bind(couple.id, today_).all())
      const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
      const myR = rows.find(r => r.user_id === user.id)
      const taR = rows.find(r => r.user_id === taId)
      my = myR ? { weather: myR.weather, note: myR.note, ta_rating: myR.ta_rating, recorded_at: today_ } : null
      ta = taR ? { weather: taR.weather, note: taR.note, ta_rating: taR.ta_rating, recorded_at: today_ } : null
      if (myR && taR) shared = getMergeMood(myR.weather, taR.weather)

      const act = await env.DB.prepare(
        "SELECT * FROM alerts WHERE couple_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).bind(couple.id).first()
      if (act) alert = { level: act.level, days: act.days, days_left: act.days, title: act.title, note: act.note }
    }
    const quotes = [
      '你的一句晚安，治愈了我一整天的疲惫。',
      '和你在一起的每一天，都值得收藏。',
      '你笑起来，我的世界就亮了。',
      '愿我们的心情，永远同频共振。',
      '风很温柔，花很浪漫，你很特别。',
      '把所有的温柔，都设置成仅你可见。',
      '你是我漫漫余生里，斩钉截铁的梦想。',
      '星河滚烫，你是人间理想。'
    ]
    const shared_quote = quotes[Math.floor(Math.random() * quotes.length)]
    return json({
      shared_name: shared,
      shared_weather: shared,
      shared,
      shared_quote,
      my_mood: my,
      ta_mood: ta,
      my_weather: my,
      ta_weather: ta,
      my, ta,
      today: today_,
      couple_bound: !!(couple && couple.status === 'bound'),
      alert
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 近N天有记录的天气（首页用）
router.add('GET', '/api/weather/week', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const bound = !!(couple && couple.status === 'bound')
    const taId = bound ? (couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id) : null
    const limit = 7

    // 只查询用户本人最近有记录的日期（从自己的记录开始）
    const myRows = rowsOf(await env.DB.prepare(
      'SELECT DISTINCT record_date FROM mood_records WHERE user_id = ? ORDER BY record_date DESC LIMIT ?'
    ).bind(user.id, limit).all())

    const dates = myRows.map(r => r.record_date).sort().slice(-limit)

    const list = []
    for (const ds of dates) {
      // 找到该记录所属的 couple_id
      const latest = await env.DB.prepare('SELECT couple_id FROM mood_records WHERE user_id = ? AND record_date = ? LIMIT 1').bind(user.id, ds).first()
      const cid = latest ? latest.couple_id : null

      let myR = null, taR = null
      if (cid) {
        myR = await env.DB.prepare('SELECT weather, note, ta_rating FROM mood_records WHERE couple_id = ? AND user_id = ? AND record_date = ?').bind(cid, user.id, ds).first()
        if (bound) taR = await env.DB.prepare('SELECT weather, note, ta_rating FROM mood_records WHERE couple_id = ? AND user_id = ? AND record_date = ?').bind(cid, taId, ds).first()
      }

      let shared = null
      if (myR && taR) shared = getMergeMood(myR.weather, taR.weather)
      else if (myR) shared = myR.weather
      else if (taR) shared = taR.weather

      list.push({
        date: ds,
        shared,
        my: myR ? { weather: myR.weather, note: myR.note, ta_rating: myR.ta_rating } : null,
        ta: taR ? { weather: taR.weather, note: taR.note, ta_rating: taR.ta_rating } : null
      })
    }

    return json({ days: list })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 5. 气候日历 ----------
router.add('GET', '/api/calendar/:year/:month', async (env, ctx, params) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const y = Number(params.year), m = Number(params.month)
    const daysInMonth = new Date(y, m, 0).getDate()
    const start = `${y}-${String(m).padStart(2,'0')}-01`
    const end = `${y}-${String(m).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`

    const days = []
    let sunny = 0, rainy = 0, rainbow = 0, streak = 0, curStreak = 0

    if (couple && couple.status === 'bound') {
      const swRows = rowsOf(await env.DB.prepare(
        'SELECT record_date, weather_name FROM shared_weather WHERE couple_id = ? AND record_date BETWEEN ? AND ?'
      ).bind(couple.id, start, end).all())
      const moodRows = rowsOf(await env.DB.prepare(
        'SELECT user_id, weather, note, ta_rating, record_date FROM mood_records WHERE couple_id = ? AND record_date BETWEEN ? AND ?'
      ).bind(couple.id, start, end).all())
      const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id

      for (let i = 1; i <= daysInMonth; i++) {
        const ds = `${y}-${String(m).padStart(2,'0')}-${String(i).padStart(2,'0')}`
        const sw = swRows.find(r => r.record_date === ds)?.weather_name || null
        const myR = moodRows.find(r => r.record_date === ds && r.user_id === user.id)
        const taR = moodRows.find(r => r.record_date === ds && r.user_id === taId)
        days.push({
          date: ds,
          day: i,
          shared: sw,
          my: myR ? { weather: myR.weather, note: myR.note, ta_rating: myR.ta_rating } : null,
          ta: taR ? { weather: taR.weather, note: taR.note, ta_rating: taR.ta_rating } : null
        })
        if (sw) {
          if (sw.includes('晴') || sw === '万里无云' || sw === '彩虹' || sw === '双彩虹') { sunny++; curStreak++; if (curStreak>streak) streak=curStreak }
          else curStreak = 0
          if (sw.includes('雨') || sw.includes('暴')) rainy++
          if (sw.includes('虹')) rainbow++
        } else curStreak = 0
      }
    } else {
      for (let i = 1; i <= daysInMonth; i++) {
        days.push({
          date: `${y}-${String(m).padStart(2,'0')}-${String(i).padStart(2,'0')}`,
          day: i, shared: null, my: null, ta: null
        })
      }
    }
    return json({ days, stats: { sunny, rainy, rainbow, streak } })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 6. 气候报告 ----------
router.add('GET', '/api/report/:year/:month', async (env, ctx, params) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const y = Number(params.year), m = Number(params.month)
    const daysInMonth = new Date(y, m, 0).getDate()
    const start = `${y}-${String(m).padStart(2,'0')}-01`
    const end = `${y}-${String(m).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`

    const dist = { '晴':0, '多云':0, '阴':0, '小雨':0, '雷暴':0, '彩虹':0 }
    let avgTemp = 0, count = 0
    const tempMap = { '晴':28,'多云':22,'阴':15,'小雨':10,'雷暴':5,'彩虹':30 }
    let streakSun = 0, curSun = 0, streakRain = 0, curRain = 0

    if (couple && couple.status === 'bound') {
      const rows = rowsOf(await env.DB.prepare(
        'SELECT record_date, weather_name FROM shared_weather WHERE couple_id = ? AND record_date BETWEEN ? AND ? ORDER BY record_date'
      ).bind(couple.id, start, end).all())
      for (const r of rows) {
        const w = r.weather_name
        if (w.includes('晴') || w === '万里无云') { dist['晴']++; curSun++; curRain = 0; avgTemp += tempMap['晴']; count++ }
        else if (w.includes('虹')) { dist['彩虹']++; curSun++; curRain = 0; avgTemp += tempMap['彩虹']; count++ }
        else if (w.includes('多云')) { dist['多云']++; curSun = 0; curRain = 0; avgTemp += tempMap['多云']; count++ }
        else if (w === '阴天' || w === '半晴' || w === '阴转多云') { dist['阴']++; curSun = 0; curRain = 0; avgTemp += tempMap['阴']; count++ }
        else if (w.includes('暴')) { dist['雷暴']++; curRain++; curSun = 0; avgTemp += tempMap['雷暴']; count++ }
        else if (w.includes('雨')) { dist['小雨']++; curRain++; curSun = 0; avgTemp += tempMap['小雨']; count++ }
        else { dist['多云']++; curSun=0; curRain=0; avgTemp += tempMap['多云']; count++ }
        if (curSun > streakSun) streakSun = curSun
        if (curRain > streakRain) streakRain = curRain
      }
    }
    if (count === 0) count = 1
    return json({
      year: y, month: m,
      avg_temp: Math.round(avgTemp / count),
      distribution: dist,
      streaks: { sun: streakSun, rain: streakRain }
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 7. 心愿天气 ----------
router.add('POST', '/api/wish/submit', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定', 400)
    const { wish_weather, reason } = await ctx.request.json()
    if (!wish_weather) return json({}, 400, '缺少 wish_weather', 400)
    const td = tomorrow()
    await env.DB.prepare(`
      INSERT INTO wishes (id,user_id,couple_id,wish_weather,reason,target_date,fulfilled,created_at)
      VALUES (?,?,?,?,?,?,0,?)
      ON CONFLICT(user_id, target_date) DO UPDATE SET
        wish_weather = excluded.wish_weather, reason = excluded.reason
    `).bind(uuid(), user.id, couple.id, wish_weather, reason || '', td, nowISO()).run()
    return json({ ok: true, target_date: td })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

router.add('GET', '/api/wish/today', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const result = { my: null, ta: null, yesterday_result: null }
    if (!couple) return json(result)
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const td = tomorrow()
    const yesterday_ = fmtDate(new Date(Date.now() - 24*3600*1000).toISOString())

    const rows = rowsOf(await env.DB.prepare(
      'SELECT * FROM wishes WHERE couple_id = ? AND target_date = ?'
    ).bind(couple.id, td).all())
    result.my = rows.find(r => r.user_id === user.id) || null
    result.ta = rows.find(r => r.user_id === taId) || null

    // 昨天心愿是否成真
    const yWishes = rowsOf(await env.DB.prepare('SELECT user_id, wish_weather, fulfilled FROM wishes WHERE couple_id = ? AND target_date = ?')
      .bind(couple.id, yesterday_).all())
    const yShared = await env.DB.prepare('SELECT weather_name FROM shared_weather WHERE couple_id = ? AND record_date = ?')
      .bind(couple.id, yesterday_).first()
    if (yWishes.length && yShared) {
      const name = yShared.weather_name
      let fulfilled = 0
      for (const w of yWishes) {
        if (name.includes(w.wish_weather) || (w.wish_weather === '晴' && (name.includes('晴') || name.includes('万里无云')))) fulfilled++
      }
      result.yesterday_result = {
        total: yWishes.length,
        fulfilled,
        date: yesterday_
      }
    }
    return json(result)
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 8. 位置 ----------
router.add('POST', '/api/location/update', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const body = await ctx.request.json()
    const lng = body.lng != null ? body.lng : (body.longitude != null ? body.longitude : null)
    const lat = body.lat != null ? body.lat : (body.latitude != null ? body.latitude : null)
    const province = body.province || ''
    const city = body.city || ''
    const district = body.district || ''
    const street = body.street || ''
    const address = body.address || body.full_address || ''
    const poi = body.poi || ''
    const visRaw = body.visible != null ? body.visible : body.visible_to_ta
    const vis = typeof visRaw === 'boolean' ? (visRaw ? 1 : 0) : (visRaw == null ? 1 : (Number(visRaw) ? 1 : 0))
    const id = uuid()

    // 兼容旧表结构：动态添加新字段（忽略已存在错误）
    const alterCols = [
      'ALTER TABLE location_snapshots ADD COLUMN province TEXT NOT NULL DEFAULT ""',
      'ALTER TABLE location_snapshots ADD COLUMN street TEXT NOT NULL DEFAULT ""',
      'ALTER TABLE location_snapshots ADD COLUMN address TEXT NOT NULL DEFAULT ""',
      'ALTER TABLE location_snapshots ADD COLUMN poi TEXT NOT NULL DEFAULT ""'
    ]
    for (const sql of alterCols) {
      try { await env.DB.prepare(sql).run() } catch (_) { /* 已存在 */ }
    }

    await env.DB.prepare(`
      INSERT INTO location_snapshots (id,user_id,lng,lat,province,city,district,street,address,poi,visible,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET
        lng=excluded.lng, lat=excluded.lat, province=excluded.province, city=excluded.city,
        district=excluded.district, street=excluded.street, address=excluded.address,
        poi=excluded.poi, visible=excluded.visible, updated_at=excluded.updated_at
    `).bind(id, user.id, lng || null, lat || null, province, city, district, street, address, poi, vis, nowISO()).run()
    return json({ ok: true, lng, lat, province, city, district, street, address, poi, visible: vis === 1 })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 通过 OpenStreetMap Nominatim 把经纬度反解成城市/地址
// 文档：https://nominatim.org/release-docs/develop/api/Reverse/
router.add('GET', '/api/location/reverse', async (env, ctx) => {
  let lat = '', lng = ''
  try {
    await requireUser(ctx.request, env)
    const url = new URL(ctx.request.url)
    lat = url.searchParams.get('lat')
    lng = url.searchParams.get('lng')
    if (lat == null || lng == null) return json({}, 400, '缺少 lat/lng', 400)

    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&zoom=18&addressdetails=1&accept-language=zh-CN`
    const res = await fetch(nominatimUrl, {
      headers: {
        'User-Agent': 'XiaoQihou MiniProgram/1.0 (support@jdhsf.top)',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    })
    if (!res.ok) {
      return json({ province: '', city: '', district: '', street: '', neighbourhood: '', poi: '', address: '', full_address: '', lat, lng })
    }
    const data = await res.json()
    const addr = data && data.address ? data.address : {}
    const province = addr.province || addr.state || ''
    const city = addr.city || addr.municipality || addr.state || addr.province || ''
    const district = addr.city_district || addr.district || addr.county || ''
    const street = [addr.road, addr.house_number].filter(Boolean).join('')
    const neighbourhood = addr.neighbourhood || addr.quarter || addr.suburb || addr.borough || addr.town || addr.village || ''
    // 优先级：具体建筑物/小区 > 商铺/设施 > 村庄/集镇
    const poi = addr.building || addr.residential || addr.amenity || addr.shop || addr.tourism || addr.office || addr.hamlet || addr.village || ''
    const address = data.display_name || [poi, street, district, city, province].filter(Boolean).join('，')
    return json({ province, city, district, street, neighbourhood, poi, address, full_address: data.display_name || address, lat, lng })
  } catch (e) {
    return json({ province: '', city: '', district: '', street: '', neighbourhood: '', poi: '', address: '', full_address: '', lat, lng })
  }
})

// 通过 Nominatim 把地址正解成经纬度（用户手动输入城市/地址）
router.add('POST', '/api/location/search', async (env, ctx) => {
  try {
    await requireUser(ctx.request, env)
    const body = await ctx.request.json()
    const q = ((body && body.address) || (body && body.q) || (body && body.keyword) || '').trim()
    if (!q) return json({}, 400, '请输入地址', 400)

    const nominatimUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&addressdetails=1&accept-language=zh-CN`
    const res = await fetch(nominatimUrl, {
      headers: {
        'User-Agent': 'XiaoQihou MiniProgram/1.0 (support@jdhsf.top)',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      }
    })
    if (!res.ok) return json({}, 500, '地址解析失败', 500)
    const arr = await res.json()
    if (!arr || !arr.length) return json({}, 404, '没找到这个地方，换个关键词试试', 404)
    const item = arr[0]
    const addr = item.address || {}
    const province = addr.province || addr.state || ''
    const city = addr.city || addr.municipality || addr.state || addr.province || ''
    const district = addr.city_district || addr.district || addr.county || ''
    const address = item.display_name || [district, city, province].filter(Boolean).join('，')
    return json({
      lat: Number(item.lat),
      lng: Number(item.lon),
      latitude: Number(item.lat),
      longitude: Number(item.lon),
      province,
      city,
      district,
      address,
      full_address: item.display_name || address
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 生成 SVG 静态地图（两个标记 + 距离线），前端 <image> 直接显示
function drawMarkerSVG(x, y, label, color, bgColor) {
  let s = `<g>`
  s += `<circle cx="${x}" cy="${y}" r="28" fill="${bgColor}" stroke="${color}" stroke-width="3"/>`
  s += `<circle cx="${x}" cy="${y}" r="10" fill="${color}"/>`
  s += `<g transform="translate(${x}, ${y + 48})">`
  s += `<rect x="-22" y="-14" width="44" height="28" rx="14" fill="#FFFFFF" stroke="${color}" stroke-width="1.2"/>`
  s += `<text x="0" y="5" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="18" font-weight="700" fill="${color}">${label}</text>`
  s += `</g></g>`
  return s
}

router.add('GET', '/api/location/map', async (env, ctx) => {
  try {
    await requireUser(ctx.request, env)
    const snap = await (async () => {
      const user = await requireUser(ctx.request, env)
      const couple = await getUserCouple(user.id, env)
      if (!couple) return { me: null, ta: null, distance_km: null }
      const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
      const me = await env.DB.prepare('SELECT * FROM location_snapshots WHERE user_id = ?').bind(user.id).first()
      let ta = null
      if (taId) {
        ta = await env.DB.prepare('SELECT * FROM location_snapshots WHERE user_id = ?').bind(taId).first()
        if (ta && ta.visible === 0) ta = { user_id: taId, hidden: true }
      }
      let distance_km = null
      try {
        if (me && ta && me.lat && me.lng && ta.lat && ta.lng) {
          const R = 6371, rad = Math.PI / 180
          const dLat = (ta.lat - me.lat) * rad
          const dLng = (ta.lng - me.lng) * rad
          const a = Math.sin(dLat/2)**2 + Math.cos(me.lat*rad) * Math.cos(ta.lat*rad) * Math.sin(dLng/2)**2
          distance_km = +(2 * R * Math.asin(Math.sqrt(a))).toFixed(2)
        }
      } catch (_) {}
      return { me, ta, distance_km }
    })()

    const W = 750, H = 480, pad = 90
    let svg = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    svg += `<defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#E8F4FB"/><stop offset="50%" stop-color="#F3F0FF"/><stop offset="100%" stop-color="#FFF5F2"/></linearGradient>`
    svg += `<radialGradient id="g1" cx="30%" cy="30%" r="60%"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.7"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`
    svg += `<radialGradient id="g2" cx="70%" cy="70%" r="60%"><stop offset="0%" stop-color="#FF8FAB" stop-opacity="0.1"/><stop offset="100%" stop-color="#FF8FAB" stop-opacity="0"/></radialGradient></defs>`
    svg += `<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#g1)"/><rect width="${W}" height="${H}" fill="url(#g2)"/>`
    svg += `<g stroke="#FFFFFF" stroke-opacity="0.5" fill="none"><line x1="-50" y1="160" x2="800" y2="140" stroke-width="7" stroke-linecap="round"/><line x1="-50" y1="320" x2="800" y2="340" stroke-width="9" stroke-linecap="round"/><line x1="250" y1="-50" x2="270" y2="530" stroke-width="6" stroke-linecap="round"/></g>`

    const me = snap.me, ta = (snap.ta && !snap.ta.hidden) ? snap.ta : null, dist = snap.distance_km
    if (me && ta) {
      const minLat = Math.min(me.lat, ta.lat), maxLat = Math.max(me.lat, ta.lat)
      const minLng = Math.min(me.lng, ta.lng), maxLng = Math.max(me.lng, ta.lng)
      const dLat = Math.max(maxLat - minLat, 0.01), dLng = Math.max(maxLng - minLng, 0.01)
      const toX = (lng) => pad + ((lng - minLng) / dLng) * (W - pad * 2)
      const toY = (lat) => (H - pad) - ((lat - minLat) / dLat) * (H - pad * 2)
      const x1 = toX(me.lng), y1 = toY(me.lat), x2 = toX(ta.lng), y2 = toY(ta.lat)
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#FF8FAB" stroke-width="2.5" stroke-dasharray="8 6" stroke-opacity="0.6"/>`
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
      const distText = (typeof dist === 'number') ? (dist.toFixed(1) + ' km') : '— —'
      svg += `<g transform="translate(${mx}, ${my - 22})"><rect x="-50" y="-16" width="100" height="32" rx="16" fill="#FFFFFF" stroke="#FF8FAB" stroke-width="1.2"/><text x="0" y="6" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="20" font-weight="700" fill="#FF6B8B">${distText}</text></g>`
      svg += drawMarkerSVG(x1, y1, '我', '#8B5CF6', '#EEE9FF')
      svg += drawMarkerSVG(x2, y2, 'TA', '#FF6B8B', '#FFE8EE')
    } else if (me) {
      svg += drawMarkerSVG(W / 2, H / 2, '我', '#8B5CF6', '#EEE9FF')
      svg += `<text x="${W/2}" y="${H - 50}" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="22" fill="#A094AC">TA 还没更新位置</text>`
    } else if (ta) {
      svg += drawMarkerSVG(W / 2, H / 2, 'TA', '#FF6B8B', '#FFE8EE')
      svg += `<text x="${W/2}" y="${H - 50}" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="22" fill="#A094AC">在下方输入你的位置</text>`
    } else {
      svg += `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="24" fill="#A094AC">还没有位置数据</text>`
      svg += `<text x="${W/2}" y="${H/2 + 36}" text-anchor="middle" font-family="PingFang SC, sans-serif" font-size="20" fill="#C0B8C8">在下方输入你的位置</text>`
    }
    svg += `</svg>`
    return new Response(svg, {
      status: 200,
      headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' }
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

router.add('GET', '/api/location/couple', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({ me: null, ta: null })
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const me = await env.DB.prepare('SELECT * FROM location_snapshots WHERE user_id = ?').bind(user.id).first()
    let ta = null
    if (taId) {
      ta = await env.DB.prepare('SELECT * FROM location_snapshots WHERE user_id = ?').bind(taId).first()
      if (ta && ta.visible === 0) ta = { user_id: taId, hidden: true }
    }
    return json({ me, ta })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 9. 预警 ----------
router.add('GET', '/api/alerts/list', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({ list: [] })
    // 先补列（不炸），保证 days_left/title/type 可读
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN days_left INTEGER').run() } catch (e) {}
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN title TEXT').run() } catch (e) {}
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN type TEXT').run() } catch (e) {}
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN note TEXT').run() } catch (e) {}
    const rows = rowsOf(await env.DB.prepare(
      'SELECT * FROM alerts WHERE couple_id = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(couple.id).all())
    const today_ = today()
    const todayD = new Date(today_)
    const list = rows.map(a => {
      let dl = Number(a.days_left != null ? a.days_left : a.days)
      if (!Number.isFinite(dl) || dl < 0) {
        try {
          if (a.start_date) {
            dl = Math.ceil((new Date(a.start_date) - todayD) / (1000*60*60*24))
          } else dl = 0
        } catch (_) { dl = 0 }
      }
      return {
        id: a.id,
        level: a.level,
        days: a.days,
        days_left: dl,
        date: a.start_date || today_,
        start_date: a.start_date,
        title: a.title || (a.note ? `提醒（${dl}天后）` : null) || '重要日子',
        note: a.note || '',
        type: a.type || '纪念日',
        status: a.status,
        created_at: a.created_at
      }
    })
    return json({ list })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 预警检测：从今天往回数连续坏情绪
async function scheduleAlertCheck(coupleId, env) {
  const today_ = today()
  const badWeatherQuery = []
  for (let i = 0; i < 14; i++) {
    const d = new Date(); d.setDate(d.getDate() - i)
    badWeatherQuery.push(fmtDate(d.toISOString()))
  }
  // 直接查询 mood_records 拿到个人情绪，按情绪名判断是否消极
  const rows = rowsOf(await env.DB.prepare(
    `SELECT record_date, weather FROM mood_records WHERE couple_id = ? AND record_date IN (${badWeatherQuery.map(()=>'?').join(',')}) ORDER BY record_date DESC`
  ).bind(coupleId, ...badWeatherQuery).all())

  let streak = 0
  for (const date of badWeatherQuery) {
    const dayRows = rows.filter(r => r.record_date === date)
    if (!dayRows.length) break
    // 只要任意一方情绪属于消极，就算"坏情绪"
    const hasBad = dayRows.some(r => BAD_EMOTIONS.has(r.weather))
    if (!hasBad) break
    streak++
  }
  if (streak >= 3) {
    const level = streak >= 7 ? 'orange' : (streak >= 5 ? 'yellow' : 'blue')
    const start = badWeatherQuery[streak - 1]
    const now = nowISO()
    const active = await env.DB.prepare("SELECT * FROM alerts WHERE couple_id = ? AND status = 'active' LIMIT 1")
      .bind(coupleId).first()
    if (!active) {
      await env.DB.prepare(
        "INSERT INTO alerts (id,couple_id,level,start_date,days,status,created_at) VALUES (?,?,?,?,?,'active',?)"
      ).bind(uuid(), coupleId, level, start, streak, now).run()
    } else {
      await env.DB.prepare(
        "UPDATE alerts SET days = ?, level = ?, updated_at = COALESCE(updated_at, created_at) WHERE id = ?"
      ).bind(streak, level, active.id).run()
    }
  } else {
    // 关闭还在 active 的预警
    const active = await env.DB.prepare("SELECT * FROM alerts WHERE couple_id = ? AND status = 'active' LIMIT 1")
      .bind(coupleId).first()
    if (active) {
      await env.DB.prepare("UPDATE alerts SET status = 'closed', closed_at = ?, end_date = ? WHERE id = ?")
        .bind(nowISO(), today_, active.id).run()
    }
  }
}

// ---------- 10. 管理员后台 ----------
function requireAdmin(request, env) {
  // 方式1：Authorization Bearer <token> 且 admin_level=1
  // 方式2：简单密码模式：X-Admin-Pass 环境变量
  const pass = request.headers.get('X-Admin-Pass')
  if (pass === env.ADMIN_PASS) return true
  return false
}

router.add('POST', '/api/admin/login', async (env, ctx) => {
  try {
    const { password } = await ctx.request.json()
    if (password !== env.ADMIN_PASS) return json({}, 401, '密码错误', 401)
    const token = await signJWT({ admin: true }, env.JWT_SECRET)
    return json({ token })
  } catch (e) { return json({}, 500, e.message, 500) }
})

router.add('GET', '/api/admin/kpi', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const users = (await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first()).c
    const couples = (await env.DB.prepare("SELECT COUNT(*) AS c FROM couples WHERE status = 'bound'").first()).c
    const today_ = today()
    const dau = (await env.DB.prepare('SELECT COUNT(DISTINCT user_id) AS c FROM mood_records WHERE record_date = ?').bind(today_).first()).c
    const records = (await env.DB.prepare('SELECT COUNT(*) AS c FROM mood_records WHERE record_date = ?').bind(today_).first()).c
    return json({ total_users: users, bound_couples: couples, today_active: dau, today_records: records })
  } catch (e) { return json({}, 500, e.message, 500) }
})

router.add('POST', '/api/admin/ai-test', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const body = await ctx.request.json().catch(() => ({}))
    const prompt = body.prompt || '用一句话温柔地问候一下'
    const res = await callQianwenAPI(env, prompt, { maxTokens: 200, temperature: 0.8 })
    return json({ ok: res.ok, text: res.text, modelsTried: res.modelsTried || [] })
  } catch (e) { return json({}, 500, e.message, 500) }
})

router.add('GET', '/api/admin/users', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const url = new URL(ctx.request.url)
    const page = Number(url.searchParams.get('page') || 1)
    const size = Math.min(50, Number(url.searchParams.get('size') || 20))
    const offset = (page - 1) * size

    // 用户 + 最新位置（位置仅显示城市级，不返回精确经纬度）
    const rows = rowsOf(await env.DB.prepare(`
      SELECT u.id, u.nickname, u.avatar_url, u.created_at,
             c.status AS couple_status,
             ls.city AS location_city, ls.visible AS location_visible, ls.updated_at AS location_updated
      FROM users u
      LEFT JOIN couples c ON (c.user_a_id = u.id OR c.user_b_id = u.id) AND c.status != 'unbound'
      LEFT JOIN location_snapshots ls ON ls.user_id = u.id
      ORDER BY u.created_at DESC LIMIT ? OFFSET ?
    `).bind(size, offset).all())

    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first()).c
    return json({ list: rows, total, page, size })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// ---------- 10.2 管理后台扩展接口 ----------
// 用户详情：含位置、绑定、最近心情/运动/计时/账单
router.add('GET', '/api/admin/user/detail', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const id = new URL(ctx.request.url).searchParams.get('id')
    if (!id) return json({}, 400, '缺少 id', 400)
    const user = await env.DB.prepare('SELECT id,openid,nickname,avatar_url,admin_level,created_at,updated_at FROM users WHERE id = ?').bind(id).first()
    if (!user) return json({}, 404, '用户不存在', 404)
    const couple = await env.DB.prepare('SELECT * FROM couples WHERE (user_a_id = ? OR user_b_id = ?) AND status != ?').bind(id, id, 'unbound').first()
    const location = await env.DB.prepare('SELECT * FROM location_snapshots WHERE user_id = ?').bind(id).first()
    const moods = rowsOf(await env.DB.prepare('SELECT id,weather,note,record_date,created_at FROM mood_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all())
    const sports = rowsOf(await env.DB.prepare('SELECT id,sport_type,duration,distance,steps,sport_date,created_at FROM sport_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all())
    const timers = rowsOf(await env.DB.prepare('SELECT id,mode,category,duration,timer_date,created_at FROM timer_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all())
    const bills = rowsOf(await env.DB.prepare('SELECT id,amount,category,note,bill_date,created_at FROM couple_bills WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(id).all())
    return json({ user, couple, location, moods, sports, timers, bills })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// 所有用户最新位置
router.add('GET', '/api/admin/locations', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const rows = rowsOf(await env.DB.prepare(`
      SELECT u.id, u.nickname, u.avatar_url, u.created_at,
             ls.lat, ls.lng, ls.province, ls.city, ls.district, ls.street, ls.poi, ls.address, ls.visible, ls.updated_at
      FROM users u
      LEFT JOIN location_snapshots ls ON ls.user_id = u.id
      ORDER BY ls.updated_at DESC
    `).all())
    return json({ list: rows })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// 情侣绑定列表
router.add('GET', '/api/admin/couples', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const url = new URL(ctx.request.url)
    const page = Number(url.searchParams.get('page') || 1)
    const size = Math.min(100, Number(url.searchParams.get('size') || 50))
    const offset = (page - 1) * size
    const rows = rowsOf(await env.DB.prepare(`
      SELECT c.*, a.nickname AS user_a_name, b.nickname AS user_b_name
      FROM couples c
      LEFT JOIN users a ON a.id = c.user_a_id
      LEFT JOIN users b ON b.id = c.user_b_id
      ORDER BY c.updated_at DESC LIMIT ? OFFSET ?
    `).bind(size, offset).all())
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM couples').first()).c
    return json({ list: rows, total, page, size })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// 心情记录列表
router.add('GET', '/api/admin/moods', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const url = new URL(ctx.request.url)
    const page = Number(url.searchParams.get('page') || 1)
    const size = Math.min(100, Number(url.searchParams.get('size') || 50))
    const offset = (page - 1) * size
    const rows = rowsOf(await env.DB.prepare(`
      SELECT m.id, m.weather, m.note, m.record_date, m.created_at,
             u.nickname AS user_name, u.avatar_url AS user_avatar
      FROM mood_records m
      LEFT JOIN users u ON u.id = m.user_id
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?
    `).bind(size, offset).all())
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM mood_records').first()).c
    return json({ list: rows, total, page, size })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// 运动记录列表
router.add('GET', '/api/admin/sport', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const url = new URL(ctx.request.url)
    const page = Number(url.searchParams.get('page') || 1)
    const size = Math.min(100, Number(url.searchParams.get('size') || 50))
    const offset = (page - 1) * size
    const rows = rowsOf(await env.DB.prepare(`
      SELECT s.id, s.sport_type, s.duration, s.distance, s.steps, s.sport_date, s.created_at, s.note,
             u.nickname AS user_name, u.avatar_url AS user_avatar
      FROM sport_records s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC LIMIT ? OFFSET ?
    `).bind(size, offset).all())
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM sport_records').first()).c
    return json({ list: rows, total, page, size })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// 计时记录列表
router.add('GET', '/api/admin/timer', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const url = new URL(ctx.request.url)
    const page = Number(url.searchParams.get('page') || 1)
    const size = Math.min(100, Number(url.searchParams.get('size') || 50))
    const offset = (page - 1) * size
    const rows = rowsOf(await env.DB.prepare(`
      SELECT t.id, t.mode, t.category, t.duration, t.timer_date, t.created_at, t.note,
             u.nickname AS user_name, u.avatar_url AS user_avatar
      FROM timer_sessions t
      LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.created_at DESC LIMIT ? OFFSET ?
    `).bind(size, offset).all())
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM timer_sessions').first()).c
    return json({ list: rows, total, page, size })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// 账单记录列表
router.add('GET', '/api/admin/bills', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const url = new URL(ctx.request.url)
    const page = Number(url.searchParams.get('page') || 1)
    const size = Math.min(100, Number(url.searchParams.get('size') || 50))
    const offset = (page - 1) * size
    const rows = rowsOf(await env.DB.prepare(`
      SELECT b.id, b.amount, b.category, b.note, b.bill_date, b.created_at,
             u.nickname AS user_name, u.avatar_url AS user_avatar
      FROM couple_bills b
      LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC LIMIT ? OFFSET ?
    `).bind(size, offset).all())
    const total = (await env.DB.prepare('SELECT COUNT(*) AS c FROM couple_bills').first()).c
    return json({ list: rows, total, page, size })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// 删除用户（连带删除其关联数据）
router.add('POST', '/api/admin/user/delete', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const { id } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    // 按依赖顺序删除
    await env.DB.prepare('DELETE FROM mood_records WHERE user_id = ?').bind(id).run()
    await env.DB.prepare('DELETE FROM sport_records WHERE user_id = ?').bind(id).run()
    await env.DB.prepare('DELETE FROM timer_sessions WHERE user_id = ?').bind(id).run()
    await env.DB.prepare('DELETE FROM couple_bills WHERE user_id = ?').bind(id).run()
    await env.DB.prepare('DELETE FROM wishes WHERE user_id = ?').bind(id).run()
    await env.DB.prepare('DELETE FROM location_snapshots WHERE user_id = ?').bind(id).run()
    await env.DB.prepare('DELETE FROM couples WHERE user_a_id = ? OR user_b_id = ?').bind(id, id).run()
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run()
    return json({ ok: true })
  } catch (e) { return json({}, 500, e.message, 500) }
})

// ---------- 10.5 前端兼容别名路由 + 缺失接口 ----------
// 别名：前端用的旧路径名，后端用不同名字
router.add('GET', '/api/couple/info', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    let couple = await getUserCouple(user.id, env)
    const now = nowISO()
    if (!couple) {
      const id = uuid()
      const code = genInviteCode()
      await env.DB.prepare(
        'INSERT INTO couples (id,user_a_id,user_b_id,bind_date,status,invite_code,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(id, user.id, null, null, 'pending', code, now, now).run()
      couple = await env.DB.prepare('SELECT * FROM couples WHERE id = ?').bind(id).first()
    } else if (!couple.invite_code) {
      const code = genInviteCode()
      await env.DB.prepare('UPDATE couples SET invite_code = ?, updated_at = ? WHERE id = ?')
        .bind(code, now, couple.id).run()
      couple.invite_code = code
    }
    const isBound = couple.status === 'bound'
    const isA = couple.user_a_id === user.id
    const isB = couple.user_b_id === user.id
    const taId = isA ? couple.user_b_id : couple.user_a_id
    let ta = null
    if (taId) {
      const t = await env.DB.prepare('SELECT id,nickname,avatar_url FROM users WHERE id = ?').bind(taId).first()
      ta = t || null
    }
    const visibleToMe = ta ? (ta.visible_to_me !== false) : true
    return json({
      bound: isBound,
      status: couple.status,
      bind_date: couple.bind_date,
      couple_id: couple.id,
      invite_code: couple.invite_code,
      my_code: couple.invite_code,
      my_invite: couple.invite_code,
      ta_bound: !!couple.user_b_id,
      ta,
      ta_info: ta,
      is_a: isA,
      is_b: isB,
      user_a_id: couple.user_a_id,
      user_b_id: couple.user_b_id,
      visible_to_me: visibleToMe,
      pending: couple.status === 'pending' && !!couple.user_b_id,
      rejected: couple.status === 'rejected'
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})
router.add('POST', '/api/user/update', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const raw = await ctx.request.text()
    let body = {}
    try { body = JSON.parse(raw) } catch (_) {}
    let avatarUrl = body.avatar_url || ''
    // 如果传了 base64 头像，存到 KV，返回永久 URL
    if (body.avatar_base64) {
      const b64 = String(body.avatar_base64).replace(/^data:image\/\w+;base64,/, '')
      try {
        await env.KV.put('avatar:' + user.id, b64)
        avatarUrl = '/api/avatar/' + user.id
      } catch (e) {
        console.error('KV put avatar error', e)
      }
    }
    await env.DB.prepare('UPDATE users SET nickname = COALESCE(NULLIF(?,""), nickname), avatar_url = COALESCE(NULLIF(?,""), avatar_url), updated_at = ? WHERE id = ?')
      .bind(body.nickname || '', avatarUrl, nowISO(), user.id).run()
    const u = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first()
    return json({ id: u.id, nickname: u.nickname, avatar_url: u.avatar_url })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 头像图片代理（从 KV 读取 base64 返回图片）
router.add('GET', '/api/avatar/:uid', async (env, ctx, params) => {
  const uid = params && params.uid
  if (!uid) return new Response('', { status: 404 })
  try {
    let b64 = await env.KV.get('avatar:' + uid)
    if (!b64) return new Response('', { status: 404 })
    // 兼容前端可能没剥干净的 data URI 前缀
    let contentType = 'image/jpeg'
    const dataUriMatch = b64.match(/^data:image\/(\w+);base64,/)
    if (dataUriMatch) {
      contentType = 'image/' + dataUriMatch[1]
      b64 = b64.slice(dataUriMatch[0].length)
    }
    // 过滤非法 base64 字符
    b64 = b64.replace(/[^A-Za-z0-9+/=]/g, '')
    if (!b64) return new Response('', { status: 404 })
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return new Response(arr, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (e) {
    console.error('avatar proxy error', uid, e.message || e)
    return new Response('', { status: 404 })
  }
})
router.add('POST', '/api/wish/save', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定', 400)
    const body = await ctx.request.json()
    const wish_weather = body.wish_weather || body.weather || body.wish
    const reason = body.reason || body.content || body.note || ''
    if (!wish_weather) return json({}, 400, '缺少 wish_weather', 400)
    const td = tomorrow()
    await env.DB.prepare(`
      INSERT INTO wishes (id,user_id,couple_id,wish_weather,reason,target_date,fulfilled,created_at)
      VALUES (?,?,?,?,?,?,0,?)
      ON CONFLICT(user_id, target_date) DO UPDATE SET
        wish_weather = excluded.wish_weather, reason = excluded.reason
    `).bind(uuid(), user.id, couple.id, wish_weather, reason || '', td, nowISO()).run()
    return json({ ok: true, target_date: td, wish_weather, reason })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})
router.add('GET', '/api/location/latest', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({ me: null, ta: null, visible_to_me: true, visible_to_ta: true, distance_km: null })
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const me = await env.DB.prepare('SELECT * FROM location_snapshots WHERE user_id = ?').bind(user.id).first()
    let ta = null
    if (taId) {
      ta = await env.DB.prepare('SELECT * FROM location_snapshots WHERE user_id = ?').bind(taId).first()
      if (ta && ta.visible === 0) ta = { user_id: taId, hidden: true }
    }
    let distance_km = null
    try {
      if (me && ta && me.lat && me.lng && ta.lat && ta.lng) {
        const R = 6371
        const rad = Math.PI / 180
        const dLat = (ta.lat - me.lat) * rad
        const dLng = (ta.lng - me.lng) * rad
        const a = Math.sin(dLat/2)**2 + Math.cos(me.lat*rad) * Math.cos(ta.lat*rad) * Math.sin(dLng/2)**2
        distance_km = +(2 * R * Math.asin(Math.sqrt(a))).toFixed(2)
      }
    } catch (_) {}
    function formatLoc(row) {
      const parts = [row.province, row.city, row.district, row.poi, row.street].filter(Boolean)
      const brief = [row.city, row.district].filter(Boolean).join(' · ') || row.city || row.district || ''
      return {
        ...row,
        province: row.province || row.city || '',
        city: row.city || '',
        district: row.district || '',
        street: row.street || '',
        poi: row.poi || '',
        address: row.address || parts.join(' · ') || brief,
        lat: row.lat,
        lng: row.lng,
        latitude: row.lat,
        longitude: row.lng,
        updated_at: row.updated_at
      }
    }
    return json({
      me: me ? formatLoc(me) : null,
      ta: ta && !ta.hidden ? formatLoc(ta) : ta,
      visible_to_me: true,
      visible_to_ta: me ? (me.visible === 1) : true,
      distance_km
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 兼容：前端传 calendar/list?year=&month= 的 query 形式
router.add('GET', '/api/calendar/list', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const url = new URL(ctx.request.url)
    const y = Number(url.searchParams.get('year') || new Date().getFullYear())
    const m = Number(url.searchParams.get('month') || (new Date().getMonth() + 1))
    const couple = await getUserCouple(user.id, env)
    const daysInMonth = new Date(y, m, 0).getDate()
    const start = `${y}-${String(m).padStart(2,'0')}-01`
    const end = `${y}-${String(m).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`
    const days = []
    let sunny = 0, rainy = 0, rainbow = 0, streak = 0, curStreak = 0
    if (couple && couple.status === 'bound') {
      const swRows = rowsOf(await env.DB.prepare(
        'SELECT record_date, weather_name FROM shared_weather WHERE couple_id = ? AND record_date BETWEEN ? AND ?'
      ).bind(couple.id, start, end).all())
      const moodRows = rowsOf(await env.DB.prepare(
        'SELECT user_id, weather, note, ta_rating, record_date FROM mood_records WHERE couple_id = ? AND record_date BETWEEN ? AND ?'
      ).bind(couple.id, start, end).all())
      const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
      for (let i = 1; i <= daysInMonth; i++) {
        const ds = `${y}-${String(m).padStart(2,'0')}-${String(i).padStart(2,'0')}`
        const sw = swRows.find(r => r.record_date === ds)?.weather_name || null
        const myR = moodRows.find(r => r.record_date === ds && r.user_id === user.id)
        const taR = moodRows.find(r => r.record_date === ds && r.user_id === taId)
        const emojiMap = { '晴':'☀️','多云':'⛅','阴':'☁️','小雨':'🌧️','雷暴':'⛈️','彩虹':'🌈' }
        const textColor = { '晴':'#8B5A00','多云':'#3A4A66','阴':'#4A4A5C','小雨':'#1F3A52','雷暴':'#FFFFFF','彩虹':'#7A2A44' }
        days.push({
          date: ds, day: i, dayNum: i,
          weatherName: sw || null,
          weather: sw || null,
          emoji: sw ? (emojiMap[sw] || '⛅') : null,
          textColor: sw ? (textColor[sw] || '#3A4A66') : null,
          shared: sw,
          my: myR ? { weather: myR.weather, note: myR.note, ta_rating: myR.ta_rating } : null,
          ta: taR ? { weather: taR.weather, note: taR.note, ta_rating: taR.ta_rating } : null
        })
        if (sw) {
          if (sw.includes('晴') || sw === '万里无云' || sw === '彩虹' || sw === '双彩虹') { sunny++; curStreak++; if (curStreak>streak) streak=curStreak }
          else curStreak = 0
          if (sw.includes('雨') || sw.includes('暴')) rainy++
          if (sw.includes('虹')) rainbow++
        } else curStreak = 0
      }
    } else {
      for (let i = 1; i <= daysInMonth; i++) {
        days.push({
          date: `${y}-${String(m).padStart(2,'0')}-${String(i).padStart(2,'0')}`,
          day: i, dayNum: i, weatherName: null, weather: null, emoji: null,
          shared: null, my: null, ta: null
        })
      }
    }
    return json({ list: days, days, stats: { sunny, rainy, rainbow, streak } })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 兼容：前端传 report/monthly?yyyymm=202608
router.add('GET', '/api/report/monthly', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const url = new URL(ctx.request.url)
    let yyyymm = String(url.searchParams.get('yyyymm') || '')
    let y, m
    if (yyyymm && yyyymm.length >= 6) { y = Number(yyyymm.slice(0,4)); m = Number(yyyymm.slice(4,6)) }
    else { const now = new Date(); y = now.getFullYear(); m = now.getMonth() + 1 }
    const couple = await getUserCouple(user.id, env)
    const daysInMonth = new Date(y, m, 0).getDate()
    const start = `${y}-${String(m).padStart(2,'0')}-01`
    const end = `${y}-${String(m).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`
    const dist = { '晴':0, '多云':0, '阴':0, '小雨':0, '雷暴':0, '彩虹':0 }
    let avgTemp = 0, count = 0
    const tempMap = { '晴':28,'多云':22,'阴':15,'小雨':10,'雷暴':5,'彩虹':30 }
    let streakSun = 0, curSun = 0, streakRain = 0, curRain = 0
    const raw = []
    if (couple && couple.status === 'bound') {
      const rows = rowsOf(await env.DB.prepare(
        'SELECT record_date, weather_name FROM shared_weather WHERE couple_id = ? AND record_date BETWEEN ? AND ? ORDER BY record_date'
      ).bind(couple.id, start, end).all())
      for (const r of rows) {
        raw.push({ date: r.record_date, w: r.weather_name })
        const w = r.weather_name
        if (w.includes('晴') || w === '万里无云') { dist['晴']++; curSun++; curRain = 0; avgTemp += tempMap['晴']; count++ }
        else if (w.includes('虹')) { dist['彩虹']++; curSun++; curRain = 0; avgTemp += tempMap['彩虹']; count++ }
        else if (w.includes('多云')) { dist['多云']++; curSun = 0; curRain = 0; avgTemp += tempMap['多云']; count++ }
        else if (w === '阴天' || w === '半晴' || w === '阴转多云') { dist['阴']++; curSun = 0; curRain = 0; avgTemp += tempMap['阴']; count++ }
        else if (w.includes('暴')) { dist['雷暴']++; curRain++; curSun = 0; avgTemp += tempMap['雷暴']; count++ }
        else if (w.includes('雨')) { dist['小雨']++; curRain++; curSun = 0; avgTemp += tempMap['小雨']; count++ }
        else { dist['多云']++; curSun=0; curRain=0; avgTemp += tempMap['多云']; count++ }
        if (curSun > streakSun) streakSun = curSun
        if (curRain > streakRain) streakRain = curRain
      }
    }
    if (count === 0) count = 1
    const avgT = Math.round(avgTemp / count)
    const entries = Object.entries(dist).sort((a,b) => b[1]-a[1])
    const major = entries[0] && entries[0][1] ? entries[0][0] : '多云'
    const analyst = {
      p1: `这个月，你们有 ${dist['晴']+dist['彩虹']} 天是晴天和彩虹，最长连晴 ${streakSun} 天 🌞`,
      p2: `阴雨天 ${dist['阴']+dist['小雨']+dist['雷暴']} 天，最长阴雨 ${streakRain} 天；每一场雨，都是你们下次遇见彩虹的铺垫 🌈`,
      p3: `本月你们最常遇到的天气是「${major}」，平均温度 ${avgT}℃；月底记得给 TA 一个甜甜的拥抱 💕`
    }
    return json({
      year: y, month: m, yyyymm: `${y}${String(m).padStart(2,'0')}`,
      avg_temp: avgT,
      avgTemp: avgT,
      avg_temperature: avgT,
      distribution: dist,
      dist,
      streaks: { sun: streakSun, rain: streakRain },
      sunny_streak: streakSun,
      rainy_streak: streakRain,
      couple_bound: !!(couple && couple.status === 'bound'),
      total_days: raw.length,
      p1: analyst.p1,
      p2: analyst.p2,
      p3: analyst.p3,
      summary: analyst.p1,
      major
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 缺失：心愿历史列表 getWishList
router.add('GET', '/api/wish/list', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const list = []
    if (couple) {
      const rows = rowsOf(await env.DB.prepare(
        'SELECT * FROM wishes WHERE couple_id = ? ORDER BY target_date DESC, created_at DESC LIMIT 100'
      ).bind(couple.id).all())
      const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
      for (const w of rows) {
        const authorNick = w.user_id === user.id ? '我' : 'TA'
        const isMine = w.user_id === user.id
        list.push({
          id: w.id,
          user_id: w.user_id,
          is_mine: isMine,
          author: authorNick,
          weather: w.wish_weather,
          wish_weather: w.wish_weather,
          reason: w.reason || '',
          title: w.reason ? w.reason.slice(0,10) : '',
          content: w.reason || '',
          target_date: w.target_date,
          fulfilled: Number(w.fulfilled) === 1,
          status: Number(w.fulfilled) === 1 ? 'fulfilled' : 'pending',
          created_at: w.created_at
        })
      }
    }
    return json({ list })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 缺失：更新心愿状态（fulfilled / pending）
router.add('POST', '/api/wish/status', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { id, status } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    const wish = await env.DB.prepare('SELECT * FROM wishes WHERE id = ?').bind(id).first()
    if (!wish) return json({}, 404, '心愿不存在', 404)
    if (wish.user_id !== user.id) return json({}, 403, '只能修改自己的心愿', 403)
    const f = (status === 'fulfilled' || Number(status) === 1) ? 1 : 0
    await env.DB.prepare('UPDATE wishes SET fulfilled = ? WHERE id = ?').bind(f, id).run()
    return json({ ok: true, id, fulfilled: f, done: f === 1, status: f === 1 ? 'fulfilled' : 'pending' })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})
// 前端兼容：toggle 接口（不传 status 就取反）
router.add('POST', '/api/wish/toggle', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { id, status } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    const wish = await env.DB.prepare('SELECT * FROM wishes WHERE id = ?').bind(id).first()
    if (!wish) return json({}, 404, '心愿不存在', 404)
    if (wish.user_id !== user.id) return json({}, 403, '只能修改自己的心愿', 403)
    let f
    if (status !== undefined && status !== null && status !== '') {
      f = (status === 'fulfilled' || status === true || Number(status) === 1) ? 1 : 0
    } else {
      f = Number(wish.fulfilled) === 1 ? 0 : 1
    }
    await env.DB.prepare('UPDATE wishes SET fulfilled = ? WHERE id = ?').bind(f, id).run()
    return json({ ok: true, id, fulfilled: f, done: f === 1, status: f === 1 ? 'fulfilled' : 'pending' })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 缺失：删除心愿
router.add('POST', '/api/wish/delete', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { id } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    const wish = await env.DB.prepare('SELECT * FROM wishes WHERE id = ?').bind(id).first()
    if (!wish) return json({ ok: true })
    if (wish.user_id !== user.id) return json({}, 403, '只能删除自己的心愿', 403)
    await env.DB.prepare('DELETE FROM wishes WHERE id = ?').bind(id).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 缺失：用户KPI统计（"我的"页面头部数据：天数、晴天、彩虹数）
router.add('GET', '/api/user/kpi', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    const result = { days: 0, sunny: 0, rainbow: 0, records: 0 }
    if (couple) {
      // 绑定了多少天
      if (couple.bind_date) {
        const bd = new Date(couple.bind_date)
        const today = new Date()
        result.days = Math.max(0, Math.floor((today - bd) / (1000 * 60 * 60 * 24)) + 1)
      }
      // 我记录了多少条 mood
      const myTotal = await env.DB.prepare(
        'SELECT COUNT(*) AS c FROM mood_records WHERE user_id = ?'
      ).bind(user.id).first()
      result.records = myTotal ? myTotal.c : 0
      // 该情侣所有共同天气中，晴天/彩虹天数
      const rows = rowsOf(await env.DB.prepare(
        'SELECT weather_name FROM shared_weather WHERE couple_id = ?'
      ).bind(couple.id).all())
      for (const r of rows) {
        const w = r.weather_name || ''
        if (w.includes('晴') || w === '万里无云') result.sunny++
        if (w.includes('虹')) result.rainbow++
      }
    }
    return json(result)
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 缺失：创建预警（用户手动添加纪念日/生日等）
router.add('POST', '/api/alerts/create', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({}, 400, '请先绑定', 400)
    // 先尝试补列（不炸）
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN title TEXT').run() } catch (e) {}
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN note TEXT').run() } catch (e) {}
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN days_left INTEGER').run() } catch (e) {}
    try { await env.DB.prepare('ALTER TABLE alerts ADD COLUMN type TEXT').run() } catch (e) {}

    const body = await ctx.request.json()
    const title = body.title || body.name || ''
    if (!title) return json({}, 400, '标题必填', 400)
    const id = uuid()
    const now = nowISO()
    const today_ = today()
    const date = body.date || today_
    let dl = Number(body.days_left != null ? body.days_left : body.days)
    if (!Number.isFinite(dl)) {
      try {
        const diff = Math.ceil((new Date(date) - new Date(today_)) / (1000*60*60*24))
        dl = Number.isFinite(diff) ? diff : 0
      } catch (_) { dl = 0 }
    }
    const lv = body.level || (dl <= 3 ? 'orange' : (dl <= 7 ? 'yellow' : 'blue'))
    const note = body.note || ''
    await env.DB.prepare(
      `INSERT INTO alerts (id,couple_id,level,start_date,end_date,days,days_left,status,created_at,title,note,type) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?)`
    ).bind(id, couple.id, lv, date, null, dl, dl, now, title || '', note, body.type || '').run()
    return json({ ok: true, id, days: dl, days_left: dl, level: lv, title, date, note })
  } catch (e) {
    console.error('alert create err', e)
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 缺失：删除预警
router.add('POST', '/api/alerts/delete', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { id } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({ ok: true })
    const al = await env.DB.prepare('SELECT * FROM alerts WHERE id = ?').bind(id).first()
    if (!al) return json({ ok: true })
    if (al.couple_id !== couple.id) return json({}, 403, '非本情侣预警', 403)
    await env.DB.prepare('DELETE FROM alerts WHERE id = ?').bind(id).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 真实天气代理（Open-Meteo） ----------
function fmtHourly(data) {
  const times = data.hourly?.time || []
  const temps = data.hourly?.temperature_2m || []
  const codes = data.hourly?.weather_code || []
  return times.map((t, i) => ({
    time: String(t).slice(11, 16) || '',
    temp: temps[i],
    weather_code: codes[i],
    weather_desc: (WMO_CODES[codes[i]] || { desc: '未知' }).desc,
    weather_emoji: (WMO_CODES[codes[i]] || { emoji: '❓' }).emoji
  }))
}

function fmtDaily(data) {
  const dates = data.daily?.time || []
  const maxs = data.daily?.temperature_2m_max || []
  const mins = data.daily?.temperature_2m_min || []
  const codes = data.daily?.weather_code || []
  return dates.map((d, i) => ({
    date: String(d).slice(5, 10) || '',
    weekday: ['周日','周一','周二','周三','周四','周五','周六'][new Date(d).getDay()] || '',
    temp_max: maxs[i],
    temp_min: mins[i],
    weather_code: codes[i],
    weather_desc: (WMO_CODES[codes[i]] || { desc: '未知' }).desc,
    weather_emoji: (WMO_CODES[codes[i]] || { emoji: '❓' }).emoji
  }))
}

router.add('GET', '/api/weather/real', async (env, ctx) => {
  try {
    await requireUser(ctx.request, env)
    const url = new URL(ctx.request.url)
    const lat = url.searchParams.get('lat')
    const lon = url.searchParams.get('lon')
    if (lat == null || lon == null) return json({}, 400, '缺少 lat/lon', 400)

    const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto&forecast_days=1`
    const resp = await fetch(apiUrl)
    const data = await resp.json()

    const code = data.current?.weather_code
    const wmo = WMO_CODES[code] || { desc: '未知', emoji: '❓' }

    return json({
      temperature: data.current?.temperature_2m,
      humidity: data.current?.relative_humidity_2m,
      wind_speed: data.current?.wind_speed_10m,
      weather_code: code,
      weather_desc: wmo.desc,
      weather_emoji: wmo.emoji
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '获取天气失败', e.code ? 401 : 500)
  }
})

router.add('GET', '/api/weather/real/forecast', async (env, ctx) => {
  try {
    await requireUser(ctx.request, env)
    const url = new URL(ctx.request.url)
    const lat = url.searchParams.get('lat')
    const lon = url.searchParams.get('lon')
    if (lat == null || lon == null) return json({}, 400, '缺少 lat/lon', 400)

    const apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&hourly=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7`
    const resp = await fetch(apiUrl)
    const data = await resp.json()

    const code = data.current?.weather_code
    const wmo = WMO_CODES[code] || { desc: '未知', emoji: '❓' }

    // 取未来 24 小时（从当前小时开始）
    const nowHour = new Date().getHours()
    const hourly = fmtHourly(data)
    const hourly24 = hourly.filter((h) => {
      const hInt = parseInt(h.time.slice(0, 2), 10)
      return hInt >= nowHour
    }).slice(0, 24)

    return json({
      current: {
        temperature: data.current?.temperature_2m,
        humidity: data.current?.relative_humidity_2m,
        wind_speed: data.current?.wind_speed_10m,
        weather_code: code,
        weather_desc: wmo.desc,
        weather_emoji: wmo.emoji
      },
      hourly: hourly24,
      daily: fmtDaily(data)
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '获取天气失败', e.code ? 401 : 500)
  }
})

// ---------- 11. 健康检查 ----------
router.add('GET', '/api/health', async (env) => json({ status: 'ok', time: nowISO() }))

// ---------- 12. 小程序码（分享海报用） ----------
async function getAccessToken(env) {
  const appid = env.WECHAT_APPID
  const secret = env.WECHAT_SECRET
  if (!secret) {
    throw new Error('WECHAT_SECRET 未配置，请运行 npx wrangler secret put WECHAT_SECRET 设置微信 AppSecret')
  }
  const cacheKey = 'wechat_access_token'
  try {
    const cached = await env.KV.get(cacheKey)
    if (cached) return cached
  } catch (_) {}
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appid}&secret=${secret}`
  const resp = await fetch(url)
  const data = await resp.json()
  if (!data || !data.access_token) throw new Error(data.errmsg || '获取 access_token 失败')
  try {
    await env.KV.put(cacheKey, data.access_token, { expirationTtl: Math.max(100, (data.expires_in || 7200) - 300) })
  } catch (_) {}
  return data.access_token
}

router.add('GET', '/api/wxacode', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const url = new URL(ctx.request.url)
    const scene = url.searchParams.get('scene') || ('u=' + user.id)
    const page = url.searchParams.get('page') || 'pages/profile/profile'

    let token = null
    try {
      token = await getAccessToken(env)
    } catch (te) {
      console.error('getAccessToken error, will try fallback QR', te.message || te)
    }

    if (token) {
      // 1. 优先用 getwxacode 接口（已发布小程序可用，生成小程序码）
      try {
        const path = scene ? (page + '?' + scene) : page
        const body = JSON.stringify({
          path,
          width: 280,
          auto_color: false,
          line_color: { r: 255, g: 143, b: 171 }
        })
        const resp = await fetch(`https://api.weixin.qq.com/wxa/getwxacode?access_token=${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        })
        const contentType = resp.headers.get('Content-Type') || ''
        if (contentType.includes('image')) {
          const buf = await resp.arrayBuffer()
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
          return json({ base64: 'data:image/png;base64,' + base64, scene, page, type: 'wxacode' })
        }
        const err = await resp.json().catch(() => ({}))
        console.error('getwxacode error', JSON.stringify(err))
        if (err.errcode === 40001 || err.errcode === 42001) {
          try { await env.KV.delete('wechat_access_token') } catch (_) {}
        }
      } catch (fe) {
        console.error('getwxacode fetch error', fe.message || fe)
      }

      // 2. 备用：getwxacodeunlimited 接口
      try {
        const body = JSON.stringify({
          scene,
          page,
          check_path: false,
          width: 280,
          auto_color: false,
          line_color: { r: 255, g: 143, b: 171 }
        })
        const resp = await fetch(`https://api.weixin.qq.com/wxa/getwxacodeunlimited?access_token=${token}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        })
        const contentType = resp.headers.get('Content-Type') || ''
        if (contentType.includes('image')) {
          const buf = await resp.arrayBuffer()
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
          return json({ base64: 'data:image/png;base64,' + base64, scene, page, type: 'unlimited' })
        }
        const err = await resp.json().catch(() => ({}))
        console.error('getwxacodeunlimited error', JSON.stringify(err))
      } catch (fe) {
        console.error('getwxacodeunlimited fetch error', fe.message || fe)
      }
    }

    // 3. Fallback: 生成普通二维码（编码邀请码）
    const codeMatch = scene.match(/(?:code|invite)=([A-Za-z0-9]+)/)
    const qrData = codeMatch ? codeMatch[1] : scene
    console.log('wxacode fallback to regular QR, data:', qrData)
    const qrSources = [
      `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=2&bgcolor=FFFFFF&color=000000&data=${encodeURIComponent(qrData)}`,
      `https://quickchart.io/qr?size=280&margin=2&dark=000000&light=FFFFFF&text=${encodeURIComponent(qrData)}`
    ]
    for (const qrUrl of qrSources) {
      try {
        const qrResp = await fetch(qrUrl)
        const qrContentType = qrResp.headers.get('Content-Type') || ''
        if (qrResp.ok && qrContentType.includes('image')) {
          const buf = await qrResp.arrayBuffer()
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)))
          return json({ base64: 'data:image/png;base64,' + base64, scene, page, fallback: true })
        }
      } catch (fe) {
        console.error('fallback QR source error', fe.message || fe)
      }
    }

    return json({}, 500, '生成二维码失败', 500)
  } catch (e) {
    console.error('wxacode fatal', e.message || e)
    return json({}, e.code || 500, e.msg || e.message || '生成二维码失败', e.code ? 401 : 500)
  }
})

// ============================================================
// 11. 订阅消息
// ============================================================

// 订阅消息模板（占位 ID，用户申请后替换）
// 从 KV 或环境变量读取，支持动态更新
async function getTemplateIds(env) {
  // 优先从 KV 读取（方便随时更新不用重新部署）
  try {
    const cached = await env.KV.get('subscribe_template_ids')
    if (cached) {
      const parsed = JSON.parse(cached)
      // 兼容只配了一个模板 ID 的情况：三个类型共用同一个
      const single = parsed.single || parsed.alert || parsed.report || parsed.greeting || ''
      return {
        alert: parsed.alert || single,
        report: parsed.report || single,
        greeting: parsed.greeting || single
      }
    }
  } catch (_) {}
  // 回退到环境变量
  const single = env.SUBSCRIBE_TPL_SINGLE || env.SUBSCRIBE_TPL_ALERT || ''
  return {
    alert: env.SUBSCRIBE_TPL_ALERT || single,       // 气象预警
    report: env.SUBSCRIBE_TPL_REPORT || single,     // 气候报告
    greeting: env.SUBSCRIBE_TPL_GREETING || single  // TA的问候
  }
}

// 获取微信 access_token（带缓存）
async function getWxAccessToken(env) {
  try {
    // 从 KV 缓存读取（有效期 7200 秒，存 7000 秒）
    const cached = await env.KV.get('wx_access_token')
    if (cached) {
      const parts = cached.split('|')
      if (parts.length === 2 && Date.now() < Number(parts[1])) {
        return parts[0]
      }
    }
  } catch (_) {}

  const resp = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${env.WECHAT_APPID}&secret=${env.WECHAT_SECRET}`
  )
  const data = await resp.json()
  if (!data.access_token) {
    console.error('getAccessToken fail', JSON.stringify(data))
    return null
  }
  // 缓存到 KV，7000 秒过期
  const expireAt = Date.now() + 7000 * 1000
  try {
    await env.KV.put('wx_access_token', data.access_token + '|' + expireAt, { expirationTtl: 7000 })
  } catch (_) {}
  return data.access_token
}

// 发送订阅消息
async function sendSubscribeMessage(env, openid, templateId, page, data) {
  try {
    const token = await getWxAccessToken(env)
    if (!token) return { ok: false, err: 'no access_token' }

    const body = {
      touser: openid,
      template_id: templateId,
      page: page || 'pages/index/index',
      data: data || {},
      miniprogram_state: 'formal',  // formal/developer/trial
      lang: 'zh_CN'
    }

    const resp = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
    const result = await resp.json()
    if (result.errcode !== 0) {
      console.error('sendSubscribe fail', JSON.stringify(result))
      return { ok: false, err: result.errmsg || ('errcode=' + result.errcode) }
    }
    return { ok: true }
  } catch (e) {
    console.error('sendSubscribe exception', e.message || e)
    return { ok: false, err: e.message }
  }
}

// 保存订阅授权
router.add('POST', '/api/subscribe/save', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const body = await ctx.request.json()
    const { alert, report, greeting } = body

    // 建表（兼容旧库）
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS subscribe_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, type)
      )
    `).run()

    const now = nowISO()
    const types = []
    if (alert) types.push('alert')
    if (report) types.push('report')
    if (greeting) types.push('greeting')

    for (const t of types) {
      // 每次授权增加一次可发送次数
      await env.DB.prepare(`
        INSERT INTO subscribe_records (id, user_id, type, count, created_at)
        VALUES (?, ?, ?, 1, ?)
        ON CONFLICT(user_id, type) DO UPDATE SET count = count + 1, created_at = ?
      `).bind(uuid(), user.id, t, now, now).run()
    }

    return json({ ok: true, subscribed: types })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 获取订阅状态
router.add('GET', '/api/subscribe/status', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS subscribe_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(user_id, type)
      )
    `).run()

    const rows = rowsOf(await env.DB.prepare(
      'SELECT type, count FROM subscribe_records WHERE user_id = ?'
    ).bind(user.id).all())

    const status = { alert: 0, report: 0, greeting: 0 }
    for (const r of rows) {
      if (status[r.type] !== undefined) status[r.type] = Number(r.count) || 0
    }
    const tplIds = await getTemplateIds(env)
    return json({ status, tplIds })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 更新模板 ID（管理员接口，方便用户申请后直接配置）
router.add('POST', '/api/admin/templates', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const body = await ctx.request.json()
    const tplIds = {
      alert: body.alert || '',
      report: body.report || '',
      greeting: body.greeting || ''
    }
    await env.KV.put('subscribe_template_ids', JSON.stringify(tplIds))
    return json({ ok: true, tplIds })
  } catch (e) {
    return json({}, 500, e.message || '失败', 500)
  }
})

// 获取模板 ID（公开接口，前端需要传给 requestSubscribeMessage）
router.add('GET', '/api/subscribe/templates', async (env, ctx) => {
  try {
    const tplIds = await getTemplateIds(env)
    return json(tplIds)
  } catch (e) {
    return json({}, 500, e.message || '失败', 500)
  }
})

// 管理员手动触发发送订阅消息（测试用）
router.add('POST', '/api/admin/subscribe/send', async (env, ctx) => {
  if (!requireAdmin(ctx.request, env)) return json({}, 401, '未授权', 401)
  try {
    const body = await ctx.request.json()
    const { type, openid, page, data } = body
    const tplIds = await getTemplateIds(env)
    const tplId = tplIds[type]
    if (!tplId) return json({}, 400, '模板ID未配置：' + type, 400)
    const result = await sendSubscribeMessage(env, openid, tplId, page, data)
    return json(result)
  } catch (e) {
    return json({}, 500, e.message || '失败', 500)
  }
})

// 用户手动测试推送（需要已订阅且 count > 0）
router.add('POST', '/api/subscribe/test', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const tplIds = await getTemplateIds(env)
    if (!tplIds.alert && !tplIds.report && !tplIds.greeting) {
      return json({}, 400, '模板ID未配置', 400)
    }

    // 查订阅记录，优先用 greeting，其次是 alert/report
    const rows = rowsOf(await env.DB.prepare(
      'SELECT type, count FROM subscribe_records WHERE user_id = ? AND count > 0'
    ).bind(user.id).all())
    if (!rows.length) return json({}, 400, '没有可用的订阅次数，请先授权订阅', 400)

    const type = rows.find(r => r.type === 'greeting')
      ? 'greeting'
      : rows.find(r => r.type === 'alert')
        ? 'alert'
        : rows.find(r => r.type === 'report').type

    const tplId = tplIds[type]
    if (!tplId) return json({}, 400, '模板ID未配置：' + type, 400)

    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
    let data = {}
    if (type === 'greeting') {
      data = {
        name1: { value: 'TA的问候测试' },
        thing2: { value: '这是来自另一半的测试问候' },
        date3: { value: dateStr },
        thing5: { value: '点击查看详情' }
      }
    } else if (type === 'alert') {
      data = {
        name1: { value: '心情气象预警测试' },
        thing2: { value: '重要纪念日提醒' },
        date3: { value: '测试时间' },
        thing5: { value: '点击查看详情' }
      }
    } else {
      data = {
        name1: { value: '气候报告测试' },
        thing2: { value: '测试报告' },
        date3: { value: dateStr },
        thing5: { value: '点击查看详情' }
      }
    }

    const result = await sendSubscribeMessage(env, user.openid, tplId, 'pages/index/index', data)
    if (result.ok) {
      await env.DB.prepare('UPDATE subscribe_records SET count = count - 1 WHERE user_id = ? AND type = ?').bind(user.id, type).run()
      return json({ ok: true, type, msg: '测试消息已发送，请留意微信服务通知' })
    }
    return json({}, 500, result.err || '发送失败', 500)
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 定时发送订阅消息（每天 cron 调用）
async function sendDailySubscribeMessages(env, couples) {
  const tplIds = await getTemplateIds(env)
  if (!tplIds.alert && !tplIds.report && !tplIds.greeting) return

  // 查询所有有订阅次数的用户
  const subs = rowsOf(await env.DB.prepare(
    "SELECT sr.user_id, sr.type, sr.count, u.openid, u.nickname FROM subscribe_records sr JOIN users u ON sr.user_id = u.id WHERE sr.count > 0"
  ).all())
  if (!subs.length) return

  const todayStr = today()
  const yesterdayStr = fmtDate(new Date(Date.now() - 24*3600*1000).toISOString())

  for (const sub of subs) {
    // 查询用户所在情侣
    const userCouple = await env.DB.prepare(
      "SELECT * FROM couples WHERE status = 'bound' AND (user_a_id = ? OR user_b_id = ?) LIMIT 1"
    ).bind(sub.user_id, sub.user_id).first()
    if (!userCouple) continue

    const taId = userCouple.user_a_id === sub.user_id ? userCouple.user_b_id : userCouple.user_a_id

    // === 气象预警 ===
    if (sub.type === 'alert' && tplIds.alert) {
      const activeAlert = await env.DB.prepare(
        "SELECT * FROM alerts WHERE couple_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
      ).bind(userCouple.id).first()
      if (activeAlert) {
        const days = Number(activeAlert.days_left != null ? activeAlert.days_left : activeAlert.days) || 0
        const data = {
          name1: { value: '心情气象预警' },
          thing2: { value: String((activeAlert.title || '情绪预警')).slice(0, 20) },
          date3: { value: days <= 0 ? '就是今天' : ('还有 ' + days + ' 天') },
          thing5: { value: '点击查看详情' }
        }
        const result = await sendSubscribeMessage(env, sub.openid, tplIds.alert, 'pages/index/index', data)
        if (result.ok) {
          await env.DB.prepare('UPDATE subscribe_records SET count = count - 1 WHERE user_id = ? AND type = ?').bind(sub.user_id, 'alert').run()
        }
      }
    }

    // === 气候报告（每月 1 号发送） ===
    if (sub.type === 'report' && tplIds.report) {
      const todayDate = new Date()
      if (todayDate.getDate() === 1) {
        const lastMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1)
        const y = lastMonth.getFullYear(), m = lastMonth.getMonth() + 1
        const report = await env.DB.prepare(
          "SELECT * FROM climate_reports WHERE couple_id = ? AND period_type = 'month' AND period_start = ? LIMIT 1"
        ).bind(userCouple.id, `${y}-${String(m).padStart(2,'0')}-01`).first()
        if (report) {
          const data = {
            name1: { value: '月度气候报告' },
            thing2: { value: `${y}年${m}月` },
            date3: { value: String(report.note || '点击查看完整报告').slice(0, 20) },
            thing5: { value: '已生成，点击查看' }
          }
          const result = await sendSubscribeMessage(env, sub.openid, tplIds.report, 'pages/report/report', data)
          if (result.ok) {
            await env.DB.prepare('UPDATE subscribe_records SET count = count - 1 WHERE user_id = ? AND type = ?').bind(sub.user_id, 'report').run()
          }
        }
      }
    }

    // === TA 的问候（对方昨天有记录心情时发送） ===
    if (sub.type === 'greeting' && tplIds.greeting && taId) {
      const taMood = await env.DB.prepare(
        'SELECT weather, note FROM mood_records WHERE user_id = ? AND record_date = ? LIMIT 1'
      ).bind(taId, yesterdayStr).first()
      if (taMood) {
        const taUser = await env.DB.prepare('SELECT nickname FROM users WHERE id = ?').bind(taId).first()
        const taName = (taUser && taUser.nickname) || 'TA'
        const moodText = taMood.weather || '心情记录'
        const data = {
          name1: { value: String(taName + '的心情').slice(0, 20) },
          thing2: { value: String(moodText).slice(0, 20) },
          date3: { value: yesterdayStr },
          thing5: { value: String(taMood.note || '点击查看更多').slice(0, 20) }
        }
        const result = await sendSubscribeMessage(env, sub.openid, tplIds.greeting, 'pages/index/index', data)
        if (result.ok) {
          await env.DB.prepare('UPDATE subscribe_records SET count = count - 1 WHERE user_id = ? AND type = ?').bind(sub.user_id, 'greeting').run()
        }
      }
    }
  }
}

// ============================================================
// 10. AI 情侣默契问答 / 默契挑战
// ============================================================

// 每日题目池（兜底，AI 失败时使用）
const DEFAULT_QUIZ_QUESTIONS = [
  { question: '约会时更喜欢?', options: ['宅家追剧', '出门探店'], type: 'choice' },
  { question: '吵架后希望对方先?', options: ['冷静一下', '主动哄哄'], type: 'choice' },
  { question: '理想的周末早晨是?', options: ['睡到自然醒', '一起晨跑'], type: 'choice' },
  { question: '收到礼物更看重?', options: ['实用性', '仪式感'], type: 'choice' },
  { question: '表达爱意的方式?', options: ['经常说', '行动上'], type: 'choice' }
]

// 创建 quiz 相关表
async function ensureQuizTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS quiz_questions (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options TEXT,
      type TEXT NOT NULL DEFAULT 'choice',
      quiz_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(couple_id, quiz_date)
    )
  `).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS quiz_answers (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(couple_id, question_id, user_id)
    )
  `).run()
}

// 生成今日题目（AI 出题，失败用兜底）
async function generateQuizQuestions(env, coupleId) {
  const today_ = today()
  const prompt = `请为一对情侣生成 3 道默契问答题目，用于测试双方了解和默契程度。
要求：
1. 每道题是二选一选择题
2. 题目要轻松有趣，贴近恋爱日常（约会、相处方式、生活习惯、价值观等）
3. 选项要简洁，不超过 8 个字
4. 返回严格 JSON 数组格式：[{"question":"题目","options":["选项A","选项B"]}]
5. 不要任何解释文字，只返回 JSON`

  let questions = []
  const aiRes = await callQianwenAPI(env, prompt, { maxTokens: 400, temperature: 0.9 })
  if (aiRes.ok && aiRes.text) {
    try {
      const match = aiRes.text.match(/\[[\s\S]*\]/)
      if (match) {
        const parsed = JSON.parse(match[0])
        if (Array.isArray(parsed) && parsed.length > 0) {
          questions = parsed.slice(0, 3).map(q => ({
            question: String(q.question || '').slice(0, 80),
            options: appToArr(q.options).map(o => String(o).slice(0, 20)).slice(0, 2),
            type: 'choice'
          })).filter(q => q.question && q.options.length === 2)
        }
      }
    } catch (e) { console.error('parse quiz json err', e.message) }
  }

  if (questions.length < 3) {
    questions = JSON.parse(JSON.stringify(DEFAULT_QUIZ_QUESTIONS)).slice(0, 3)
  }

  await ensureQuizTables(env)
  const now = nowISO()
  const saved = []
  for (const q of questions) {
    const id = uuid()
    await env.DB.prepare(`
      INSERT INTO quiz_questions (id, couple_id, question, options, type, quiz_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(couple_id, quiz_date) DO UPDATE SET
        question = excluded.question, options = excluded.options, type = excluded.type, created_at = excluded.created_at
    `).bind(id, coupleId, q.question, JSON.stringify(q.options), q.type, today_, now).run()
    saved.push({ id, question: q.question, options: q.options, type: q.type })
  }
  return saved
}

function appToArr(x) {
  if (!x) return []
  if (Array.isArray(x)) return x
  try {
    const p = JSON.parse(x)
    if (Array.isArray(p)) return p
  } catch (_) {}
  return []
}

// 获取今日题目
router.add('GET', '/api/quiz/today', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    await ensureQuizTables(env)
    const today_ = today()
    const rows = rowsOf(await env.DB.prepare(
      'SELECT id, question, options, type FROM quiz_questions WHERE couple_id = ? AND quiz_date = ? ORDER BY created_at'
    ).bind(couple.id, today_).all())

    let questions = rows.map(r => ({ ...r, options: appToArr(r.options) }))
    if (questions.length < 3) {
      questions = await generateQuizQuestions(env, couple.id)
    }

    // 查询双方是否已答
    const answers = rowsOf(await env.DB.prepare(
      'SELECT question_id, user_id, answer FROM quiz_answers WHERE couple_id = ? AND question_id IN (' + questions.map(() => '?').join(',') + ')'
    ).bind(couple.id, ...questions.map(q => q.id)).all())

    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const myAnswered = new Set(answers.filter(a => a.user_id === user.id).map(a => a.question_id))
    const taAnswered = new Set(answers.filter(a => a.user_id === taId).map(a => a.question_id))

    return json({
      questions: questions.map(q => ({
        id: q.id,
        question: q.question,
        options: q.options,
        type: q.type,
        my_answered: myAnswered.has(q.id),
        ta_answered: taAnswered.has(q.id)
      })),
      my_finished: myAnswered.size === questions.length,
      ta_finished: taAnswered.size === questions.length
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 提交答案
router.add('POST', '/api/quiz/answer', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { question_id, answer } = await ctx.request.json()
    if (!question_id || answer === undefined) return json({}, 400, '缺少参数', 400)
    await ensureQuizTables(env)
    const now = nowISO()
    await env.DB.prepare(`
      INSERT INTO quiz_answers (id, couple_id, question_id, user_id, answer, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(couple_id, question_id, user_id) DO UPDATE SET
        answer = excluded.answer, created_at = excluded.created_at
    `).bind(uuid(), couple.id, question_id, user.id, String(answer).slice(0, 50), now).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 查看今日结果 + AI 点评
router.add('GET', '/api/quiz/result', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    await ensureQuizTables(env)
    const today_ = today()
    const questions = rowsOf(await env.DB.prepare(
      'SELECT id, question, options, type FROM quiz_questions WHERE couple_id = ? AND quiz_date = ? ORDER BY created_at'
    ).bind(couple.id, today_).all())
    if (!questions.length) return json({}, 404, '今日还没有题目', 404)

    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const answers = rowsOf(await env.DB.prepare(
      'SELECT question_id, user_id, answer FROM quiz_answers WHERE couple_id = ? AND question_id IN (' + questions.map(() => '?').join(',') + ')'
    ).bind(couple.id, ...questions.map(q => q.id)).all())

    function normalizeAnswer(s) {
      return String(s || '').toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
    }

    const result = questions.map(q => {
      const opts = appToArr(q.options)
      const my = answers.find(a => a.question_id === q.id && a.user_id === user.id)
      const ta = answers.find(a => a.question_id === q.id && a.user_id === taId)
      const myAns = my ? my.answer : null
      const taAns = ta ? ta.answer : null
      const match = !!(myAns && taAns && normalizeAnswer(myAns) === normalizeAnswer(taAns))
      return {
        id: q.id,
        question: q.question,
        options: opts,
        my_answer: myAns,
        ta_answer: taAns,
        match
      }
    })

    const finished = result.every(r => r.my_answer !== null && r.ta_answer !== null)
    if (!finished) {
      return json({ finished: false, result, tip: '等双方都答完才能看默契度哦' })
    }

    const matchCount = result.filter(r => r.match).length
    const total = result.length || 1
    const score = Math.round((matchCount / total) * 100)

    // AI 点评
    let comment = ''
    const prompt = `一对情侣完成了 3 道默契问答，结果如下：
${result.map((r, i) => `${i+1}. ${r.question}\n我选了：${r.my_answer}\nTA选了：${r.ta_answer}${r.match ? '（一致）' : '（不一致）'}`).join('\n')}
默契度：${score}%。

请写一段 60-80 字的温暖点评，要求：
1. 语气像懂他们的朋友，轻松幽默
2. 如果默契度高就夸一夸，如果不高就鼓励一下
3. 给一个小建议增进默契
不要分点，直接成段。不要用 emoji。`
    const aiRes = await callQianwenAPI(env, prompt, { maxTokens: 300 })
    comment = aiRes.text || '你们完成了一次默契挑战，无论分数多少，愿意了解彼此就是最好的开始。'

    return json({ finished: true, score, result, comment })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 历史记录
router.add('GET', '/api/quiz/history', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json([], 0, 'ok')
    await ensureQuizTables(env)
    const rows = rowsOf(await env.DB.prepare(`
      SELECT q.quiz_date, q.question, q.options, a1.answer as my_answer, a2.answer as ta_answer
      FROM quiz_questions q
      LEFT JOIN quiz_answers a1 ON a1.question_id = q.id AND a1.user_id = ?
      LEFT JOIN quiz_answers a2 ON a2.question_id = q.id AND a2.user_id = ?
      WHERE q.couple_id = ?
      ORDER BY q.quiz_date DESC, q.created_at ASC
      LIMIT 30
    `).bind(user.id, couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id, couple.id).all())
    return json(rows.map(r => ({ ...r, options: appToArr(r.options) })))
  } catch (e) {
    return json([], e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ============================================================
// 11. 恋爱账单 / 共同心愿基金
// ============================================================

async function ensureBillTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS couple_bills (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      category TEXT NOT NULL,
      note TEXT,
      bill_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS couple_funds (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      saved_amount REAL NOT NULL DEFAULT 0,
      deadline TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
}

const BILL_CATEGORIES = [
  { key: 'food', name: '吃饭', emoji: '🍔' },
  { key: 'travel', name: '旅行', emoji: '✈️' },
  { key: 'gift', name: '礼物', emoji: '🎁' },
  { key: 'entertainment', name: '娱乐', emoji: '🎬' },
  { key: 'living', name: '生活', emoji: '🏠' },
  { key: 'other', name: '其他', emoji: '📝' }
]

// 记账
router.add('POST', '/api/bills/add', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { amount, category, note, bill_date } = await ctx.request.json()
    if (!amount || Number(amount) <= 0) return json({}, 400, '请输入金额', 400)
    await ensureBillTables(env)
    const now = nowISO()
    await env.DB.prepare(`
      INSERT INTO couple_bills (id, couple_id, user_id, amount, category, note, bill_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(uuid(), couple.id, user.id, Number(amount), category || 'other', note || '', bill_date || today(), now).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 删除账单
router.add('POST', '/api/bills/delete', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({}, 400, '未绑定', 400)
    const { id } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    await env.DB.prepare('DELETE FROM couple_bills WHERE id = ? AND couple_id = ?').bind(id, couple.id).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 账单列表 + 统计
router.add('GET', '/api/bills/list', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({ list: [], stats: {} })
    await ensureBillTables(env)
    const { month } = new URL(ctx.request.url).searchParams
    const month_ = month || today().slice(0, 7)
    const list = rowsOf(await env.DB.prepare(`
      SELECT b.*, u.nickname as user_name FROM couple_bills b
      JOIN users u ON b.user_id = u.id
      WHERE b.couple_id = ? AND b.bill_date LIKE ?
      ORDER BY b.bill_date DESC, b.created_at DESC
      LIMIT 100
    `).bind(couple.id, month_ + '%').all())
    const total = list.reduce((s, r) => s + Number(r.amount || 0), 0)
    const byCategory = {}
    for (const r of list) {
      byCategory[r.category || 'other'] = (byCategory[r.category || 'other'] || 0) + Number(r.amount || 0)
    }
    return json({ list, stats: { total, by_category: byCategory, count: list.length } })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 设置/更新基金目标
router.add('POST', '/api/funds/set', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { name, target_amount, saved_amount, deadline } = await ctx.request.json()
    if (!name || !target_amount || Number(target_amount) <= 0) return json({}, 400, '请填写目标名称和金额', 400)
    await ensureBillTables(env)
    const now = nowISO()
    await env.DB.prepare(`
      INSERT INTO couple_funds (id, couple_id, name, target_amount, saved_amount, deadline, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(couple_id) DO UPDATE SET
        name = excluded.name, target_amount = excluded.target_amount, saved_amount = excluded.saved_amount,
        deadline = excluded.deadline, updated_at = excluded.updated_at
    `).bind(uuid(), couple.id, name.slice(0, 30), Number(target_amount), Math.max(0, Number(saved_amount || 0)), deadline || null, now, now).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 获取基金
router.add('GET', '/api/funds/get', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json(null)
    await ensureBillTables(env)
    const fund = await env.DB.prepare('SELECT * FROM couple_funds WHERE couple_id = ?').bind(couple.id).first()
    return json(fund || null)
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// AI 消费建议
router.add('GET', '/api/bills/advice', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({ advice: '绑定情侣后，AI 会为你们分析消费情况 ✨' })
    await ensureBillTables(env)
    const month_ = today().slice(0, 7)
    const list = rowsOf(await env.DB.prepare(`
      SELECT amount, category, note, bill_date FROM couple_bills
      WHERE couple_id = ? AND bill_date LIKE ?
      ORDER BY bill_date DESC
      LIMIT 50
    `).bind(couple.id, month_ + '%').all())
    const fund = await env.DB.prepare('SELECT name, target_amount, saved_amount FROM couple_funds WHERE couple_id = ?').bind(couple.id).first()

    if (!list.length && !fund) {
      return json({ advice: '本月还没有记账，记几笔让 AI 帮你们分析消费习惯吧 📒' })
    }

    const total = list.reduce((s, r) => s + Number(r.amount || 0), 0)
    const catMap = {}
    for (const r of list) catMap[r.category || 'other'] = (catMap[r.category || 'other'] || 0) + Number(r.amount || 0)
    const catText = Object.entries(catMap).map(([k, v]) => `${BILL_CATEGORIES.find(c => c.key === k)?.name || k}:${v.toFixed(1)}元`).join('，')
    const fundText = fund ? `；共同目标「${fund.name}」目标${fund.target_amount}元，已存${fund.saved_amount}元` : ''

    const prompt = `请根据以下情侣本月消费数据，写一段 80-120 字的「消费建议」：
本月总支出：${total.toFixed(1)}元
分类支出：${catText}${fundText}

要求：
1. 像一位贴心的理财朋友，语气轻松温暖
2. 指出支出结构中的一个小发现
3. 给一条具体可执行的建议（如「下周减少外卖，一起做饭一次」）
4. 如果有共同目标，结合目标给存钱鼓励
不要分点，直接成段。不要用 emoji。语气自然。`
    const aiRes = await callQianwenAPI(env, prompt, { maxTokens: 400 })
    return json({ advice: aiRes.text || '你们开始共同记账了，这本身就是一种默契。坚持记录，AI 会帮你们发现更多小规律。' })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ============================================================
// 12. 心动会员 / 虚拟支付（个人主体 · 道具直购）
// ============================================================
// 官方文档：https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/person.html
// 开通条件：个人主体 + 服务类目含「工具」+ 已认证备案（月限额 10 万元，Android 1% / iOS 12%）
// 开通后在 MP后台【虚拟支付-基本配置】拿 OfferID / AppKey，在【道具管理】创建道具并发布。
//
// 支付模式（由环境变量自动判断）：
//   · 配置了 XPAY_OFFER_ID + XPAY_APP_KEY → wechat：真实 wx.requestVirtualPayment（道具直购）
//   · 未配置 → sandbox：沙盒模拟支付（不产生真实扣款，便于未开通前调试）
//
// 真实模式签名（官方 5.5 节）：
//   paySig    = hex(hmac_sha256(AppKey,    'requestVirtualPayment' + '&' + signData))
//   signature = hex(hmac_sha256(sessionKey, signData))   ← 用户态签名，sessionKey 来自 code2Session
// 发货以「发货推送」(xpay_goods_deliver_notify) 为主、query_order 查单兜底（见 /wechat/notify 与 /api/pay/query）

const VIP_TIERS = [
  { tier: 'monthly',   name: '月卡', emoji: '🌙', price: 6,  days: 30,  tagline: '尝鲜一个月' },
  { tier: 'quarterly', name: '季卡', emoji: '🌸', price: 16, days: 90,  tagline: '甜蜜一整季' },
  { tier: 'yearly',    name: '年卡', emoji: '💎', price: 48, days: 365, tagline: '陪伴一整年' }
]

// 简易 XML 取值（发货推送用；tag 均为代码内写死的常量，无注入风险）
function xmlTag(xml, tag) {
  const m = String(xml || '').match(new RegExp('<' + tag + '>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</' + tag + '>'))
  return m ? (m[1] !== undefined ? m[1] : m[2]) : ''
}

async function hmacSHA256Hex(keyStr, msgStr) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msgStr))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function ensureVipTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS vip_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      title TEXT NOT NULL,
      price REAL NOT NULL,
      goods_price INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      mode TEXT NOT NULL DEFAULT 'sandbox',
      out_trade_no TEXT UNIQUE,
      product_id TEXT NOT NULL DEFAULT '',
      wx_order_no TEXT,
      attach TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      paid_at TEXT
    )
  `).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS vip_memberships (
      user_id TEXT PRIMARY KEY,
      level INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
  // 虚拟支付用户态签名需要 sessionKey（code2Session 返回），登录时已存入 users.session_key
  try { await env.DB.prepare('ALTER TABLE users ADD COLUMN session_key TEXT').run() } catch (_) {}
}

function xpayMode(env) {
  return (env.XPAY_OFFER_ID && env.XPAY_APP_KEY) ? 'wechat' : 'sandbox'
}

// 读取 MP后台「道具管理」里创建的道具配置：{ monthly: { productId, price(分) }, ... }
function getXpayGoods(env) {
  try {
    const raw = env.XPAY_GOODS_JSON || ''
    return raw ? (JSON.parse(raw) || {}) : {}
  } catch (_) { return {} }
}

function getVipTiers(env) {
  const mode = xpayMode(env)
  const goods = getXpayGoods(env)
  return VIP_TIERS.map((t) => {
    const g = goods[t.tier]
    const configured = !!(g && g.productId)
    // wechat 模式下价格以 MP后台道具价格为准（goodsPrice 必须与后台一致，否则报 -15013）
    const price = (mode === 'wechat' && configured && Number(g.price)) ? Number(g.price) / 100 : t.price
    return { ...t, price, available: mode === 'sandbox' ? true : configured }
  })
}

async function getVipStatus(user, env) {
  const m = await env.DB.prepare('SELECT * FROM vip_memberships WHERE user_id = ?').bind(user.id).first()
  if (!m) return { is_vip: false, level: 0, expires_at: '', days_left: 0 }
  const exp = new Date(m.expires_at)
  const now = new Date()
  const isVip = exp.getTime() > now.getTime()
  const daysLeft = Math.ceil((exp.getTime() - now.getTime()) / (24 * 3600 * 1000))
  return {
    is_vip: isVip,
    level: isVip ? m.level : 0,
    expires_at: isVip ? m.expires_at : '',
    days_left: isVip ? Math.max(0, daysLeft) : 0
  }
}

// 发货：开通 / 顺延会员（幂等由调用方保证：只在订单 status=created 时调用）
async function grantVip(userId, tier, env) {
  const t = VIP_TIERS.find((x) => x.tier === tier)
  if (!t) return null
  const now = new Date()
  const m = await env.DB.prepare('SELECT * FROM vip_memberships WHERE user_id = ?').bind(userId).first()
  // 会员未过期则顺延，已过期则从今天起算
  const base = (m && new Date(m.expires_at).getTime() > now.getTime()) ? new Date(m.expires_at) : new Date(now)
  base.setDate(base.getDate() + t.days)
  const expiresAt = base.toISOString()
  if (m) {
    await env.DB.prepare('UPDATE vip_memberships SET expires_at = ?, level = 1, updated_at = ? WHERE user_id = ?')
      .bind(expiresAt, nowISO(), userId).run()
  } else {
    await env.DB.prepare('INSERT INTO vip_memberships (user_id, level, expires_at, updated_at) VALUES (?, 1, ?, ?)')
      .bind(userId, expiresAt, nowISO()).run()
  }
  const u = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first()
  return u ? await getVipStatus(u, env) : null
}

// 会员状态 + 套餐列表
router.add('GET', '/api/vip/info', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    await ensureVipTables(env)
    const status = await getVipStatus(user, env)
    return json({ ...status, tiers: getVipTiers(env), mode: xpayMode(env) })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 创建订单
// sandbox：返回 out_trade_no，前端模拟支付后调 /api/pay/confirm
// wechat：服务端组装 signData + 双签名，前端直接 wx.requestVirtualPayment({...pay_data})
router.add('POST', '/api/pay/create', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    await ensureVipTables(env)
    const body = await ctx.request.json().catch(() => ({}))
    const tier = body.tier
    const t = getVipTiers(env).find((x) => x.tier === tier)
    if (!t) return json({}, 400, '未知的会员套餐', 400)
    const mode = xpayMode(env)
    if (mode === 'wechat' && !t.available) return json({}, 400, '该套餐道具尚未配置（XPAY_GOODS_JSON）', 400)

    const outTradeNo = 'VIP' + Date.now() + Math.floor(Math.random() * 9000 + 1000)
    const attach = JSON.stringify({ uid: user.id, tier })
    const orderId = uuid()
    const goods = getXpayGoods(env)[tier] || {}
    const goodsPrice = mode === 'wechat' ? Math.round(Number(t.price) * 100) : 0

    let payData = null
    let sessionKey = ''
    if (mode === 'wechat') {
      // 用户态签名需要最新 sessionKey：优先用前端带来的新 code 重新 code2Session 刷新
      if (body.code && env.WECHAT_SECRET) {
        try {
          const resp = await fetch(
            `https://api.weixin.qq.com/sns/jscode2session?appid=${env.WECHAT_APPID}&secret=${env.WECHAT_SECRET}&js_code=${encodeURIComponent(body.code)}&grant_type=authorization_code`
          )
          const wx = await resp.json()
          if (wx && wx.openid && wx.session_key && wx.openid === user.openid) {
            sessionKey = wx.session_key
            await env.DB.prepare('UPDATE users SET session_key = ? WHERE id = ?').bind(sessionKey, user.id).run()
          }
        } catch (_) {}
      }
      if (!sessionKey) {
        sessionKey = user.session_key || ''
      }
      if (!sessionKey) return json({}, 400, '登录态已过期，请退出后重新登录小程序再购买', 400)

      // 官方 5.3/5.5：signData 为 JSON 字符串；paySig 用 AppKey、signature 用 sessionKey，均为 HMAC-SHA256 hex
      const signDataStr = JSON.stringify({
        offerId: String(env.XPAY_OFFER_ID),
        buyQuantity: 1,
        env: 0,
        currencyType: 'CNY',
        productId: String(goods.productId || ''),
        goodsPrice: goodsPrice,
        outTradeNo: outTradeNo,
        attach: attach
      })
      payData = {
        signData: signDataStr,
        mode: 'short_series_goods',
        paySig: await hmacSHA256Hex(String(env.XPAY_APP_KEY), 'requestVirtualPayment&' + signDataStr),
        signature: await hmacSHA256Hex(sessionKey, signDataStr)
      }
    }

    await env.DB.prepare(`
      INSERT INTO vip_orders (id, user_id, tier, title, price, goods_price, status, mode, out_trade_no, product_id, attach, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)
    `).bind(orderId, user.id, t.tier, t.name + '·心动会员', Number(t.price), goodsPrice, mode, outTradeNo, String(goods.productId || ''), attach, nowISO()).run()

    return json({
      order_id: orderId,
      out_trade_no: outTradeNo,
      tier: t.tier,
      title: t.name + '·心动会员',
      price: Number(t.price),
      mode,
      pay_data: payData
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 沙盒模拟支付确认（仅 sandbox 订单可用；wechat 订单以发货推送 / query_order 为准）
router.add('POST', '/api/pay/confirm', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { out_trade_no } = await ctx.request.json()
    if (!out_trade_no) return json({}, 400, '缺少 out_trade_no', 400)
    await ensureVipTables(env)
    const order = await env.DB.prepare('SELECT * FROM vip_orders WHERE out_trade_no = ? AND user_id = ?')
      .bind(out_trade_no, user.id).first()
    if (!order) return json({}, 400, '订单不存在', 400)
    if (order.status !== 'created') {
      const status = await getVipStatus(user, env)
      return json({ ...status, already_paid: true })
    }
    if (order.mode !== 'sandbox') return json({}, 400, '真实支付订单以微信发货推送/查单结果为准', 400)
    await grantVip(user.id, order.tier, env)
    await env.DB.prepare("UPDATE vip_orders SET status = 'sandbox_paid', paid_at = ? WHERE id = ?")
      .bind(nowISO(), order.id).run()
    const status = await getVipStatus(user, env)
    return json({ ...status, already_paid: false })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 兜底查单：前端支付 success 回调 / 轮询时调用，服务端向微信 query_order 查证后发货
router.add('POST', '/api/pay/query', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const { out_trade_no } = await ctx.request.json()
    if (!out_trade_no) return json({}, 400, '缺少 out_trade_no', 400)
    await ensureVipTables(env)
    const order = await env.DB.prepare('SELECT * FROM vip_orders WHERE out_trade_no = ? AND user_id = ?')
      .bind(out_trade_no, user.id).first()
    if (!order) return json({}, 400, '订单不存在', 400)

    if (order.status === 'paid' || order.status === 'sandbox_paid') {
      const status = await getVipStatus(user, env)
      return json({ paid: true, ...status })
    }
    if (order.mode !== 'wechat') return json({ paid: false })
    if (!env.WECHAT_SECRET) return json({}, 400, '服务端未配置 WECHAT_SECRET，无法查单', 400)

    // 官方 5.4.2：POST /xpay/query_order?access_token=xxx&pay_sig=xxx
    // pay_sig = hmac_sha256(AppKey, '/xpay/query_order' + '&' + 原始请求体字符串)
    const bodyStr = JSON.stringify({ openid: user.openid, env: 0, order_id: out_trade_no })
    const paySig = await hmacSHA256Hex(String(env.XPAY_APP_KEY), '/xpay/query_order&' + bodyStr)
    const token = await getAccessToken(env)
    const resp = await fetch('https://api.weixin.qq.com/xpay/query_order?access_token=' + token + '&pay_sig=' + paySig, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr
    })
    const r = await resp.json().catch(() => ({}))
    const st = r && r.order ? Number(r.order.status) : -1
    // 2=已支付待发货 3=发货中 4=已发货 → 视为支付成功，发货（幂等）
    if (r && Number(r.errcode) === 0 && st >= 2 && st <= 4) {
      await grantVip(user.id, order.tier, env)
      await env.DB.prepare("UPDATE vip_orders SET status = 'paid', paid_at = ?, wx_order_no = ? WHERE id = ?")
        .bind(nowISO(), (r.order && r.order.wx_order_id) || '', order.id).run()
      const status = await getVipStatus(user, env)
      return json({ paid: true, ...status })
    }
    return json({ paid: false, order_status: st, errcode: r ? r.errcode : -1, errmsg: r ? r.errmsg : '查单失败' })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 购买记录
router.add('GET', '/api/vip/orders', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    await ensureVipTables(env)
    const list = rowsOf(await env.DB.prepare(`
      SELECT id, tier, title, price, status, mode, out_trade_no, created_at, paid_at
      FROM vip_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20
    `).bind(user.id).all())
    return json({ list })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ---------- 微信消息推送（发货推送接收，配置在 MP后台【开发管理-消息推送】）----------
// URL 填 https://api.jdhsf.top/wechat/notify，模式选「明文」，Token 填 wrangler.toml 的 MP_PUSH_TOKEN
const xmlAck = (code = 0, msg = 'success') =>
  new Response('<xml><ErrCode>' + code + '</ErrCode><ErrMsg><![CDATA[' + msg + ']]></ErrMsg></xml>', {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  })

// GET：消息推送 URL 有效性验证（返回 echostr）
router.add('GET', '/wechat/notify', async (env, ctx) => {
  try {
    const u = new URL(ctx.request.url)
    const echostr = u.searchParams.get('echostr') || ''
    const token = env.MP_PUSH_TOKEN || ''
    if (token) {
      const sig = [token, u.searchParams.get('timestamp') || '', u.searchParams.get('nonce') || ''].sort().join('')
      const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(sig)))]
        .map((b) => b.toString(16).padStart(2, '0')).join('')
      if (expected !== (u.searchParams.get('signature') || '')) {
        return new Response('fail', { status: 403, headers: { 'Content-Type': 'text/plain' } })
      }
    }
    return new Response(echostr, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  } catch (e) {
    return new Response('fail', { status: 500, headers: { 'Content-Type': 'text/plain' } })
  }
})

// POST：接收虚拟支付发货推送 xpay_goods_deliver_notify（为主发货依据，需幂等）
router.add('POST', '/wechat/notify', async (env, ctx) => {
  try {
    const raw = await ctx.request.text()
    const event = xmlTag(raw, 'Event')
    if (event !== 'xpay_goods_deliver_notify') return xmlAck(0)

    const outTradeNo = xmlTag(raw, 'OutTradeNo')
    const mchOrderNo = xmlTag(raw, 'MchOrderNo')
    if (!outTradeNo) return xmlAck(0)

    await ensureVipTables(env)
    const order = await env.DB.prepare('SELECT * FROM vip_orders WHERE out_trade_no = ?').bind(outTradeNo).first()
    if (!order) {
      console.error('[虚拟支付] 发货推送：本地订单不存在', outTradeNo)
      return xmlAck(0)
    }
    // 幂等：已发货订单直接返回成功（微信最多重试 15 次）
    if (order.status === 'paid' || order.status === 'sandbox_paid') return xmlAck(0)
    if (order.mode !== 'wechat') return xmlAck(0)

    await grantVip(order.user_id, order.tier, env)
    await env.DB.prepare("UPDATE vip_orders SET status = 'paid', paid_at = ?, wx_order_no = ? WHERE id = ?")
      .bind(nowISO(), mchOrderNo, order.id).run()
    console.log('[虚拟支付] 发货推送成功，已开通会员', outTradeNo)
    return xmlAck(0)
  } catch (e) {
    console.error('[虚拟支付] 发货推送处理异常:', e && e.message)
    return xmlAck(1, 'error')
  }
})

// ============================================================
// 13. 情侣健康打卡 / 共同运动记录
// ============================================================

async function ensureSportTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sport_records (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      sport_type TEXT NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      distance REAL NOT NULL DEFAULT 0,
      steps INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      sport_date TEXT NOT NULL,
      track TEXT,
      created_at TEXT NOT NULL
    )
  `).run()
  // 兼容已存在的旧表，补充 track 字段
  try {
    await env.DB.prepare(`ALTER TABLE sport_records ADD COLUMN track TEXT`).run()
  } catch (_) {}
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sport_goals (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL UNIQUE,
      daily_steps INTEGER NOT NULL DEFAULT 6000,
      weekly_days INTEGER NOT NULL DEFAULT 5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
}

const SPORT_TYPES = [
  { key: 'walk', name: '散步', emoji: '🚶' },
  { key: 'run', name: '跑步', emoji: '🏃' },
  { key: 'bike', name: '骑行', emoji: '🚴' },
  { key: 'hike', name: '徒步', emoji: '🥾' },
  { key: 'other', name: '其他', emoji: '💪' }
]

// 打卡
router.add('POST', '/api/sport/checkin', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { sport_type, duration, distance, steps, note, sport_date, track } = await ctx.request.json()
    if (!sport_type) return json({}, 400, '请选择运动类型', 400)
    await ensureSportTables(env)
    const now = nowISO()
    let trackStr = ''
    if (Array.isArray(track)) {
      try {
        trackStr = JSON.stringify(track.slice(0, 500).map(p => ({ latitude: Number(p.latitude) || 0, longitude: Number(p.longitude) || 0, timestamp: p.timestamp || Date.now() })))
      } catch (_) { trackStr = '' }
    }
    await env.DB.prepare(`
      INSERT INTO sport_records (id, couple_id, user_id, sport_type, duration, distance, steps, note, sport_date, track, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      uuid(), couple.id, user.id, sport_type,
      Math.max(0, parseInt(duration) || 0),
      Math.max(0, Number(distance) || 0),
      Math.max(0, parseInt(steps) || 0),
      (note || '').slice(0, 100),
      sport_date || today(),
      trackStr,
      now
    ).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 删除记录
router.add('POST', '/api/sport/delete', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({}, 400, '未绑定', 400)
    const { id } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    await env.DB.prepare('DELETE FROM sport_records WHERE id = ? AND couple_id = ?').bind(id, couple.id).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 本周统计 + 列表
router.add('GET', '/api/sport/weekly', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({ list: [], stats: {} })
    await ensureSportTables(env)
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id

    // 本周（周一到周日）
    const now = new Date()
    const day = now.getDay() || 7
    const monday = new Date(now)
    monday.setDate(now.getDate() - day + 1)
    const mondayStr = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    const sundayStr = `${sunday.getFullYear()}-${String(sunday.getMonth()+1).padStart(2,'0')}-${String(sunday.getDate()).padStart(2,'0')}`

    const rows = rowsOf(await env.DB.prepare(`
      SELECT s.*, u.nickname as user_name FROM sport_records s
      JOIN users u ON s.user_id = u.id
      WHERE s.couple_id = ? AND s.sport_date BETWEEN ? AND ?
      ORDER BY s.sport_date DESC, s.created_at DESC
      LIMIT 50
    `).bind(couple.id, mondayStr, sundayStr).all())

    const totalSteps = rows.reduce((s, r) => s + Number(r.steps || 0), 0)
    const totalDistance = rows.reduce((s, r) => s + Number(r.distance || 0), 0)
    const totalDuration = rows.reduce((s, r) => s + Number(r.duration || 0), 0)
    const checkinDays = new Set(rows.map(r => r.sport_date)).size
    const myCount = rows.filter(r => r.user_id === user.id).length
    const taCount = rows.filter(r => r.user_id === taId).length

    return json({
      list: rows,
      stats: {
        total_steps: totalSteps,
        total_distance: Number(totalDistance.toFixed(2)),
        total_duration: totalDuration,
        checkin_days: checkinDays,
        my_count: myCount,
        ta_count: taCount,
        week_start: mondayStr,
        week_end: sundayStr
      }
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 今日打卡状态
router.add('GET', '/api/sport/today', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({ my_count: 0, ta_count: 0, list: [] })
    await ensureSportTables(env)
    const taId = couple.user_a_id === user.id ? couple.user_b_id : couple.user_a_id
    const today_ = today()
    const rows = rowsOf(await env.DB.prepare(`
      SELECT s.*, u.nickname as user_name FROM sport_records s
      JOIN users u ON s.user_id = u.id
      WHERE s.couple_id = ? AND s.sport_date = ?
      ORDER BY s.created_at DESC
    `).bind(couple.id, today_).all())
    return json({
      my_count: rows.filter(r => r.user_id === user.id).length,
      ta_count: rows.filter(r => r.user_id === taId).length,
      list: rows
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 设置目标
router.add('POST', '/api/sport/goal', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { daily_steps, weekly_days } = await ctx.request.json()
    await ensureSportTables(env)
    const now = nowISO()
    await env.DB.prepare(`
      INSERT INTO sport_goals (id, couple_id, daily_steps, weekly_days, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(couple_id) DO UPDATE SET
        daily_steps = excluded.daily_steps, weekly_days = excluded.weekly_days, updated_at = excluded.updated_at
    `).bind(uuid(), couple.id, Math.max(1000, parseInt(daily_steps) || 6000), Math.max(1, parseInt(weekly_days) || 5), now, now).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 单条记录详情（含轨迹）
router.add('GET', '/api/sport/detail', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple) return json({}, 400, '未绑定', 400)
    const id = new URL(ctx.request.url).searchParams.get('id')
    if (!id) return json({}, 400, '缺少 id', 400)
    const row = await env.DB.prepare(`
      SELECT s.*, u.nickname as user_name FROM sport_records s
      JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.couple_id = ?
      LIMIT 1
    `).bind(id, couple.id).first()
    if (!row) return json({}, 404, '记录不存在', 404)
    let track = []
    if (row.track) {
      try { track = JSON.parse(row.track) } catch (_) {}
    }
    return json({ ...row, track })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 获取目标
router.add('GET', '/api/sport/goal', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json(null)
    await ensureSportTables(env)
    const goal = await env.DB.prepare('SELECT * FROM sport_goals WHERE couple_id = ?').bind(couple.id).first()
    return json(goal || { daily_steps: 6000, weekly_days: 5 })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ============================================================
// 12.5 今天吃什么（情侣做饭/点餐/公告）
// ============================================================
async function ensureCookTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS couple_cooks (
      couple_id TEXT PRIMARY KEY REFERENCES couples(id) ON DELETE CASCADE,
      cook_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cook_dishes (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      tags TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cook_dishes_couple ON cook_dishes(couple_id)`).run()
  try { await env.DB.prepare('ALTER TABLE cook_dishes ADD COLUMN image TEXT').run() } catch (_) {}
  try { await env.DB.prepare('ALTER TABLE cook_orders ADD COLUMN dish_notes TEXT').run() } catch (_) {}
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cook_orders (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
      order_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      meal_type TEXT NOT NULL,
      dish_ids TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      order_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cook_orders_couple ON cook_orders(couple_id, order_date)`).run()
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cook_announcements (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      active_until TEXT,
      created_at TEXT NOT NULL
    )
  `).run()
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cook_announce_couple ON cook_announcements(couple_id, created_at)`).run()
}

function getMealTypeByHour() {
  const h = new Date().getHours()
  if (h < 10) return '早餐'
  if (h < 15) return '午餐'
  if (h < 20) return '晚餐'
  return '夜宵'
}

async function getCookStatus(coupleId, userId, env) {
  await ensureCookTables(env)
  const couple = await env.DB.prepare('SELECT * FROM couples WHERE id = ?').bind(coupleId).first()
  const taId = couple.user_a_id === userId ? couple.user_b_id : couple.user_a_id
  const ta = taId ? await env.DB.prepare('SELECT id,nickname,avatar_url FROM users WHERE id = ?').bind(taId).first() : null

  const cook = await env.DB.prepare('SELECT * FROM couple_cooks WHERE couple_id = ?').bind(coupleId).first()
  const cookUser = cook && cook.cook_user_id ? await env.DB.prepare('SELECT id,nickname,avatar_url FROM users WHERE id = ?').bind(cook.cook_user_id).first() : null

  const dishes = rowsOf(await env.DB.prepare(`
    SELECT d.*, u.nickname as creator_name FROM cook_dishes d
    LEFT JOIN users u ON u.id = d.created_by
    WHERE d.couple_id = ? ORDER BY d.created_at DESC
  `).bind(coupleId).all())

  const today_ = today()
  const orders = rowsOf(await env.DB.prepare(`
    SELECT o.*, u.nickname as order_name FROM cook_orders o
    LEFT JOIN users u ON u.id = o.order_by
    WHERE o.couple_id = ? AND o.order_date = ? ORDER BY o.created_at DESC
  `).bind(coupleId, today_).all())

  const announcements = rowsOf(await env.DB.prepare(`
    SELECT * FROM cook_announcements WHERE couple_id = ? AND (active_until IS NULL OR active_until >= ?)
    ORDER BY created_at DESC LIMIT 5
  `).bind(coupleId, today_).all())

  return {
    isCook: !!(cook && cook.cook_user_id === userId),
    cookUser: cookUser || null,
    ta,
    dishes,
    orders,
    announcements,
    mealTypeNow: getMealTypeByHour()
  }
}

// 获取做饭状态
router.add('GET', '/api/cook/status', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const status = await getCookStatus(couple.id, user.id, env)
    return json(status)
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 指定/切换做饭方
router.add('POST', '/api/cook/assign', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const { cook_user_id } = await ctx.request.json()
    const targetId = cook_user_id || user.id
    if (targetId !== user.id && targetId !== couple.user_a_id && targetId !== couple.user_b_id) {
      return json({}, 400, '只能指定自己或对方为做饭方', 400)
    }
    await ensureCookTables(env)
    await env.DB.prepare(`
      INSERT INTO couple_cooks (couple_id, cook_user_id, updated_at) VALUES (?,?,?)
      ON CONFLICT(couple_id) DO UPDATE SET cook_user_id=excluded.cook_user_id, updated_at=excluded.updated_at
    `).bind(couple.id, targetId, nowISO()).run()
    return json({ ok: true })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 添加菜品
router.add('POST', '/api/cook/dish', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const raw = await ctx.request.text()
    let body = {}
    try { body = JSON.parse(raw) } catch (_) {}
    const { name, tags, image_base64 } = body
    if (!name || name.trim().length === 0) return json({}, 400, '菜品名称不能为空', 400)
    await ensureCookTables(env)
    const dishId = uuid()
    let imagePath = ''
    if (image_base64) {
      const b64 = String(image_base64).replace(/^data:image\/\w+;base64,/, '')
      try {
        await env.KV.put('dish:' + dishId, b64)
        imagePath = '/api/cook/dish/image/' + dishId
      } catch (e) { console.error('KV put dish image error', e.message || e) }
    }
    await env.DB.prepare('INSERT INTO cook_dishes (id,couple_id,name,tags,image,created_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(dishId, couple.id, name.trim(), tags || '', imagePath, user.id, nowISO()).run()
    return json({ ok: true })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 删除菜品
router.add('POST', '/api/cook/dish/delete', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const { id } = await ctx.request.json()
    await env.DB.prepare('DELETE FROM cook_dishes WHERE id = ? AND couple_id = ?').bind(id, couple.id).run()
    try { await env.KV.delete('dish:' + id) } catch (_) {}
    return json({ ok: true })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 菜品图片代理（从 KV 读取 base64 返回图片）
router.add('GET', '/api/cook/dish/image/:id', async (env, ctx, params) => {
  const id = params && params.id
  if (!id) return new Response('', { status: 404 })
  try {
    let b64 = await env.KV.get('dish:' + id)
    if (!b64) return new Response('', { status: 404 })
    let contentType = 'image/jpeg'
    const dataUriMatch = b64.match(/^data:image\/(\w+);base64,/)
    if (dataUriMatch) {
      contentType = 'image/' + dataUriMatch[1]
      b64 = b64.slice(dataUriMatch[0].length)
    }
    b64 = b64.replace(/[^A-Za-z0-9+/=]/g, '')
    if (!b64) return new Response('', { status: 404 })
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    return new Response(arr, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      }
    })
  } catch (e) {
    return new Response('', { status: 404 })
  }
})

// 点餐
router.add('POST', '/api/cook/order', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const { meal_type, dish_ids, note, dish_notes, order_date } = await ctx.request.json()
    if (!dish_ids || !dish_ids.length) return json({}, 400, '请至少选择一道菜', 400)
    await ensureCookTables(env)
    const d = order_date || today()
    const ids = Array.isArray(dish_ids) ? dish_ids : [dish_ids]
    let notesJson = ''
    if (dish_notes && typeof dish_notes === 'object') notesJson = JSON.stringify(dish_notes)
    await env.DB.prepare(`
      INSERT INTO cook_orders (id,couple_id,order_by,meal_type,dish_ids,note,dish_notes,status,order_date,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(uuid(), couple.id, user.id, meal_type || getMealTypeByHour(), JSON.stringify(ids), note || '', notesJson, 'pending', d, nowISO(), nowISO()).run()
    return json({ ok: true })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 更新订单状态（做饭方操作）
router.add('POST', '/api/cook/order/status', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const { id, status } = await ctx.request.json()
    if (!['pending','done','cancel'].includes(status)) return json({}, 400, '状态错误', 400)
    await env.DB.prepare('UPDATE cook_orders SET status = ?, updated_at = ? WHERE id = ? AND couple_id = ?')
      .bind(status, nowISO(), id, couple.id).run()
    return json({ ok: true })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// 发布公告（做饭方或任意一方）
router.add('POST', '/api/cook/announcement', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定情侣', 400)
    const { content, active_days } = await ctx.request.json()
    if (!content || content.trim().length === 0) return json({}, 400, '公告内容不能为空', 400)
    await ensureCookTables(env)
    const activeUntil = active_days ? addDays(today(), Number(active_days)) : null
    await env.DB.prepare('INSERT INTO cook_announcements (id,couple_id,content,active_until,created_at) VALUES (?,?,?,?,?)')
      .bind(uuid(), couple.id, content.trim(), activeUntil, nowISO()).run()
    return json({ ok: true })
  } catch (e) { return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500) }
})

// ============================================================
// 13. 情侣同步计时 / 专注计时（单人或双人）
// ============================================================

async function ensureTimerTables(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS timer_sessions (
      id TEXT PRIMARY KEY,
      couple_id TEXT NOT NULL,
      session_id TEXT,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'single',
      status TEXT NOT NULL DEFAULT 'done',
      category TEXT NOT NULL DEFAULT 'focus',
      duration INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      timer_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run()
  try {
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_timer_couple ON timer_sessions(couple_id)`).run()
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_timer_session ON timer_sessions(session_id)`).run()
  } catch (_) {}
}

const TIMER_CATEGORIES = [
  { key: 'focus', name: '专注', emoji: '🎯' },
  { key: 'study', name: '学习', emoji: '📚' },
  { key: 'read', name: '阅读', emoji: '📖' },
  { key: 'meditate', name: '冥想', emoji: '🧘' },
  { key: 'work', name: '工作', emoji: '💼' },
  { key: 'other', name: '其他', emoji: '⏱️' }
]

// 发起计时（单人或邀请双人）
router.add('POST', '/api/timer/start', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { mode = 'single', category = 'focus' } = await ctx.request.json()
    await ensureTimerTables(env)
    const id = uuid()
    const sessionId = mode === 'together' ? uuid() : null
    await env.DB.prepare(`
      INSERT INTO timer_sessions (id, couple_id, session_id, user_id, mode, status, category, duration, note, timer_date, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, '', ?, ?)
    `).bind(id, couple.id, sessionId, user.id, mode, category, today(), nowISO()).run()
    return json({ id, session_id: sessionId, mode, category })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 加入双人计时
router.add('POST', '/api/timer/join', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { session_id } = await ctx.request.json()
    if (!session_id) return json({}, 400, '缺少 session_id', 400)
    await ensureTimerTables(env)
    // 检查是否已加入
    const exist = await env.DB.prepare(`SELECT id FROM timer_sessions WHERE session_id = ? AND user_id = ?`).bind(session_id, user.id).first()
    if (exist) return json({ id: exist.id, session_id, already: true })
    const id = uuid()
    const host = await env.DB.prepare(`SELECT category FROM timer_sessions WHERE session_id = ? LIMIT 1`).bind(session_id).first()
    await env.DB.prepare(`
      INSERT INTO timer_sessions (id, couple_id, session_id, user_id, mode, status, category, duration, note, timer_date, created_at)
      VALUES (?, ?, ?, ?, 'together', 'pending', ?, 0, '', ?, ?)
    `).bind(id, couple.id, session_id, user.id, host ? host.category : 'focus', today(), nowISO()).run()
    return json({ id, session_id })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 结束计时，记录时长
router.add('POST', '/api/timer/finish', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '请先绑定情侣', 400)
    const { id, duration, note } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    await ensureTimerTables(env)
    await env.DB.prepare(`
      UPDATE timer_sessions SET status='done', duration=?, note=? WHERE id=? AND user_id=? AND couple_id=?
    `).bind(
      Math.max(0, parseInt(duration) || 0),
      (note || '').slice(0, 100),
      id, user.id, couple.id
    ).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 获取待加入的双人邀请
router.add('GET', '/api/timer/pending', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({ list: [] })
    await ensureTimerTables(env)
    const rows = await env.DB.prepare(`
      SELECT t.*, u.nickname as host_name FROM timer_sessions t
      JOIN users u ON t.user_id = u.id
      WHERE t.couple_id = ? AND t.mode='together' AND t.status='pending' AND t.user_id != ?
      AND NOT EXISTS (
        SELECT 1 FROM timer_sessions t2 WHERE t2.session_id = t.session_id AND t2.user_id = ? AND t2.status='done'
      )
      ORDER BY t.created_at DESC LIMIT 10
    `).bind(couple.id, user.id, user.id).all()
    return json({ list: rowsOf(rows) })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 历史记录列表
router.add('GET', '/api/timer/history', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({ list: [] })
    await ensureTimerTables(env)
    const u = new URL(ctx.request.url)
    const limit = Math.min(50, parseInt(u.searchParams.get('limit') || '30'))
    const rows = await env.DB.prepare(`
      SELECT t.*, u.nickname as user_name, u2.nickname as partner_name
      FROM timer_sessions t
      LEFT JOIN users u ON t.user_id = u.id
      LEFT JOIN users u2 ON u2.id != t.user_id
      WHERE t.couple_id = ? AND t.status='done'
      ORDER BY t.timer_date DESC, t.created_at DESC
      LIMIT ?
    `).bind(couple.id, limit).all()
    return json({ list: rowsOf(rows) })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 统计：本周时长、分类占比、双人次数
router.add('GET', '/api/timer/stats', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({ weekly: [], categories: [], summary: {} })
    await ensureTimerTables(env)
    // 本周起止
    const now = new Date()
    const day = now.getDay() || 7
    const monday = new Date(now)
    monday.setDate(now.getDate() - day + 1)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    const ws = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`
    const we = `${sunday.getFullYear()}-${String(sunday.getMonth()+1).padStart(2,'0')}-${String(sunday.getDate()).padStart(2,'0')}`

    // 按天聚合
    const dailyRows = await env.DB.prepare(`
      SELECT timer_date, SUM(duration) as total FROM timer_sessions
      WHERE couple_id = ? AND status='done' AND timer_date BETWEEN ? AND ?
      GROUP BY timer_date ORDER BY timer_date
    `).bind(couple.id, ws, we).all()
    // 按分类聚合
    const catRows = await env.DB.prepare(`
      SELECT category, SUM(duration) as total, COUNT(*) as cnt FROM timer_sessions
      WHERE couple_id = ? AND status='done' AND timer_date BETWEEN ? AND ?
      GROUP BY category ORDER BY total DESC
    `).bind(couple.id, ws, we).all()
    // 总览
    const sumRow = await env.DB.prepare(`
      SELECT COUNT(*) as cnt, SUM(duration) as total,
        SUM(CASE WHEN mode='together' THEN 1 ELSE 0 END) as together_cnt,
        SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) as my_cnt
      FROM timer_sessions WHERE couple_id=? AND status='done' AND timer_date BETWEEN ? AND ?
    `).bind(user.id, couple.id, ws, we).first()

    // 构造7天数据
    const dailyMap = {}
    rowsOf(dailyRows).forEach(r => { dailyMap[r.timer_date] = Number(r.total) || 0 })
    const weekly = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      weekly.push({ date: ds, day: ['日','一','二','三','四','五','六'][d.getDay()], total: dailyMap[ds] || 0 })
    }

    const categories = rowsOf(catRows).map(r => ({
      category: r.category,
      total: Number(r.total) || 0,
      count: r.cnt
    }))

    return json({
      week_start: ws,
      week_end: we,
      weekly,
      categories,
      summary: {
        total_count: sumRow.cnt || 0,
        total_duration: sumRow.total || 0,
        together_count: sumRow.together_cnt || 0,
        my_count: sumRow.my_cnt || 0
      }
    })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// 删除记录
router.add('POST', '/api/timer/delete', async (env, ctx) => {
  try {
    const user = await requireUser(ctx.request, env)
    const couple = await getUserCouple(user.id, env)
    if (!couple || couple.status !== 'bound') return json({}, 400, '未绑定', 400)
    const { id } = await ctx.request.json()
    if (!id) return json({}, 400, '缺少 id', 400)
    await env.DB.prepare(`DELETE FROM timer_sessions WHERE id=? AND couple_id=? AND user_id=?`).bind(id, couple.id, user.id).run()
    return json({ ok: true })
  } catch (e) {
    return json({}, e.code || 500, e.msg || e.message || '失败', e.code ? 401 : 500)
  }
})

// ============================================================
// Fetch Entry
// ============================================================
function adminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>情侣心情录 · 管理后台</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; background:#f5f6fa; color:#2d3436; }
  .login-wrap { display:flex; align-items:center; justify-content:center; min-height:100vh; background:linear-gradient(135deg,#FF8FAB,#B5A8D8); }
  .login-box { background:#fff; padding:40px; border-radius:16px; box-shadow:0 12px 40px rgba(0,0,0,.15); width:360px; }
  .login-title { font-size:22px; font-weight:700; text-align:center; margin-bottom:8px; }
  .login-sub { font-size:13px; color:#888; text-align:center; margin-bottom:24px; }
  .login-input { width:100%; padding:12px 14px; border:1px solid #ddd; border-radius:8px; font-size:14px; margin-bottom:16px; }
  .login-btn { width:100%; padding:12px; background:linear-gradient(135deg,#FF8FAB,#B5A8D8); color:#fff; border:none; border-radius:8px; font-size:15px; font-weight:600; cursor:pointer; }
  .login-err { color:#e74c3c; font-size:13px; text-align:center; margin-top:8px; min-height:18px; }
  .app { display:none; }
  .topbar { background:#fff; border-bottom:1px solid #e8e8e8; padding:0 24px; height:56px; display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:10; }
  .topbar-title { font-size:16px; font-weight:700; color:#FF8FAB; }
  .topbar-nav { display:flex; gap:4px; flex-wrap:wrap; }
  .nav-btn { padding:6px 14px; border:none; background:transparent; color:#666; font-size:13px; cursor:pointer; border-radius:6px; }
  .nav-btn:hover { background:#f0f0f0; }
  .nav-btn.active { background:linear-gradient(135deg,#FF8FAB,#B5A8D8); color:#fff; }
  .topbar-logout { padding:6px 14px; border:1px solid #ddd; background:#fff; color:#666; font-size:13px; cursor:pointer; border-radius:6px; }
  .main { max-width:1200px; margin:0 auto; padding:24px; }
  .kpi-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin-bottom:24px; }
  .kpi-card { background:#fff; border-radius:12px; padding:20px; box-shadow:0 2px 8px rgba(0,0,0,.06); }
  .kpi-label { font-size:13px; color:#888; margin-bottom:8px; }
  .kpi-value { font-size:32px; font-weight:800; background:linear-gradient(135deg,#FF8FAB,#B5A8D8); -webkit-background-clip:text; -webkit-text-fill-color:transparent; background-clip:text; }
  .kpi-sub { font-size:12px; color:#aaa; margin-top:4px; }
  .card { background:#fff; border-radius:12px; padding:20px; box-shadow:0 2px 8px rgba(0,0,0,.06); margin-bottom:16px; }
  .card-title { font-size:16px; font-weight:700; margin-bottom:16px; display:flex; align-items:center; justify-content:space-between; }
  .table { width:100%; border-collapse:collapse; font-size:13px; }
  .table th { text-align:left; padding:10px 8px; border-bottom:2px solid #f0f0f0; color:#888; font-weight:600; white-space:nowrap; }
  .table td { padding:10px 8px; border-bottom:1px solid#f5f5f5; vertical-align:middle; }
  .table tr:hover { background:#fafafa; }
  .avatar { width:32px; height:32px; border-radius:50%; object-fit:cover; vertical-align:middle; }
  .avatar-fallback { width:32px; height:32px; border-radius:50%; background:linear-gradient(135deg,#FF8FAB,#B5A8D8); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; }
  .tag { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
  .tag-green { background:#e8f5e9; color:#2e7d32; }
  .tag-orange { background:#fff3e0; color:#e65100; }
  .tag-red { background:#fce4ec; color:#c62828; }
  .tag-blue { background:#e3f2fd; color:#1565c0; }
  .tag-gray { background:#f5f5f5; color:#666; }
  .btn-sm { padding:4px 10px; border:1px solid #ddd; background:#fff; color:#666; font-size:12px; cursor:pointer; border-radius:4px; }
  .btn-sm:hover { background:#f5f5f5; }
  .btn-danger { color:#e74c3c; border-color:#faa; }
  .btn-danger:hover { background:#fff5f5; }
  .pagination { display:flex; gap:8px; align-items:center; justify-content:center; margin-top:16px; }
  .page-btn { padding:6px 12px; border:1px solid #ddd; background:#fff; cursor:pointer; border-radius:4px; font-size:13px; }
  .page-btn:hover { background:#f5f5f5; }
  .page-btn:disabled { color:#ccc; cursor:not-allowed; }
  .page-info { font-size:13px; color:#888; }
  .empty { text-align:center; padding:40px; color:#aaa; font-size:14px; }
  .modal-mask { position:fixed; inset:0; background:rgba(0,0,0,.4); display:none; align-items:center; justify-content:center; z-index:100; }
  .modal-mask.show { display:flex; }
  .modal-box { background:#fff; border-radius:12px; padding:24px; width:90%; max-width:720px; max-height:85vh; overflow-y:auto; }
  .modal-title { font-size:18px; font-weight:700; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; }
  .modal-close { cursor:pointer; color:#aaa; font-size:22px; }
  .detail-section { margin-bottom:20px; }
  .detail-section-title { font-size:14px; font-weight:700; color:#FF8FAB; margin-bottom:8px; padding-bottom:4px; border-bottom:1px solid #f0f0f0; }
  .detail-row { display:flex; padding:6px 0; font-size:13px; }
  .detail-label { width:120px; color:#888; flex-shrink:0; }
  .detail-value { flex:1; word-break:break-all; }
  .map-box { width:100%; height:400px; border:none; border-radius:8px; }
  .loading { text-align:center; padding:40px; color:#aaa; }
  .search-bar { display:flex; gap:8px; margin-bottom:12px; }
  .search-input { padding:8px 12px; border:1px solid #ddd; border-radius:6px; font-size:13px; flex:1; }
  .search-btn { padding:8px 16px; background:#FF8FAB; color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:13px; }
</style>
</head>
<body>

<div class="login-wrap" id="loginWrap">
  <div class="login-box">
    <div class="login-title">情侣心情录</div>
    <div class="login-sub">管理后台</div>
    <input type="password" class="login-input" id="loginPass" placeholder="管理员密码" autofocus>
    <button class="login-btn" onclick="doLogin()">登录</button>
    <div class="login-err" id="loginErr"></div>
  </div>
</div>

<div class="app" id="app">
  <div class="topbar">
    <div class="topbar-title">💕 情侣心情录后台</div>
    <div class="topbar-nav" id="topbarNav">
      <button class="nav-btn active" data-tab="dashboard" onclick="switchTab('dashboard')">仪表盘</button>
      <button class="nav-btn" data-tab="users" onclick="switchTab('users')">用户</button>
      <button class="nav-btn" data-tab="locations" onclick="switchTab('locations')">位置</button>
      <button class="nav-btn" data-tab="couples" onclick="switchTab('couples')">情侣</button>
      <button class="nav-btn" data-tab="moods" onclick="switchTab('moods')">心情</button>
      <button class="nav-btn" data-tab="sport" onclick="switchTab('sport')">运动</button>
      <button class="nav-btn" data-tab="timer" onclick="switchTab('timer')">计时</button>
      <button class="nav-btn" data-tab="bills" onclick="switchTab('bills')">账单</button>
    </div>
    <button class="topbar-logout" onclick="doLogout()">退出</button>
  </div>
  <div class="main" id="main"></div>
</div>

<div class="modal-mask" id="modalMask">
  <div class="modal-box" id="modalBox"></div>
</div>

<script>
const API = location.origin;
let adminPass = localStorage.getItem('adminPass') || '';
let currentTab = 'dashboard';
let currentPage = { users:1, couples:1, moods:1, sport:1, timer:1, bills:1 };

async function api(path, opts) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'X-Admin-Pass': adminPass, 'Content-Type':'application/json', ...(opts&&opts.headers||{}) }
  });
  return res.json();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function avatarCell(url, name) {
  if (url) return '<img class="avatar" src="'+escapeHtml(url)+'" onerror="this.outerHTML=\\'<span class=\\'avatar-fallback\\'>'+escapeHtml((name||'?')[0])+'</span>\\'">';
  return '<span class="avatar-fallback">'+escapeHtml((name||'?')[0])+'</span>';
}

function fmtTime(t) {
  if (!t) return '-';
  return String(t).replace('T',' ').slice(0,16);
}

function doLogin() {
  const pass = document.getElementById('loginPass').value;
  if (!pass) { document.getElementById('loginErr').textContent = '请输入密码'; return; }
  document.getElementById('loginErr').textContent = '验证中...';
  // 临时设置密码用于验证
  adminPass = pass;
  api('/api/admin/kpi', {}).then(r => {
    if (r && r.code === 0) {
      localStorage.setItem('adminPass', pass);
      document.getElementById('loginWrap').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      switchTab('dashboard');
    } else {
      adminPass = '';
      document.getElementById('loginErr').textContent = '密码错误';
    }
  }).catch(() => { adminPass = ''; document.getElementById('loginErr').textContent = '网络错误'; });
}

document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function doLogout() {
  adminPass = '';
  localStorage.removeItem('adminPass');
  location.reload();
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const main = document.getElementById('main');
  if (tab === 'dashboard') renderDashboard();
  else if (tab === 'users') renderList('users');
  else if (tab === 'locations') renderLocations();
  else if (tab === 'couples') renderList('couples');
  else if (tab === 'moods') renderList('moods');
  else if (tab === 'sport') renderList('sport');
  else if (tab === 'timer') renderList('timer');
  else if (tab === 'bills') renderList('bills');
}

async function renderDashboard() {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading">加载中...</div>';
  const r = await api('/api/admin/kpi');
  const d = r.data || r;
  main.innerHTML = \`
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-label">总用户数</div><div class="kpi-value">\${d.total_users||0}</div><div class="kpi-sub">累计注册</div></div>
      <div class="kpi-card"><div class="kpi-label">已绑定情侣</div><div class="kpi-value">\${d.bound_couples||0}</div><div class="kpi-sub">对</div></div>
      <div class="kpi-card"><div class="kpi-label">今日活跃</div><div class="kpi-value">\${d.today_active||0}</div><div class="kpi-sub">人</div></div>
      <div class="kpi-card"><div class="kpi-label">今日心情记录</div><div class="kpi-value">\${d.today_records||0}</div><div class="kpi-sub">条</div></div>
    </div>
    <div class="card">
      <div class="card-title">快捷操作</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-sm" onclick="switchTab('users')">查看用户</button>
        <button class="btn-sm" onclick="switchTab('locations')">查看位置</button>
        <button class="btn-sm" onclick="switchTab('moods')">心情记录</button>
        <button class="btn-sm" onclick="switchTab('sport')">运动记录</button>
      </div>
    </div>
  \`;
}

async function renderList(type) {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading">加载中...</div>';
  const page = currentPage[type];
  const r = await api('/api/admin/'+type+'?page='+page+'&size=20');
  const d = r.data || r;
  const list = d.list || [];
  const total = d.total || 0;
  const totalPages = Math.ceil(total / 20);
  let rows = '';
  if (type === 'users') {
    rows = list.map(u => \`
      <tr>
        <td>\${avatarCell(u.avatar_url, u.nickname)}</td>
        <td>\${escapeHtml(u.nickname||'未设置')}</td>
        <td>\${u.couple_status === 'bound' ? '<span class="tag tag-green">已绑定</span>' : u.couple_status === 'pending' ? '<span class="tag tag-orange">待绑定</span>' : u.couple_status === 'cooling' ? '<span class="tag tag-red">冷静期</span>' : '<span class="tag tag-gray">未绑定</span>'}</td>
        <td>\${escapeHtml(u.location_city||'-')}</td>
        <td>\${u.location_visible ? '<span class="tag tag-green">可见</span>' : '<span class="tag tag-gray">隐藏</span>'}</td>
        <td>\${fmtTime(u.created_at)}</td>
        <td>
          <button class="btn-sm" onclick="showUserDetail('\${u.id}')">详情</button>
          <button class="btn-sm btn-danger" onclick="deleteUser('\${u.id}','\${escapeHtml(u.nickname||'')}')">删除</button>
        </td>
      </tr>
    \`).join('');
  } else if (type === 'couples') {
    rows = list.map(c => \`
      <tr>
        <td>\${escapeHtml(c.user_a_name||'-')}</td>
        <td>\${escapeHtml(c.user_b_name||'-')}</td>
        <td>\${c.status === 'bound' ? '<span class="tag tag-green">已绑定</span>' : c.status === 'pending' ? '<span class="tag tag-orange">待绑定</span>' : c.status === 'cooling' ? '<span class="tag tag-red">冷静期</span>' : '<span class="tag tag-gray">已解绑</span>'}</td>
        <td>\${escapeHtml(c.bind_date||'-')}</td>
        <td>\${escapeHtml(c.invite_code||'-')}</td>
        <td>\${fmtTime(c.updated_at)}</td>
      </tr>
    \`).join('');
  } else if (type === 'moods') {
    rows = list.map(m => \`
      <tr>
        <td>\${avatarCell(m.user_avatar, m.user_name)} \${escapeHtml(m.user_name||'-')}</td>
        <td>\${escapeHtml(m.weather||'-')}</td>
        <td>\${escapeHtml((m.note||'').slice(0,30))}\${(m.note||'').length>30?'...':''}</td>
        <td>\${escapeHtml(m.record_date||'-')}</td>
        <td>\${fmtTime(m.created_at)}</td>
      </tr>
    \`).join('');
  } else if (type === 'sport') {
    rows = list.map(s => \`
      <tr>
        <td>\${avatarCell(s.user_avatar, s.user_name)} \${escapeHtml(s.user_name||'-')}</td>
        <td>\${escapeHtml(s.sport_type||'-')}</td>
        <td>\${s.duration||0}秒</td>
        <td>\${s.distance||0}km</td>
        <td>\${s.steps||0}步</td>
        <td>\${escapeHtml(s.sport_date||'-')}</td>
      </tr>
    \`).join('');
  } else if (type === 'timer') {
    rows = list.map(t => \`
      <tr>
        <td>\${avatarCell(t.user_avatar, t.user_name)} \${escapeHtml(t.user_name||'-')}</td>
        <td>\${t.mode === 'together' ? '<span class="tag tag-blue">双人</span>' : '<span class="tag tag-gray">单人</span>'}</td>
        <td>\${escapeHtml(t.category||'-')}</td>
        <td>\${t.duration||0}秒</td>
        <td>\${escapeHtml(t.timer_date||'-')}</td>
        <td>\${escapeHtml((t.note||'').slice(0,20))}</td>
      </tr>
    \`).join('');
  } else if (type === 'bills') {
    rows = list.map(b => \`
      <tr>
        <td>\${avatarCell(b.user_avatar, b.user_name)} \${escapeHtml(b.user_name||'-')}</td>
        <td>¥\${b.amount||0}</td>
        <td>\${escapeHtml(b.category||'-')}</td>
        <td>\${escapeHtml((b.note||'').slice(0,20))}</td>
        <td>\${escapeHtml(b.bill_date||'-')}</td>
      </tr>
    \`).join('');
  }
  main.innerHTML = \`
    <div class="card">
      <div class="card-title">\${({users:'用户管理',couples:'情侣绑定',moods:'心情记录',sport:'运动记录',timer:'计时记录',bills:'账单记录'})[type]} <span style="font-size:13px;color:#888;font-weight:400">共 \${total} 条</span></div>
      <table class="table"><thead><tr>\${getHeaders(type)}</tr></thead><tbody>\${rows || '<tr><td colspan="99" class="empty">暂无数据</td></tr>'}</tbody></table>
      <div class="pagination">
        <button class="page-btn" \${page<=1?'disabled':''} onclick="changePage('\${type}',\${page-1})">上一页</button>
        <span class="page-info">第 \${page} / \${totalPages||1} 页</span>
        <button class="page-btn" \${page>=totalPages?'disabled':''} onclick="changePage('\${type}',\${page+1})">下一页</button>
      </div>
    </div>
  \`;
}

function getHeaders(type) {
  const h = {
    users: '<th>头像</th><th>昵称</th><th>绑定</th><th>城市</th><th>位置</th><th>注册时间</th><th>操作</th>',
    couples: '<th>用户A</th><th>用户B</th><th>状态</th><th>绑定日</th><th>邀请码</th><th>更新时间</th>',
    moods: '<th>用户</th><th>心情</th><th>备注</th><th>日期</th><th>记录时间</th>',
    sport: '<th>用户</th><th>类型</th><th>时长</th><th>距离</th><th>步数</th><th>日期</th>',
    timer: '<th>用户</th><th>模式</th><th>分类</th><th>时长</th><th>日期</th><th>备注</th>',
    bills: '<th>用户</th><th>金额</th><th>分类</th><th>备注</th><th>日期</th>'
  };
  return h[type] || '';
}

function changePage(type, page) {
  currentPage[type] = Math.max(1, page);
  renderList(type);
}

async function renderLocations() {
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading">加载中...</div>';
  const r = await api('/api/admin/locations');
  const list = (r.data || r).list || [];
  const withLoc = list.filter(u => u.lat && u.lng);
  let rows = list.map(u => \`
    <tr>
      <td>\${avatarCell(u.avatar_url, u.nickname)} \${escapeHtml(u.nickname||'未设置')}</td>
      <td>\${u.lat && u.lng ? u.lat.toFixed(4)+', '+u.lng.toFixed(4) : '-'}</td>
      <td>\${escapeHtml([u.province,u.city,u.district].filter(Boolean).join(' · ')||'-')}</td>
      <td>\${escapeHtml(u.street||u.poi||'-')}</td>
      <td>\${u.visible ? '<span class="tag tag-green">可见</span>' : '<span class="tag tag-gray">隐藏</span>'}</td>
      <td>\${fmtTime(u.updated_at)}</td>
      <td>\${u.lat && u.lng ? '<button class="btn-sm" onclick="showMap('+u.lat+','+u.lng+',\\''+escapeHtml(u.nickname||'')+'\\')">查看地图</button>' : '-'}</td>
    </tr>
  \`).join('');
  main.innerHTML = \`
    <div class="card">
      <div class="card-title">用户位置 (\${withLoc.length}/\${list.length} 有位置)</div>
      <table class="table"><thead><tr><th>用户</th><th>经纬度</th><th>省市区</th><th>街道/POI</th><th>状态</th><th>更新时间</th><th>操作</th></tr></thead><tbody>\${rows||'<tr><td colspan="7" class="empty">暂无数据</td></tr>'}</tbody></table>
    </div>
  \`;
}

function showMap(lat, lng, name) {
  const box = document.getElementById('modalBox');
  box.innerHTML = \`
    <div class="modal-title">\${escapeHtml(name)} 的位置 <span class="modal-close" onclick="closeModal()">&times;</span></div>
    <div style="margin-bottom:12px;font-size:13px;color:#888;">坐标: \${lat}, \${lng}</div>
    <iframe class="map-box" src="https://api.map.baidu.com/marker?location=\${lat},\${lng}&title=\${encodeURIComponent(name)}&content=\${encodeURIComponent(name)}&output=html&src=webapp.baidu.openAPIdemo"></iframe>
    <div style="margin-top:12px;text-align:center;display:flex;gap:8px;justify-content:center;">
      <a href="https://uri.amap.com/marker?position=\${lng},\${lat}&name=\${encodeURIComponent(name)}" target="_blank" class="btn-sm" style="text-decoration:none;">高德地图打开</a>
      <a href="https://map.baidu.com/search/\${lat},\${lng}" target="_blank" class="btn-sm" style="text-decoration:none;">百度地图打开</a>
    </div>
  \`;
  document.getElementById('modalMask').classList.add('show');
}

async function showUserDetail(id) {
  const box = document.getElementById('modalBox');
  box.innerHTML = '<div class="loading">加载中...</div>';
  document.getElementById('modalMask').classList.add('show');
  const r = await api('/api/admin/user/detail?id='+id);
  const d = r.data || r;
  const u = d.user || {};
  const loc = d.location || {};
  const cp = d.couple || {};
  const moods = d.moods || [];
  const sports = d.sports || [];
  const timers = d.timers || [];
  const bills = d.bills || [];
  box.innerHTML = \`
    <div class="modal-title">用户详情 <span class="modal-close" onclick="closeModal()">&times;</span></div>
    <div class="detail-section">
      <div class="detail-section-title">基本信息</div>
      <div class="detail-row"><div class="detail-label">头像</div><div class="detail-value">\${avatarCell(u.avatar_url, u.nickname)}</div></div>
      <div class="detail-row"><div class="detail-label">昵称</div><div class="detail-value">\${escapeHtml(u.nickname||'-')}</div></div>
      <div class="detail-row"><div class="detail-label">OpenID</div><div class="detail-value" style="font-size:11px;color:#aaa;">\${escapeHtml(u.openid||'-')}</div></div>
      <div class="detail-row"><div class="detail-label">注册时间</div><div class="detail-value">\${fmtTime(u.created_at)}</div></div>
      <div class="detail-row"><div class="detail-label">更新时间</div><div class="detail-value">\${fmtTime(u.updated_at)}</div></div>
    </div>
    \${loc && loc.lat ? \`
    <div class="detail-section">
      <div class="detail-section-title">位置信息</div>
      <div class="detail-row"><div class="detail-label">坐标</div><div class="detail-value">\${loc.lat}, \${loc.lng} <button class="btn-sm" onclick="showMap(\${loc.lat},\${loc.lng},'\\'\${escapeHtml(u.nickname||'')}\\'')">查看地图</button></div></div>
      <div class="detail-row"><div class="detail-label">地址</div><div class="detail-value">\${escapeHtml([loc.province,loc.city,loc.district,loc.street].filter(Boolean).join(' · ')||'-')}</div></div>
      <div class="detail-row"><div class="detail-label">POI</div><div class="detail-value">\${escapeHtml(loc.poi||'-')}</div></div>
      <div class="detail-row"><div class="detail-label">可见性</div><div class="detail-value">\${loc.visible?'<span class="tag tag-green">可见</span>':'<span class="tag tag-gray">隐藏</span>'}</div></div>
      <div class="detail-row"><div class="detail-label">更新时间</div><div class="detail-value">\${fmtTime(loc.updated_at)}</div></div>
    </div>\` : ''}
    \${cp && cp.id ? \`
    <div class="detail-section">
      <div class="detail-section-title">情侣绑定</div>
      <div class="detail-row"><div class="detail-label">状态</div><div class="detail-value">\${cp.status==='bound'?'<span class="tag tag-green">已绑定</span>':cp.status==='pending'?'<span class="tag tag-orange">待绑定</span>':cp.status==='cooling'?'<span class="tag tag-red">冷静期</span>':'<span class="tag tag-gray">'+escapeHtml(cp.status||'-')+'</span>'}</div></div>
      <div class="detail-row"><div class="detail-label">绑定日</div><div class="detail-value">\${escapeHtml(cp.bind_date||'-')}</div></div>
      <div class="detail-row"><div class="detail-label">邀请码</div><div class="detail-value">\${escapeHtml(cp.invite_code||'-')}</div></div>
    </div>\` : ''}
    <div class="detail-section">
      <div class="detail-section-title">最近心情 (\${moods.length})</div>
      \${moods.length ? moods.map(m => '<div class="detail-row"><div class="detail-label">'+escapeHtml(m.record_date)+'</div><div class="detail-value">'+escapeHtml(m.weather)+' '+(m.note?escapeHtml(m.note.slice(0,40)):'')+'</div></div>').join('') : '<div class="empty">暂无</div>'}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">最近运动 (\${sports.length})</div>
      \${sports.length ? sports.map(s => '<div class="detail-row"><div class="detail-label">'+escapeHtml(s.sport_date)+'</div><div class="detail-value">'+escapeHtml(s.sport_type)+' · '+s.duration+'秒 · '+s.distance+'km</div></div>').join('') : '<div class="empty">暂无</div>'}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">最近计时 (\${timers.length})</div>
      \${timers.length ? timers.map(t => '<div class="detail-row"><div class="detail-label">'+escapeHtml(t.timer_date)+'</div><div class="detail-value">'+escapeHtml(t.category)+' · '+t.duration+'秒 · '+(t.mode==='together'?'双人':'单人')+'</div></div>').join('') : '<div class="empty">暂无</div>'}
    </div>
    <div class="detail-section">
      <div class="detail-section-title">最近账单 (\${bills.length})</div>
      \${bills.length ? bills.map(b => '<div class="detail-row"><div class="detail-label">'+escapeHtml(b.bill_date)+'</div><div class="detail-value">¥'+b.amount+' · '+escapeHtml(b.category)+(b.note?' · '+escapeHtml(b.note.slice(0,20)):'')+'</div></div>').join('') : '<div class="empty">暂无</div>'}
    </div>
  \`;
}

function deleteUser(id, name) {
  if (!confirm('确定删除用户「'+name+'」？\\n此操作会删除该用户的所有关联数据（心情、运动、计时、账单、位置、情侣绑定），不可恢复！')) return;
  api('/api/admin/user/delete', { method:'POST', body: JSON.stringify({ id }) }).then(r => {
    if (r && r.code === 0) { alert('删除成功'); renderList('users'); }
    else alert('删除失败: '+(r&&r.msg||''));
  });
}

function closeModal() { document.getElementById('modalMask').classList.remove('show'); }
document.getElementById('modalMask').addEventListener('click', e => { if (e.target.id === 'modalMask') closeModal(); });

if (adminPass) {
  api('/api/admin/kpi').then(r => {
    if (r && r.code === 0) {
      document.getElementById('loginWrap').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      switchTab('dashboard');
    }
  });
}
</script>
</body>
</html>`;
}

// ============================================================
// Fetch Entry
// ============================================================
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsOptions()
    const url = new URL(request.url)
    // 管理后台页面
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(adminHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    // 给 ctx 加上 request
    ctx.request = request
    try {
      const res = await router.match(request.method, request.url, env, ctx)
      return res
    } catch (e) {
      console.error('UNCAUGHT', e && e.message, e && e.stack)
      return json({ error: e && e.message, stack: e && e.stack }, 500, 'Internal Error', 500)
    }
  },

  // Cron：每天 00:05 UTC+8 = 16:05 UTC
  async scheduled(event, env, ctx) {
    const safeEnv = withEnv(env)
    ctx.waitUntil((async () => {
      // 1) 遍历所有 bound 情侣，刷新预警
      const couples = rowsOf(await safeEnv.DB.prepare("SELECT id FROM couples WHERE status = 'bound'").all())
      for (const c of couples) {
        await scheduleAlertCheck(c.id, safeEnv)
      }

      // 2) 心愿比对：昨天的心愿 vs 昨日共同天气
      const yesterday_ = fmtDate(new Date(Date.now() - 24*3600*1000).toISOString())
      const wishes = rowsOf(await safeEnv.DB.prepare('SELECT * FROM wishes WHERE target_date = ? AND fulfilled = 0').bind(yesterday_).all())
      for (const w of wishes) {
        const sw = await safeEnv.DB.prepare('SELECT weather_name FROM shared_weather WHERE couple_id = ? AND record_date = ?').bind(w.couple_id, yesterday_).first()
        if (!sw) continue
        const name = sw.weather_name
        let ok = false
        if (name.includes(w.wish_weather)) ok = true
        if (w.wish_weather === '晴' && (name.includes('晴') || name === '万里无云')) ok = true
        if (ok) await safeEnv.DB.prepare('UPDATE wishes SET fulfilled = 1 WHERE id = ?').bind(w.id).run()
      }

      // 3) 每月 1 号生成月度报告（简单示例）
      const today_ = new Date()
      if (today_.getDate() === 1) {
        const lastMonth = new Date(today_.getFullYear(), today_.getMonth() - 1, 1)
        const y = lastMonth.getFullYear(), m = lastMonth.getMonth() + 1
        for (const c of couples) {
          const exists = await safeEnv.DB.prepare(
            "SELECT id FROM climate_reports WHERE couple_id = ? AND period_type = 'month' AND period_start = ? LIMIT 1"
          ).bind(c.id, `${y}-${String(m).padStart(2,'0')}-01`).first()
          if (exists) continue
          // 简单插入（真实项目里应该按月计算 stats_json）
          await safeEnv.DB.prepare(
            "INSERT INTO climate_reports (id,couple_id,period_type,period_start,period_end,stats_json,note,created_at) VALUES (?,?,?,?,?,?,?,?)"
          ).bind(uuid(), c.id, 'month',
            `${y}-${String(m).padStart(2,'0')}-01`,
            `${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}`,
            JSON.stringify({ generated_by_cron: true }),
            '自动生成的月度报告，请在 APP 内查看详细内容',
            nowISO()
          ).run()
        }
      }

      // 4) 订阅消息推送
      try {
        await sendDailySubscribeMessages(safeEnv, couples)
      } catch (e) {
        console.error('subscribe push err', e.message || e)
      }
    })())
  }
}
