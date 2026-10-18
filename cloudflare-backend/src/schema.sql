-- ==========================================================
-- 小气候 · D1 (SQLite) 数据库 Schema
-- 执行方式：wrangler d1 execute xiaoqihou-db --remote --file=./schema.sql
-- ==========================================================

PRAGMA foreign_keys = ON;

-- 1. 用户表
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,             -- uuid
    openid        TEXT UNIQUE NOT NULL,         -- 微信 openid
    unionid       TEXT,
    nickname      TEXT NOT NULL DEFAULT '',
    avatar_url    TEXT NOT NULL DEFAULT '',
    admin_level   INTEGER NOT NULL DEFAULT 0,   -- 0普通,1管理员
    session_key   TEXT,                         -- code2Session 返回，虚拟支付用户态签名用
    created_at    TEXT NOT NULL,                -- ISO
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid);

-- 2. 情侣绑定关系
CREATE TABLE IF NOT EXISTS couples (
    id              TEXT PRIMARY KEY,
    user_a_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_b_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
    bind_date       TEXT,                                  -- 实际绑定日
    status          TEXT NOT NULL DEFAULT 'pending',      -- pending/bound/cooling/unbound
    unbind_requester TEXT,                                 -- 解绑申请人 user_id
    cooling_until   TEXT,                                 -- 冷静期到期 ISO
    invite_code     TEXT UNIQUE,                          -- A 生成的邀请码
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_couples_a ON couples(user_a_id);
CREATE INDEX IF NOT EXISTS idx_couples_b ON couples(user_b_id);
CREATE INDEX IF NOT EXISTS idx_couples_code ON couples(invite_code);

-- 3. 每日心情记录（一人一天一条）
CREATE TABLE IF NOT EXISTS mood_records (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    couple_id   TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    weather     TEXT NOT NULL,            -- 晴/多云/阴/小雨/雷暴/彩虹
    note        TEXT NOT NULL DEFAULT '',
    record_date TEXT NOT NULL,            -- YYYY-MM-DD
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE(user_id, record_date)
);
CREATE INDEX IF NOT EXISTS idx_mood_couple_date ON mood_records(couple_id, record_date);
CREATE INDEX IF NOT EXISTS idx_mood_user ON mood_records(user_id, record_date);

-- 4. 合成的共同天气（缓存，加速查询；可按天重新计算）
CREATE TABLE IF NOT EXISTS shared_weather (
    id          TEXT PRIMARY KEY,
    couple_id   TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    weather_name TEXT NOT NULL,
    record_date TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE(couple_id, record_date)
);
CREATE INDEX IF NOT EXISTS idx_sw_couple ON shared_weather(couple_id, record_date);

-- 5. 气候报告（满月/百天/周年/月度）
CREATE TABLE IF NOT EXISTS climate_reports (
    id            TEXT PRIMARY KEY,
    couple_id     TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    period_type   TEXT NOT NULL,            -- month/hundred/year/custom
    period_start  TEXT NOT NULL,
    period_end    TEXT NOT NULL,
    stats_json    TEXT NOT NULL,            -- 天数占比/平均气温/连晴/恢复时长
    note          TEXT NOT NULL DEFAULT '', -- 分析师笔记
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_report_couple ON climate_reports(couple_id, period_type);

-- 6. 心愿天气
CREATE TABLE IF NOT EXISTS wishes (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    couple_id    TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    wish_weather TEXT NOT NULL,
    reason       TEXT NOT NULL DEFAULT '',
    target_date  TEXT NOT NULL,             -- YYYY-MM-DD 明天
    fulfilled    INTEGER NOT NULL DEFAULT 0,-- 0否1是
    created_at   TEXT NOT NULL,
    UNIQUE(user_id, target_date)
);
CREATE INDEX IF NOT EXISTS idx_wish_couple ON wishes(couple_id, target_date);

-- 7. 位置快照（仅保留最新）
CREATE TABLE IF NOT EXISTS location_snapshots (
    id           TEXT PRIMARY KEY,
    user_id      TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lng          REAL,
    lat          REAL,
    province     TEXT NOT NULL DEFAULT '',
    city         TEXT NOT NULL DEFAULT '',
    district     TEXT NOT NULL DEFAULT '',
    street       TEXT NOT NULL DEFAULT '',
    poi          TEXT NOT NULL DEFAULT '',
    address      TEXT NOT NULL DEFAULT '',
    visible      INTEGER NOT NULL DEFAULT 1, -- 1可见 0隐藏
    updated_at   TEXT NOT NULL
);

-- 8. 气象预警记录
CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,
    couple_id  TEXT NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    level      TEXT NOT NULL,                -- blue/yellow/orange
    start_date TEXT NOT NULL,
    end_date   TEXT,
    days       INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'active', -- active/closed
    created_at TEXT NOT NULL,
    closed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_couple ON alerts(couple_id, status);

-- 9. 心动会员 · 订单表（虚拟支付）
CREATE TABLE IF NOT EXISTS vip_orders (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier         TEXT NOT NULL,               -- monthly/quarterly/yearly
    title        TEXT NOT NULL,
    price        REAL NOT NULL,              -- 元（展示用）
    goods_price  INTEGER NOT NULL DEFAULT 0, -- 道具单价（分，须与MP后台道具价格一致）
    status       TEXT NOT NULL DEFAULT 'created', -- created/paid/sandbox_paid
    mode         TEXT NOT NULL DEFAULT 'sandbox', -- sandbox/wechat
    out_trade_no TEXT UNIQUE,                -- 8-32位，不能以下划线开头
    product_id   TEXT NOT NULL DEFAULT '',   -- MP后台道具ID
    wx_order_no  TEXT,                       -- 微信支付商户单号（幂等去重依据）
    attach       TEXT NOT NULL DEFAULT '',   -- 透传数据
    created_at   TEXT NOT NULL,
    paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_vip_orders_user ON vip_orders(user_id, created_at);

-- 10. 心动会员 · 会员状态表
CREATE TABLE IF NOT EXISTS vip_memberships (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level      INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
