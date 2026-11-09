#!/usr/bin/env bash
set -e

DISPLAY_NUM="${DISPLAY:-:99}"
RESOLUTION="${RESOLUTION:-1280x720}"
FPS="${FPS:-60}"
BITRATE="${BITRATE:-3000k}"
MAXRATE="${MAXRATE:-3500k}"
SESSION_ID="${SESSION_ID:-session-$(cat /proc/sys/kernel/random/uuid | cut -c1-8)}"
SIGNALING_URL="${SIGNALING_URL:-ws://host.docker.internal:8080/ws/agent}"
STUN_SERVER="${STUN_SERVER:-stun:stun.l.google.com:19302}"

echo "=================================================="
echo " Starting NebulaStream Container Runner"
echo " Session ID:      ${SESSION_ID}"
echo " Display:         ${DISPLAY_NUM} (${RESOLUTION}@${FPS}fps)"
echo " Signaling URL:   ${SIGNALING_URL}"
echo "=================================================="

# 1. Initialize Display Server
export DISPLAY="${DISPLAY_NUM}"
echo "[Display] Launching headless display server on ${DISPLAY_NUM}..."

# Try Xorg with dummy driver first, fallback to Xvfb
if command -v Xorg >/dev/null 2>&1 && [ -f /etc/X11/xorg.conf ]; then
    Xorg -noreset +extension GLX +extension RANDR +extension RENDER -config /etc/X11/xorg.conf "${DISPLAY_NUM}" >/dev/null 2>&1 &
    X_PID=$!
else
    echo "[Display] Falling back to Xvfb..."
    Xvfb "${DISPLAY_NUM}" -screen 0 "${RESOLUTION}x24" >/dev/null 2>&1 &
    X_PID=$!
fi

# Wait for X server to be ready
echo -n "[Display] Waiting for display to initialize..."
for i in $(seq 1 30); do
    if xdpyinfo -display "${DISPLAY_NUM}" >/dev/null 2>&1; then
        echo " Ready!"
        break
    fi
    sleep 0.1
done

# 2. Initialize PulseAudio Virtual Audio Sink
echo "[Audio] Starting virtual audio daemon..."
pulseaudio -D --exit-idle-time=-1 --disallow-exit >/dev/null 2>&1 || true
pactl load-module module-null-sink sink_name=GameAudio sink_properties=device.description=GameAudio >/dev/null 2>&1 || true
pactl set-default-sink GameAudio >/dev/null 2>&1 || true

# 3. Launch Target Application or Default OpenGL Test Pattern
if [ -n "${GAME_COMMAND}" ]; then
    echo "[App] Launching custom game: ${GAME_COMMAND}"
    eval "${GAME_COMMAND}" &
    APP_PID=$!
else
    echo "[App] No GAME_COMMAND specified. Launching default OpenGL benchmark (glxgears)..."
    glxgears -geometry "${RESOLUTION}" -fullscreen >/dev/null 2>&1 &
    APP_PID=$!
fi

# 4. Detect Encoder (NVIDIA NVENC vs CPU libx264 fallback)
ENCODER="libx264"
EXTRA_FLAGS="-preset ultrafast -tune zerolatency"

if ffmpeg -encoders 2>/dev/null | grep -q "h264_nvenc"; then
    if nvidia-smi >/dev/null 2>&1; then
        echo "[Encoder] NVIDIA GPU and h264_nvenc detected. Enabling hardware acceleration!"
        ENCODER="h264_nvenc"
        EXTRA_FLAGS="-preset p1 -tune zerolatency -surfaces 1 -delay 0 -forced-idr 1"
    else
        echo "[Encoder] h264_nvenc compiled but GPU not reachable. Using libx264."
    fi
else
    echo "[Encoder] Using CPU libx264 software encoder."
fi

# 5. Launch FFmpeg off-screen capture pipeline
echo "[Encoder] Starting FFmpeg capture on ${DISPLAY_NUM}.0 -> RTP UDP 127.0.0.1:5004"
ffmpeg -hide_banner -loglevel warning \
    -f x11grab -draw_mouse 0 -framerate "${FPS}" -video_size "${RESOLUTION}" -i "${DISPLAY_NUM}.0" \
    -c:v "${ENCODER}" ${EXTRA_FLAGS} -profile:v baseline \
    -b:v "${BITRATE}" -maxrate "${MAXRATE}" -bufsize 300k \
    -g "${FPS}" -keyint_min "${FPS}" \
    -payload_type 96 -f rtp rtp://127.0.0.1:5004 &
FFMPEG_PID=$!

# 6. Launch Pion WebRTC Agent
echo "[Agent] Starting Pion WebRTC Agent..."
/app/agent \
    -session="${SESSION_ID}" \
    -signaling="${SIGNALING_URL}" \
    -rtp-port=5004 \
    -stun="${STUN_SERVER}" &
AGENT_PID=$!

# Trap signals and shut down gracefully
cleanup() {
    echo "[NebulaStream] Received shutdown signal. Terminating child processes..."
    kill -TERM "${AGENT_PID}" 2>/dev/null || true
    kill -TERM "${FFMPEG_PID}" 2>/dev/null || true
    kill -TERM "${APP_PID}" 2>/dev/null || true
    kill -TERM "${X_PID}" 2>/dev/null || true
    wait
    echo "[NebulaStream] All processes terminated."
    exit 0
}

trap cleanup SIGINT SIGTERM

# Keep entrypoint alive waiting on agent
wait "${AGENT_PID}"

