# ============================================================
#  小气候 · 一键部署（用真实窗口，解决 localhost:8976 回调问题）
#  运行方式：在 PowerShell 里执行：
#     powershell -ExecutionPolicy Bypass -File "d:\Desktop\love\cloudflare-backend\deploy-real.ps1"
# ============================================================
param([switch]$NoLogin)

$ErrorActionPreference = "Continue"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  🌈 小气候 - Cloudflare Worker 一键部署" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host ""

# === 1. 清理环境变量（避免 token 冲突） ===
Write-Host "[1/3] 清理环境变量..." -ForegroundColor Yellow
$env:CLOUDFLARE_API_TOKEN = ""
$env:CLOUDFLARE_ACCOUNT_ID = ""
Write-Host "      ✓ CLOUDFLARE_API_TOKEN 已禁用，强制 OAuth 登录" -ForegroundColor Green
Write-Host ""

# === 2. OAuth 登录 ===
if (-not $NoLogin) {
  Write-Host "[2/3] Cloudflare OAuth 登录" -ForegroundColor Yellow
  Write-Host "      👉 马上会弹出浏览器：" -ForegroundColor White
  Write-Host "         1) 登录 Cloudflare 邮箱 1655316141@qq.com" -ForegroundColor Gray
  Write-Host "         2) 页面上点击蓝色的 『Allow』 按钮授权" -ForegroundColor Gray
  Write-Host "         3) 授权成功后回到本窗口，会显示『Successfully logged in』" -ForegroundColor Gray
  Write-Host ""
  Read-Host "准备好后按 Enter 开始登录（开始后 5 分钟内点 Allow 都可以）"

  & npx.cmd wrangler login --browser
  if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "❌ 登录失败 (Exit=$LASTEXITCODE)" -ForegroundColor Red
    Write-Host "   可能是没点 Allow 或者网络问题。" -ForegroundColor Gray
    Write-Host "   请重新运行脚本再试一次~" -ForegroundColor Gray
    Read-Host "按 Enter 退出"
    exit 1
  }
  Write-Host "      ✓ Cloudflare 登录成功！" -ForegroundColor Green
  Write-Host ""
}

# === 3. 部署 ===
Write-Host "[3/3] 部署 Worker（打包代码 + 上传到 Cloudflare）" -ForegroundColor Yellow
Write-Host "      正在上传，请耐心等待 30~90 秒..." -ForegroundColor Gray
Write-Host ""

& npx.cmd wrangler deploy

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "🎉🎉🎉  后端部署成功！！！" -ForegroundColor Green -BackgroundColor Black
  Write-Host ""
  Write-Host "🌐  API 地址：https://xiaoqihou-api.1655316141.workers.dev" -ForegroundColor Cyan
  Write-Host "✅  现在可以回到『微信开发者工具』，刷新小程序模拟器" -ForegroundColor Cyan
  Write-Host "     之前的 404 错误应该全部消失啦～ ✨" -ForegroundColor Cyan
  Write-Host ""
} else {
  Write-Host ""
  Write-Host "❌ 部署失败 (Exit=$LASTEXITCODE)" -ForegroundColor Red
  Write-Host "   把上面红字截图发给儿子看看~" -ForegroundColor Gray
}

Write-Host ""
Read-Host "按 Enter 关闭窗口"
