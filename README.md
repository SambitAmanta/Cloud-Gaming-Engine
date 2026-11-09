# 🚀 NebulaStream: Distributed Cloud Gaming & Real-Time Streaming Engine

[![Go Version](https://img.shields.io/badge/Go-1.22-00ADD8?style=flat&logo=go)](https://golang.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?style=flat&logo=typescript)](https://www.typescriptlang.org)
[![WebRTC](https://img.shields.io/badge/WebRTC-Pion-FFA500?style=flat&logo=webrtc)](https://pion.ly)
[![Docker](https://img.shields.io/badge/Docker-Engine%20SDK-2496ED?style=flat&logo=docker)](https://www.docker.com)
[![NVIDIA](https://img.shields.io/badge/NVIDIA-NVENC%20%2F%20CUDA-76B900?style=flat&logo=nvidia)](https://developer.nvidia.com/nvidia-video-codec-sdk)
[![Redis](https://img.shields.io/badge/Redis-Cluster%20%2F%20PubSub-DC382D?style=flat&logo=redis)](https://redis.io)

**NebulaStream** is an end-to-end, ultra-low-latency distributed cloud gaming and media streaming engine. It provisions isolated, hardware-accelerated Linux execution containers on-demand, captures and encodes virtual framebuffers at 60 FPS using NVIDIA NVENC, streams viewports to web browsers over WebRTC (SRTP/UDP) at **sub-100ms glass-to-glass latency**, and routes bidirectional player inputs directly into the Linux kernel via `/dev/uinput` over raw binary DataChannels.

---

## 📑 Table of Contents
1. [Core Engineering Narrative](#-core-engineering-narrative)
2. [End-to-End Latency Budget (< 100ms)](#-end-to-end-latency-budget--100ms)
3. [System Architecture](#-system-architecture)
4. [Subsystem Deep Dives](#-subsystem-deep-dives)
   - [In-Container Pion WebRTC Agent (Go)](#1-in-container-pion-webrtc-agent-go)
   - [Hardware Video Encoding Pipeline (FFmpeg + NVENC)](#2-hardware-video-encoding-pipeline-ffmpeg--nvenc)
   - [High-Frequency Binary Input Subsystem (`/dev/uinput`)](#3-high-frequency-binary-input-subsystem-devuinput)
   - [Signaling Server & Container Orchestration](#4-signaling-server--container-orchestration)
   - [Distributed State & Ephemeral Heartbeat Reaper](#5-distributed-state--ephemeral-heartbeat-reaper)
   - [Cyberpunk Web Player Client](#6-cyberpunk-web-player-client)
5. [Multi-Tenant GPU Slicing on NVIDIA RTX 5050 (8GB VRAM)](#-multi-tenant-gpu-slicing-on-nvidia-rtx-5050-8gb-vram)
6. [Repository Structure](#-repository-structure)
7. [Getting Started & Local Setup](#-getting-started--local-setup)
8. [Benchmarking & Profiling Guide](#-benchmarking--profiling-guide)
9. [Systems & Networking Interview Defense](#-systems--networking-interview-defense)

---

## 🧠 Core Engineering Narrative

Most web applications live in the high-latency realm of HTTP/REST, TCP connections, and stateless CRUD databases. NebulaStream operates at the bleeding edge of distributed systems and network engineering:

* **Eliminating Head-of-Line Blocking**: Traditional video streaming protocols (HLS, DASH) rely on TCP chunking and introduce 2 to 6 seconds of latency. NebulaStream routes video over **UDP using WebRTC SRTP**, discarding dropped stale frames instantly without stalling the stream.
* **Kernel-Level Input Injection**: Bypasses slow CLI utilities (like `xdotool`) and window-manager event queues by dispatching raw packets directly to Linux kernel virtual input drivers (`/dev/uinput`).
* **Zero-Allocation Binary Wire Format**: Replaces bloated JSON payloads with an aligned **9-byte binary struct** delivered over unordered WebRTC DataChannels at 60–120Hz.
* **Multi-Tenant GPU Density & Admission Control**: Implements VRAM budgeting on consumer GPUs (NVIDIA RTX 5050 8GB) to safely multiplex 3–4 concurrent 3D game containers without host-wide GPU Out-Of-Memory (OOM) crashes.

---

## ⏱️ End-to-End Latency Budget (< 100ms)

To achieve an imperceptible interactive loop, the cumulative time for user input capture, network round trip, frame rendering, encoding, and client presentation must remain strictly under **100ms** (typically 50–80ms on broadband/LAN):

```
Client Input ──► Network (DataChannel) ──► Kernel uinput ──► Game Simulation Tick
  [2-4ms]                 [10-20ms]               [1-2ms]              [16.6ms @ 60 FPS]
                                                                               │
Client Display ◄── HW Decode / Jitter ◄── Network (SRTP) ◄── NVENC Hardware Encode
  [1-2ms]                 [8-14ms]                [10-20ms]            [4-8ms @ 720p/1080p]
```

| Pipeline Stage | Target Latency | Optimization Mechanism |
| :--- | :--- | :--- |
| **Input Capture & Serialization** | 2 – 4 ms | HTML5 Pointer Lock API; zero-allocation 9-byte `ArrayBuffer` |
| **Input Transit (DataChannel)** | 10 – 20 ms | WebRTC SCTP DataChannel (`ordered: false`, `maxRetransmits: 0`) |
| **Kernel Injection (`/dev/uinput`)** | 1 – 2 ms | Native Linux `ioctl` and `write` to `/dev/uinput` via static Go binary |
| **Game Simulation & Render** | 16.6 ms | Locked 60 FPS physics/render loop on off-screen virtual framebuffer |
| **Capture & Hardware Encode** | 4 – 8 ms | Direct X11 framebuffer grab piped to `h264_nvenc` (`-preset p1 -tune zerolatency -delay 0`) |
| **Media Network Transit (SRTP)** | 10 – 20 ms | UDP transport bypassing TCP head-of-line blocking; direct peer-to-peer |
| **Client Decode & Presentation** | 8 – 14 ms | Hardware-accelerated browser WebCodecs / HTML5 `<video>` decode pipeline |
| **Total Glass-to-Glass** | **~51 – 84 ms** | **Comfortably sub-100ms interactive threshold** |

---

## 🏛️ System Architecture

```mermaid
flowchart TB
    subgraph Client ["Client Browser (Zero Plugin)"]
        UI["Web Player SPA (HTML5 / CSS3)"]
        Vid["HTML5 Video Player"]
        InMgr["InputManager (Pointer Lock & Keycodes)"]
        Hud["WebRTC Stats HUD (getStats)"]
    end

    subgraph Edge ["Signaling & Orchestration Layer"]
        WS["Signaling Gateway (Node.js/TS Express + ws)"]
        Orch["Container Orchestrator (Docker Engine SDK)"]
        State["Session State & 15s Heartbeat Reaper"]
        Redis[("Redis Cluster (Session State & Pub/Sub)")]
    end

    subgraph Host ["GPU Host Machine (NVIDIA RTX 5050 8GB)"]
        Docker["Docker Engine API (nvidia-container-runtime)"]

        subgraph Container ["Ephemeral Game Runner Container"]
            Xorg["Headless Xorg Server (Dummy Video Driver :99)"]
            Pulse["PulseAudio (Virtual null-sink GameAudio)"]
            Game["Game Process / 3D Benchmark (OpenGL)"]
            FFmpeg["FFmpeg NVENC Hardware Encoder"]
            Agent["Pion WebRTC Agent (Static Go Daemon)"]
            Uinput["Linux /dev/uinput Virtual Mouse & Keyboard"]
        end
    end

    %% Signaling Handshake
    UI <-->|"WebSocket: SDP Offer/Answer & ICE"| WS
    WS <--> State
    State <--> Redis
    WS -->|"Spawn / Destroy"| Orch
    Orch -->|"Unix Socket / Named Pipe"| Docker
    Docker -.->|"Provisions Container"| Container

    %% Media & Input Loop
    Agent ==>|"WebRTC SRTP: H.264 Video Stream (UDP)"| Vid
    InMgr ==>|"WebRTC DataChannel: 9-Byte Binary Packets (UDP)"| Agent
    
    %% In-Container Piping
    Game -->|"Renders 60 FPS"| Xorg
    Pulse -->|"Audio Monitor"| FFmpeg
    Xorg -->|"Raw Frame Grab"| FFmpeg
    FFmpeg -->|"H.264 RTP Stream (UDP :5004)"| Agent
    Agent -->|"Deserialized Input Events"| Uinput
    Uinput -->|"Virtual Hardware Input"| Xorg
    Hud -.->|"Polls stats every 1s"| Vid
```

---

## 🔬 Subsystem Deep Dives

### 1. In-Container Pion WebRTC Agent (Go)
* **Path**: [`services/agent/`](file:///d:/MyStorage/PROJECTS/Cloud_Gaming_Engine/services/agent/)
* **Role**: Acts as the in-container WebRTC peer endpoint.
* **Why Pion (Go)?**
  * Compiles to a self-contained, statically linked binary (~15MB) with zero runtime dependencies.
  * Eliminates garbage collection stalls and GIL bottlenecks seen in Python (`aiortc`) or Node.js.
  * Direct memory access to raw UDP RTP sockets.
* **Core Responsibilities**:
  * Ingests local H.264 RTP packets generated by FFmpeg over UDP port `127.0.0.1:5004`.
  * Forwards video packets to the client peer connection via `webrtc.TrackLocalStaticRTP`.
  * Listens on the unordered WebRTC DataChannel (`input`), decodes raw binary packets, and sends them to the input dispatcher.
  * Connects to the signaling gateway WebSocket to exchange SDP Offer/Answer and trickle ICE candidates.

### 2. Hardware Video Encoding Pipeline (FFmpeg + NVENC)
* **Path**: [`docker/entrypoint.sh`](file:///d:/MyStorage/PROJECTS/Cloud_Gaming_Engine/docker/entrypoint.sh)
* **Role**: Captures virtual display frames and compresses them with minimal latency.
* **NVENC Zero-Latency Command**:
  ```bash
  ffmpeg -hide_banner -loglevel warning \
    -f x11grab -draw_mouse 0 -framerate 60 -video_size 1280x720 -i :99.0 \
    -c:v h264_nvenc \
    -preset p1 \
    -tune zerolatency \
    -profile:v baseline \
    -b:v 3000k -maxrate 3500k -bufsize 300k \
    -g 60 -keyint_min 60 -forced-idr 1 \
    -surfaces 1 -delay 0 \
    -payload_type 96 -f rtp rtp://127.0.0.1:5004
  ```
* **Critical Tuning Flags**:
  * `-preset p1`: Fastest NVENC hardware encoding preset (lowest latency).
  * `-tune zerolatency` & `-delay 0`: Completely disables B-frame reordering and encoder lookahead buffering.
  * `-surfaces 1`: Restricts NVENC to a single internal encoding surface to prevent frame queuing.
  * `-bufsize 300k`: Constrains the VBV buffer to prevent bitrate spikes from causing network queueing delays.
  * **Fallback**: Auto-detects if NVIDIA NVENC is unavailable and gracefully falls back to CPU `libx264 -preset ultrafast -tune zerolatency`.

### 3. High-Frequency Binary Input Subsystem (`/dev/uinput`)
* **Path**: [`services/agent/input/`](file:///d:/MyStorage/PROJECTS/Cloud_Gaming_Engine/services/agent/input/) & [`services/client/src/protocol.js`](file:///d:/MyStorage/PROJECTS/Cloud_Gaming_Engine/services/client/src/protocol.js)
* **Wire Protocol**: Input events are serialized into a strict **9-byte binary struct**:
  ```
  Byte 0:     Opcode (0x01: KeyDown, 0x02: KeyUp, 0x03: MouseMove, 0x04: MouseDown, 0x05: MouseUp, 0x06: Wheel)
  Bytes 1-2:  Code (uint16 Little-Endian: Linux keycode or mouse button)
  Bytes 3-4:  DeltaX (int16 Little-Endian: relative mouse X movement)
  Bytes 5-6:  DeltaY (int16 Little-Endian: relative mouse Y movement)
  Bytes 7-8:  Extra (int16 Little-Endian: wheel delta or reserved flags)
  ```
* **Kernel Integration**:
  * The Pion agent opens `/dev/uinput` inside the container using `ioctl` calls to register virtual USB keyboard and relative mouse devices (`EV_KEY`, `EV_REL`, `REL_X`, `REL_Y`).
  * Relative mouse movements are injected via `REL_X` and `REL_Y` without requiring screen coordinate mapping, fully supporting 3D first-person camera controls.

### 4. Signaling Server & Container Orchestration
* **Path**: [`services/signaling-orchestrator/`](file:///d:/MyStorage/PROJECTS/Cloud_Gaming_Engine/services/signaling-orchestrator/)
* **Role**: Coordinates WebRTC handshakes and manages container lifecycles via the Docker Engine API.
* **Features**:
  * **On-Demand Spin-up**: When a client requests a session, the orchestrator invokes the Docker Engine SDK to spawn a new container passing `--gpus all`, `/dev/uinput`, and container networking.
  * **Admission Control**: Tracks active container allocations to prevent overloading the 8GB GPU VRAM.

### 5. Distributed State & Ephemeral Heartbeat Reaper
* **Path**: [`services/signaling-orchestrator/src/state.ts`](file:///d:/MyStorage/PROJECTS/Cloud_Gaming_Engine/services/signaling-orchestrator/src/state.ts)
* **Mechanism**:
  * Active sessions are registered in Redis with TTLs and mapped to container IDs.
  * The browser client pulses a `heartbeat` message every 5 seconds.
  * A background **Reaper loop** runs every 5 seconds. If a session fails to pulse a heartbeat within **15 seconds** (e.g., closed browser tab, crashed network), the orchestrator immediately terminates and prunes the container to free GPU VRAM.

### 6. Cyberpunk Web Player Client
* **Path**: [`services/client/`](file:///d:/MyStorage/PROJECTS/Cloud_Gaming_Engine/services/client/)
* **Features**:
  * **HTML5 Pointer Lock API**: Locks the mouse cursor inside the player and streams continuous relative deltas (`e.movementX`, `e.movementY`).
  * **Live WebRTC Metrics HUD**: Periodically interrogates `RTCPeerConnection.getStats()` to display real-time **Round Trip Time (RTT), Stream FPS, Bitrate (Mbps), Resolution, and Packet Loss**.
  * **Low-Latency Transport**: Connects using an unordered, zero-retransmission SCTP DataChannel.

---

## 🎯 Multi-Tenant GPU Slicing on NVIDIA RTX 5050 (8GB VRAM)

Running multiple interactive 3D container environments on a single 8GB consumer GPU requires careful resource budgeting:

```
Total RTX 5050 VRAM: 8192 MB
├── Host OS & Display Overhead:      ~800 MB
└── Usable Container Budget:         ~7300 MB
     ├── Session Container 1:        ~1800 MB (Xorg + Game + NVENC)
     ├── Session Container 2:        ~1800 MB (Xorg + Game + NVENC)
     ├── Session Container 3:        ~1800 MB (Xorg + Game + NVENC)
     └── Safe Buffer / Headroom:     ~1900 MB
```

### Engineering Mitigations
1. **Admission Controller**: The provisioning service strictly limits concurrent sessions to **3 active containers** (`MAX_CONCURRENT_CONTAINERS=3`). Incoming requests beyond capacity are rejected or queued.
2. **NVENC Concurrency Limits**: Consumer NVIDIA drivers enforce a limit on concurrent hardware encoding sessions (typically 3–5 streams). NebulaStream includes an automatic fallback to CPU `libx264` if hardware encoder initialization fails.
3. **Headless Dummy Display**: Off-screen Xorg instances run with a 24-bit 1280x720 dummy driver, consuming under 64MB of VRAM for the framebuffer itself.

---

## 📂 Repository Structure

```
Cloud_Gaming_Engine/
├── project_analysis.md                  # Comprehensive architectural requirements & interview guide
├── README.md                            # Complete technical documentation
├── docker-compose.yml                   # Redis + Signaling & Orchestrator Gateway services
├── docker/
│   ├── Dockerfile.runner                # Multi-stage image (Go builder + Ubuntu Xorg/NVENC runner)
│   ├── xorg.conf                        # Headless 1080p/720p 60Hz dummy display configuration
│   └── entrypoint.sh                    # Container process supervisor & hardware detection
├── scripts/
│   ├── build-runner.ps1                 # Automated image build script (PowerShell)
│   └── build-runner.sh                  # Automated image build script (Bash)
├── services/
│   ├── agent/                           # In-Container WebRTC & Input Daemon (Go)
│   │   ├── go.mod                       # Go dependencies (Pion WebRTC v4, Gorilla WebSocket)
│   │   ├── main.go                      # WebRTC PeerConnection, RTP UDP forwarder, DataChannel listener
│   │   ├── protocol/
│   │   │   └── protocol.go              # 9-byte binary wire protocol definition
│   │   └── input/
│   │       ├── driver.go                # Input driver interface & dispatcher
│   │       ├── uinput_linux.go          # Linux kernel /dev/uinput virtual device handler
│   │       └── uinput_stub.go           # Non-Linux mock fallback
│   ├── signaling-orchestrator/          # Signaling Gateway & Ephemeral Container Orchestrator
│   │   ├── Dockerfile                   # Node.js production image
│   │   ├── package.json                 # Dependencies (dockerode, ws, ioredis, express)
│   │   ├── tsconfig.json                # TypeScript compiler configuration
│   │   └── src/
│   │       ├── index.ts                 # Express HTTP server + WebSocket upgrade + static player host
│   │       ├── docker.ts                # Docker Engine SDK integration & GPU admission controller
│   │       ├── state.ts                 # Redis session state machine & 15s heartbeat reaper
│   │       ├── signaling.ts             # WebRTC SDP Offer/Answer & trickle ICE candidate broker
│   │       └── types.ts                 # Shared message and session interfaces
│   └── client/                          # Zero-Plugin Web Player Web Application
│       ├── index.html                   # Cyberpunk-styled player interface with live HUD
│       └── src/
│           ├── player.js                # WebRTC connection coordinator & getStats() monitor
│           ├── input.js                 # HTML5 Pointer Lock API & keyboard listeners
│           └── protocol.js              # JavaScript 9-byte binary packet serializer
```

---

## 🚀 Getting Started & Local Setup

### Prerequisites
* **Docker Engine** (v24+ recommended with Compose V2 support).
* **NVIDIA GPU** (e.g. RTX 5050 / RTX 3060 / 4060) with latest NVIDIA drivers.
* **NVIDIA Container Toolkit** (`nvidia-container-toolkit`) installed for GPU passthrough.
* Modern web browser (Chrome, Edge, Firefox, Brave) with WebRTC support.

### Step 1: Build the Container Runner Image
From the project root directory, build the `nebulastream-runner:latest` container:

```bash
# On Windows (PowerShell)
./scripts/build-runner.ps1

# On Linux / macOS
chmod +x ./scripts/build-runner.sh
./scripts/build-runner.sh
```

### Step 2: Start Redis & the Signaling Gateway
Launch the background orchestration infrastructure:

```bash
docker compose up -d
```

To run the signaling service in live TypeScript development mode instead:
```bash
cd services/signaling-orchestrator
npm install
npm run dev
```

### Step 3: Launch the Web Player & Play
1. Open your browser and navigate to: **`http://localhost:8080`**
2. Click **"Start Game Session"**.
3. Watch the logs as the orchestrator spawns an isolated container on your GPU, initializes headless Xorg and FFmpeg NVENC, negotiates WebRTC, and delivers 60 FPS video.
4. Click on the video container to engage **Pointer Lock**. Use **WASD** and mouse movements to interact with the game instance.
5. Inspect the top-right **Metrics HUD** to monitor live RTT latency, stream FPS, bitrate, and packet loss.

### Step 4: Running Custom Games
To launch a custom game instead of the default `glxgears` benchmark, specify the `GAME_COMMAND` environment variable when spawning the container:
```bash
docker run -d --gpus all \
  --device /dev/uinput \
  -e GAME_COMMAND="/usr/games/neverball" \
  nebulastream-runner:latest
```

---

## 📊 Benchmarking & Profiling Guide

### 1. Measuring End-to-End Glass-to-Glass Latency
* **Screen Timer Test**: Display a millisecond stopwatch inside the game container. Record the client screen and the source side-by-side using a 120 FPS / 240 FPS smartphone camera. Subtract the source time from the displayed time.
* **Internal RTT**: Inspect the `RTT Latency` readout in the player's top-right HUD, which tracks WebRTC ICE candidate pair round-trip time.

### 2. Monitoring Host GPU VRAM & NVENC Utilization
While running active sessions, monitor GPU resource slicing in real time:
```bash
watch -n 1 nvidia-smi --query-gpu=utilization.gpu,utilization.encoder,memory.used,memory.total --format=csv
```

---

## 💼 Systems & Networking Interview Defense

When presenting this project in technical interviews, here are the architectural defenses and system design rationales:

### Q1: Why WebRTC over UDP instead of WebSockets or HTTP Chunking?
> *"WebSockets operate over TCP, which guarantees in-order packet delivery. If a single packet drops on a congested network, TCP halts subsequent packet delivery (Head-of-Line blocking) while waiting for retransmissions. In real-time interactive gaming, a dropped frame is instantly stale—waiting for it ruins latency. WebRTC operates over UDP with SRTP, allowing us to drop lost frames immediately and request a Picture Loss Indication (PLI) refresh without interrupting the stream."*

### Q2: How do you handle cold-start container spin-up latency?
> *"A cold container creation with X11 initialization and game loading takes 3–5 seconds. To achieve sub-second response times, we implement a **Pre-Warmed Standby Pool** in Redis. The orchestrator maintains 1 idle, initialized container. When a user arrives, they attach immediately (<300ms), and the orchestrator asynchronously replenishes the standby container in the background."*

### Q3: Why use `/dev/uinput` instead of high-level tools like `xdotool`?
> *"`xdotool` forks a new process per keystroke or mouse event, introducing high CPU overhead and unacceptable latency at 60–120Hz. Furthermore, `xdotool` requires absolute coordinate mapping and fails inside 3D games where the cursor is locked and camera navigation depends on raw relative deltas (`movementX`, `movementY`). By writing directly to `/dev/uinput` via Linux kernel `ioctl` calls, our Go agent injects events at the hardware driver level in microseconds."*

### Q4: How do you prevent multi-tenant noisy-neighbor GPU crashes?
> *"On consumer GPUs like the 8GB RTX 5050, uncontrolled container provisioning will trigger GPU Out-Of-Memory (OOM) errors and crash the NVIDIA driver. We implemented an admission controller in the orchestrator that tracks active VRAM allocations in Redis. We budget ~1.8GB per 720p/1080p container and cap concurrency at 3 active containers, rejecting or queueing excess requests before they reach the Docker daemon."*

---

## 📄 License
This project is open-source under the [MIT License](LICENSE).
