#!/usr/bin/env bash
# =====================================================================
#  考公刷题 - WSL/Linux 快速启动器
#
#  用法:
#    ./start.sh               # 端口 3000（默认）
#    ./start.sh 3001          # 指定端口
#    ./start.sh --public      # 本地服务 + Cloudflare Tunnel 一起起（公网可访问）
#    ./start.sh -y            # 端口被占用时自动往后换（3000 → 3001 → …）
#    ./start.sh --no-open     # 不自动打开浏览器
#    ./start.sh --no-reassemble  # 缺 tiku.db 时不自动重组，直接报错退出
#    可自由组合，如：./start.sh 8080 --public
#
#  公网模式（--public）：
#    - 读 CLOUDFLARED_CONFIG（默认 ~/.cloudflared/config.yml），自动取配置里的
#      hostname 与转发端口，server 就起在那个端口上，Tunnel 转发到同一端口
#    - 按 Ctrl+C 时本地服务与 Tunnel 一并停止
#    - 可用 CLOUDFLARED_BIN 覆盖 cloudflared 二进制路径
#
#  首次克隆：脚本会自动用 tools/reassemble-tiku.mjs 重组 tiku.db（自带 MD5 校验）。
#  按 Ctrl+C 停止服务（等价于 Windows 版 启动.bat 的“关窗口即停”）。
# =====================================================================
set -u

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" || exit 1

# ---------- 参数 ----------
PORT=3000
AUTO_PORT=0
OPEN=1
NO_RE=0
PUBLIC=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--auto-port) AUTO_PORT=1 ;;
    --no-open)      OPEN=0 ;;
    --public)       PUBLIC=1 ;;
    --no-reassemble) NO_RE=1 ;;
    *)
      if [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; then
        PORT="$1"
      else
        echo "❓ 未知参数: $1"
        echo "   用法: ./start.sh [端口] [--public] [-y] [--no-open] [--no-reassemble]"
        exit 1
      fi
      ;;
  esac
  shift
done

# ---------- 工具函数 ----------

# node 是否可用；fnm 安装时若当前 shell 未加载 env 则尝试补上
ensure_node() {
  if ! command -v node >/dev/null 2>&1; then
    if command -v fnm >/dev/null 2>&1; then
      eval "$(fnm env 2>/dev/null)" 2>/dev/null
    elif [ -f "$HOME/.bashrc" ]; then
      # .bashrc 里可能带 fnm/nvm 的 env hook
      eval "$(sed -n '/fnm\|nvm/p' "$HOME/.bashrc")" 2>/dev/null
    fi
  fi
  command -v node >/dev/null 2>&1 \
    || { echo "❌ 未找到 Node.js。请先安装 ≥ 22.5：https://nodejs.org/（或用 fnm install 22）"; exit 1; }
}

# node 版本 >= 22.5（server.mjs 用了 node:sqlite）
node_ok() {
  node -e \
    'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=5)?0:1)' \
    2>/dev/null
}

# 端口是否被占用（用 ss，避免依赖 netstat/lsof）
port_busy() {
  [ "$1" -ge 1 ] 2>/dev/null || return 1
  ss -tlnH 2>/dev/null | awk '{print $4}' | grep -qE "[^0-9]$1\$"
}

# 挑选浏览器开启器（WSL 优先 explorer.exe，纯 Linux 桌面用 xdg-open）
pick_opener() {
  if command -v explorer.exe >/dev/null 2>&1; then OPENER="explorer.exe"
  elif command -v wslview >/dev/null 2>&1; then OPENER="wslview"
  elif command -v xdg-open >/dev/null 2>&1; then OPENER="xdg-open"
  elif command -v sensible-browser >/dev/null 2>&1; then OPENER="sensible-browser"
  else OPENER=""
  fi
}

# 缺 tiku.db → 自动从分卷重组（首次克隆）
reassemble_if_needed() {
  [ -f tiku.db ] && return 0
  if [ "$NO_RE" -eq 1 ]; then
    echo "❌ 缺少 tiku.db。请先运行: node tools/reassemble-tiku.mjs"
    exit 1
  fi
  echo "⏳ 未找到 tiku.db（题库），正在从 tiku.db.part-* 分卷重组…"
  echo "   仅首次需要，请稍候（含 MD5 自校验）。"
  if ! node tools/reassemble-tiku.mjs; then
    echo "❌ 重组失败。请检查分卷是否齐全（tiku.db.part-00..03），必要时重新 git clone。"
    exit 1
  fi
}

# ---------- 前置检查 ----------
ensure_node
node_ok || { echo "❌ 当前 Node 版本过低：$(node --version)，server.mjs 需要 22.5+。"; exit 1; }

reassemble_if_needed

if [ ! -f tiku-index.db ]; then
  echo "⚠️  缺少 tiku-index.db（派生索引随仓库分发）。"
  echo "   请确认已完整 git clone 本仓库（勿用第三方下载工具）；"
  echo "   若已有 tiku.db 也可重建：node tools/build-index-db.mjs"
  read -r -p "   仍要尝试启动吗? [y/N] " ans
  case "$ans" in [yY]*) ;; *) exit 1 ;; esac
