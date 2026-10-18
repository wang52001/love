# ============================================================
#  小气候 · Cloudflare Worker 一键部署脚本（给爸爸用的 ^_^）
#  使用方法：右键 → 使用 PowerShell 运行，或在 PowerShell 里执行：
#    powershell -ExecutionPolicy Bypass -File d:\Desktop\love\cloudflare-backend\deploy.ps1
# ============================================================

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  小气候 · 一键部署脚本启动！" -ForegroundColor Cyan
Write-Host "===========================================" -ForegroundColor Cyan
Write-Host "  工作目录: $ScriptDir"
Write-Host ""

# ------ 1. 清理可能冲突的环境变量（CLOUDFLARE_API_TOKEN 会导致 OAuth 失效） ------
Write-Host "[1/5] 清理冲突环境变量..." -ForegroundColor Yellow
$env:CLOUDFLARE_API_TOKEN = ""
$env:CLOUDFLARE_ACCOUNT_ID = ""
Write-Host "      OK 已禁用 CLOUDFLARE_API_TOKEN，强制走 OAuth 登录" -ForegroundColor Green

# ------ 2. 登录 Cloudflare（自动开浏览器） ------
Write-Host ""
Write-Host "[2/5] 登录 Cloudflare..." -ForegroundColor Yellow
Write-Host "      浏览器会自动弹出页面，请登录你的 1655316141@qq.com 账号后" -ForegroundColor White
Write-Host "      点击页面上的蓝色 [Allow] 按钮授权" -ForegroundColor White
Write-Host ""

$login = Start-Process -FilePath "npx.cmd" -ArgumentList @("wrangler", "login", "--browser") -PassThru -NoNewWindow -Wait

if ($login.ExitCode -ne 0) {
  Write-Host ""
  Write-Host "  登录超时或失败！请尝试下面方法：" -ForegroundColor Red
  Write-Host "    1) 刷新浏览器 OAuth 页面重新点 Allow"
  Write-Host "    2) 或手动在当前终端执行:  cd $ScriptDir ; npx wrangler login"
  Write-Host ""
  Read-Host "按 Enter 退出"
  exit 1
}

Write-Host "      OK 登录成功！" -ForegroundColor Green

# ------ 3. 设置 WECHAT_SECRET（微信 AppSecret，生产环境必须配置） ------
Write-Host ""
Write-Host "[3/5] 配置微信 AppSecret..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  ========================================" -ForegroundColor White
Write-Host "  微信 AppSecret 是小程序登录和生成小程序码的必备密钥" -ForegroundColor White
Write-Host "  获取方式：" -ForegroundColor White
Write-Host "    1. 登录 mp.weixin.qq.com" -ForegroundColor White
Write-Host "    2. 开发 -> 开发管理 -> 开发设置" -ForegroundColor White
Write-Host "    3. 找到 AppSecret，点 [重置] 获取（32位字符串）" -ForegroundColor White
Write-Host "  ========================================" -ForegroundColor White
Write-Host ""

$wechatSecret = Read-Host "请粘贴你的微信 AppSecret（直接 Ctrl+V 粘贴）"

if ([string]::IsNullOrWhiteSpace($wechatSecret)) {
  Write-Host ""
  Write-Host "  未输入 AppSecret！登录将使用 mock_openid（账号不固定），" -ForegroundColor Red
  Write-Host "  小程序码也无法生成。建议配置后再部署。" -ForegroundColor Red
  Write-Host ""
  $skip = Read-Host "确定要跳过吗？输入 y 跳过，其他键退出"
  if ($skip -ne "y" -and $skip -ne "Y") { exit 1 }
} else {
  $wechatSecret = $wechatSecret.Trim()
  Write-Host ""
  Write-Host "      正在设置 WECHAT_SECRET..." -ForegroundColor White
  $wechatSecret | npx wrangler secret put WECHAT_SECRET 2>&1 | ForEach-Object { Write-Host "      $_" }
  Write-Host ""
  Write-Host "      OK WECHAT_SECRET 设置完成" -ForegroundColor Green
}

# ------ 4. 设置其他 secrets（JWT_SECRET + ADMIN_PASS） ------
Write-Host ""
Write-Host "[4/5] 设置其他环境密钥..." -ForegroundColor Yellow

# 使用 here-string 方式避免管道乱码问题
$jwtSecret = "REDACTED"
$adminPass = "REDACTED"

$jwtSecret | npx wrangler secret put JWT_SECRET 2>&1 | ForEach-Object { Write-Host "      $_" }
Write-Host ""
$adminPass | npx wrangler secret put ADMIN_PASS 2>&1 | ForEach-Object { Write-Host "      $_" }
Write-Host ""
Write-Host "      OK JWT_SECRET + ADMIN_PASS 设置完成" -ForegroundColor Green

# ------ 5. 部署到 Cloudflare Workers ------
Write-Host ""
Write-Host "[5/5] 部署 Worker 到 Cloudflare..." -ForegroundColor Yellow
Write-Host "      打包 + 上传中，大约需要 30~60 秒，请耐心等待..."
Write-Host ""

npx wrangler deploy 2>&1 | ForEach-Object { Write-Host "      $_" }

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "===========================================" -ForegroundColor Green
  Write-Host "  部署成功！！！" -ForegroundColor Green
  Write-Host "===========================================" -ForegroundColor Green
  Write-Host "  API 已上线，现在可以回到微信开发者工具刷新小程序" -ForegroundColor Cyan
  if (-not [string]::IsNullOrWhiteSpace($wechatSecret)) {
    Write-Host "  邀请码和小程序码现在都可以正常使用了" -ForegroundColor Cyan
  }
} else {
  Write-Host ""
  Write-Host "  部署失败，错误代码: $LASTEXITCODE" -ForegroundColor Red
  Write-Host "  请把上面终端里的红字截图发给我看看" -ForegroundColor Red
}

Write-Host ""
Read-Host "部署完成！按 Enter 关闭窗口"