fi

# =====================================================================
#  公网模式：server + Cloudflare Tunnel 一起起、一起停
# =====================================================================
if [ "$PUBLIC" -eq 1 ]; then
  CF="${CLOUDFLARED_CONFIG:-$HOME/.cloudflared/config.yml}"
  [ -f "$CF" ] || { echo "❌ 未找到 Tunnel 配置: $CF（可用 CLOUDFLARED_CONFIG 指定）"; exit 1; }

  # 从配置读对外域名与转发端口
  CONF_HOST="$(grep -E '[[:space:]]*hostname:[[:space:]]*' "$CF" | head -1 | sed -E 's/.*hostname:[[:space:]]*([^[:space:]]+).*/\1/')"
  TUN_PORT="$(grep -E 'service: http://localhost:[0-9]+' "$CF" | head -1 | sed -E 's/.*localhost:([0-9]+).*/\1/')"
  [ -n "$CONF_HOST" ] || { echo "❌ 配置里没找到 ingress hostname（应形如 '- hostname: 域名'）"; exit 1; }
  [ -n "$TUN_PORT" ] || TUN_PORT=3000

  # 服务端口必须以 tunnel 转发目标为准，否则公网映射不上
  if [ "$PORT" != "3000" ] && [ "$PORT" != "$TUN_PORT" ]; then
    echo "⚠️  你指定的端口 $PORT 与 tunnel 转发目标 $TUN_PORT 不一致；"
    echo "   公网域名只会映射到 $TUN_PORT，改用 $TUN_PORT 启动。"
  fi
  PORT="$TUN_PORT"
  if port_busy "$PORT"; then
    echo "❌ 端口 $PORT 已被占用。公网映射固定指向 $PORT，请先释放该端口。"
    echo "   （或改 $CF 里 service 的端口后再跑）"
    exit 1
  fi

  CFBIN="${CLOUDFLARED_BIN:-}"
  [ -n "$CFBIN" ] || CFBIN="$(command -v cloudflared || true)"
  [ -n "$CFBIN" ] || CFBIN="$HOME/bin/cloudflared"
  [ -x "$CFBIN" ] || { echo "❌ 找不到 cloudflared 可执行文件（可用 CLOUDFLARED_BIN 指定路径）"; exit 1; }

  TLOG="${TMPDIR:-/tmp}/kaogong-cloudflared.log"
  : > "$TLOG"

  # 起服务与 tunnel（后台），前台阻塞等待任一退出
  node server.mjs "$PORT" &
  SERVER_PID=$!
  "$CFBIN" tunnel --config "$CF" run >"$TLOG" 2>&1 &
  TUNNEL_PID=$!

  cleanup() {
    kill "$SERVER_PID" "$TUNNEL_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
    wait "$TUNNEL_PID" 2>/dev/null
    echo ""
    echo "已停止：本地服务与 Tunnel 均已关闭。"
  }
  trap 'cleanup; exit 130' INT TERM

  echo
  echo "  ✅ 本地服务启动中 → http://localhost:$PORT"
  echo "  🌐 公网地址 → https://$CONF_HOST"
  echo "  （Tunnel 日志：$TLOG）"
  echo "  按 Ctrl+C 同时停止服务与 Tunnel"
  echo

  # 等服务端口就绪
  for _ in $(seq 1 30); do
    port_busy "$PORT" && break
    sleep 0.3
  done
  port_busy "$PORT" || {
    echo "❌ 服务未能在几秒内就绪（看上方 server 输出）。"
    cleanup; exit 1
  }
  echo "  ✅ 本地服务已就绪"

  # 自动打开公网地址
  if [ "$OPEN" -eq 1 ]; then
    pick_opener
    if [ -n "$OPENER" ]; then
      ( sleep 1; "$OPENER" "https://$CONF_HOST" >/dev/null 2>&1 & ) >/dev/null 2>&1 &
    fi
  fi

  # 简短验证公网可达（不致命，tunnel 可能还在握手）
  if command -v curl >/dev/null 2>&1; then
    code="" i=""
    for i in $(seq 1 6); do
      code="$(curl -sk -o /dev/null --max-time 3 -w '%{http_code}' "https://$CONF_HOST/" 2>/dev/null || true)"
      case "$code" in
        2[0-9][0-9]) break ;;          # 2xx = 真正可达
        530)          break ;;          # 530 = Cloudflare 边缘已通，origin 未连上（不再等）
        *)            code="" ;;        # 其它（000/502/…）→ 继续等
      esac
      sleep 1.5
    done
    case "$code" in
      2[0-9][0-9]) echo "  ✅ 公网已可达（HTTP $code）" ;;
      530)         echo "  ⚠️  公网边缘已通，但 origin 未就绪（HTTP 530）——tunnel 可能还在连接中" ;;
      *)           echo "  ⚠️  公网暂未确认（tunnel 可能在启动中；稍后浏览器刷新即可）" ;;
    esac
  fi

  # 前台阻塞：server 退出（Ctrl+C / 崩溃）后收尾
  wait "$SERVER_PID"
  SRV=$?
  cleanup
  exit "$SRV"
fi

# ---------- 普通模式：端口确认 ----------
port_busy "$PORT" || true
while port_busy "$PORT"; do
  echo "⚠️  端口 $PORT 已被占用。"
  if [ "$AUTO_PORT" -eq 1 ]; then
    PORT=$((PORT + 1))
    [ "$PORT" -le 3010 ] || { echo "   ❌ 3000–3010 都在占用，请手动指定端口。"; exit 1; }
    echo "   自动换用 $PORT"
  else
    read -r -p "   输入新端口（回车用 $((PORT+1))，输 0 退出）: " np
    if [ -z "$np" ]; then
      PORT=$((PORT + 1))
    elif [ "$np" = "0" ]; then
      echo "   已取消启动。"; exit 1
    elif [[ "$np" =~ ^[0-9]+$ ]] && [ "$np" -ge 1 ] && [ "$np" -le 65535 ]; then
      PORT="$np"
    else
      echo "   非法输入：$np，换用 $((PORT+1))"
      PORT=$((PORT + 1))
    fi
  fi
done

# ---------- 启动（普通模式） ----------
if [ "$OPEN" -eq 1 ]; then
  pick_opener
  if [ -n "$OPENER" ]; then
    # 后台延时 1.5s 再开浏览器，别抢在服务就绪前
    ( sleep 1.5; "$OPENER" "http://localhost:$PORT" >/dev/null 2>&1 & ) >/dev/null 2>&1 &
  fi
fi

echo
echo "  ✅ 考公刷题 正在启动 → http://localhost:$PORT"
LAN="$(hostname -I 2>/dev/null | awk '{print $1}')";
[ -n "$LAN" ] && echo "  📱 局域网访问（手机连同一 WiFi）: http://$LAN:$PORT"
[ "$OPEN" -eq 1 ] && [ -z "$OPENER" ] && echo "  🔗 未检测到图形环境，请手动打开浏览器访问上面的地址"
echo "  按 Ctrl+C 停止服务"
echo

exec node server.mjs "$PORT"