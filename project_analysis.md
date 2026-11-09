# NebulaStream: Distributed Cloud Gaming & Real-Time Streaming Engine
## System Architecture, Technical Requirements & Engineering Deep-Dive

---

## 1. Executive Summary & Core Engineering Narrative

**NebulaStream** is a distributed, ultra-low-latency cloud gaming platform designed to run graphics-intensive game loops inside isolated, ephemeral Linux containers and stream the rendered viewport to browser clients via WebRTC at **sub-100ms glass-to-glass latency**.

### Why This Wins in Systems Engineering Interviews
Most portfolio full-stack applications are standard CRUD apps over HTTP/REST with a database. NebulaStream operates at the bleeding edge of:
- **Low-Level Systems & Graphics**: Headless X11 display servers, NVIDIA Container Toolkit (`nvidia-docker`), GPU resource sharing/slicing, and hardware-accelerated video pipelines (NVENC).
- **Real-Time Network Transport**: UDP-based WebRTC (SRTP/SCTP), custom signaling over WebSockets, NAT traversal (STUN/TURN/ICE), and network jitter/congestion mitigation.
- **Concurrent & Distributed State Management**: Redis Pub/Sub for cross-node signaling, distributed room/session state machines, and dynamic container lifecycle orchestration.
- **High-Frequency Concurrency**: Real-time input serialization over binary DataChannels injected into the host/container input subsystem at 60–120Hz.

---

## 2. End-to-End Latency Budget (< 100ms Glass-to-Glass)

To deliver an interactive, lag-free gaming experience, the entire loop from client input to rendered frame presentation must stay below **100ms** (ideally 50–80ms under good network conditions).

```
[ Client Input ] ──────────────► [ Container Input Injection ]
     5ms (Capture + Send)                2ms (DataChannel read + uinput)
                                                  │
                                         Game Simulation Tick
                                             16.6ms (60 FPS)
                                                  │
                                         GPU Frame Rendering
                                             4–8ms (DirectX/Vulkan/OpenGL)
                                                  │
[ Client Display ] ◄───────────── [ Hardware Encode (NVENC) ]
  16ms (Jitter + Decode + VSync)      4–8ms (H.264 ultrafast, no B-frames)
          ▲                                       │
          └────────── [ Network Transit ] ◄───────┘
                       20–35ms (UDP / SRTP)
```

| Pipeline Stage | Target Latency | Engineering Optimization |
| :--- | :--- | :--- |
| **Client Input Capture** | 2 – 5 ms | HTML5 Pointer Lock API, raw binary packet serialization (no JSON) |
| **Input Ingestion & Inject** | 1 – 2 ms | Pion WebRTC DataChannel reading directly into Linux `/dev/uinput` |
| **Game Simulation & Render** | 16.6 ms | Locked 60 FPS tick rate; off-screen rendering via NVIDIA GPU dummy Xorg |
| **Frame Capture & NVENC** | 4 – 8 ms | Zero-copy framebuffer capture piped to NVENC hardware encoder (`zerolatency`) |
| **Network Transit (SRTP)** | 15 – 35 ms | UDP-based transport bypassing TCP head-of-line blocking; localized STUN |
| **Client Jitter & HW Decode** | 10 – 16 ms | WebRTC MediaStream API with hardware WebCodecs/HTML5 `<video>` decode |
| **Total Glass-to-Glass** | **~50 – 85 ms** | **Comfortably sub-100ms interactive threshold** |

---

## 3. High-Level System Architecture

```mermaid
flowchart TB
    subgraph Client ["Client Browser"]
        UI["React / Vanilla SPA"]
        VC["HTML5 Video Element"]
        IC["Input Controller (Pointer Lock / Key)"]
    end

    subgraph EdgeGateway ["Signaling & Orchestration Layer"]
        WS["Signaling Gateway (Node.js/TS or Python FastAPI)"]
        Orch["Container Orchestrator Engine"]
        Redis[("Redis Cluster\n- Session State\n- Node Pub/Sub\n- Heartbeat TTL")]
    end

    subgraph GPUHost ["Bare-Metal / VM Host (RTX 5050 8GB)"]
        DockerDaemon["Docker Engine API (nvidia-container-runtime)"]
        
        subgraph Container1 ["Session Container #1"]
            Xorg1["Headless Xorg (Dummy Driver)"]
            Game1["Game Process (Vulkan/OpenGL)"]
            FF1["FFmpeg NVENC Hardware Encoder"]
            Pion1["Pion WebRTC Agent (Go Daemon)"]
            Input1["uinput / XTEST Daemon"]
        end

        subgraph Container2 ["Session Container #2"]
            Xorg2["Headless Xorg (Dummy Driver)"]
            Game2["Game Process (Vulkan/OpenGL)"]
            FF2["FFmpeg NVENC Hardware Encoder"]
            Pion2["Pion WebRTC Agent (Go Daemon)"]
            Input2["uinput / XTEST Daemon"]
        end
    end

    %% Signaling
    UI <-->|WebSocket: SDP Offer/Answer, ICE| WS
    WS <--> Redis
    WS -->|Provision / Terminate| Orch
    Orch -->|Docker Engine SDK| DockerDaemon

    %% Direct Peer-to-Peer Media & Input
    VC <===|WebRTC SRTP: H.264 / Opus (UDP)| Pion1
    IC ===>|WebRTC DataChannel: Binary Inputs (UDP)| Pion1
    
    %% In-Container Interconnects
    Game1 -->|Render Frames| Xorg1
    Xorg1 -->|Raw Frame Grab| FF1
    FF1 -->|H.264 RTP Stream| Pion1
    Pion1 -->|Raw Input Events| Input1
    Input1 -->|Virtual Keyboard / Mouse| Xorg1
```

---

## 4. Multi-Tenant GPU Density: Slicing the RTX 5050 (8GB VRAM)

Running multiple interactive game instances on a single NVIDIA GeForce RTX 5050 (8GB VRAM) introduces hardware boundary challenges that make for great interview talking points.

### 1. Hardware Constraints & Solutions

| Constraint | Limit on RTX 5050 (Consumer Card) | Solution / Mitigation Strategy |
| :--- | :--- | :--- |
| **NVENC Concurrent Sessions** | Consumer NVIDIA drivers limit concurrent NVENC encodes (historically 3–5 streams). | Use driver versions supporting 5–8 concurrent sessions, or fall back to CPU `libx264 ultrafast` when limits are exceeded. |
| **VRAM Capacity (8GB)** | 8GB total memory pool shared across all container instances. | **VRAM Budgeting**: Restrict each container to ~1.2GB–1.8GB VRAM at 720p/1080p. Max **3–4 concurrent active sessions** safely on 8GB. |
| **Context Switching Overhead** | Multiple Xorg servers and 3D contexts sharing one physical GPU. | Run individual headless Xorg instances per container mapped to the same NVIDIA device node (`/dev/nvidia0`, `/dev/nvidiactl`, `/dev/nvidia-modeset`). |

### 2. NVIDIA Container Passthrough Configuration
Each container runs with explicit GPU resource requests:
```bash
docker run -d \
  --name game-session-${SESSION_ID} \
  --gpus all \
  --device /dev/uinput \
  --cap-add SYS_ADMIN \
  -e NVIDIA_VISIBLE_DEVICES=all \
  -e NVIDIA_DRIVER_CAPABILITIES=graphics,utility,video \
  -e DISPLAY=:99 \
  nebula-game-runner:latest
```

---

## 5. Subsystem Technical Specifications

### Component A: In-Container WebRTC & Media Daemon (Pion in Go)
* **Role**: Acts as the in-container WebRTC peer endpoint.
* **Why Pion (Go)?**
  * Compiles to a single zero-dependency static binary (~15MB), drastically reducing container image footprint.
  * Direct memory access to RTP packet pipelines with zero Python GIL or Node.js event-loop lockups.
  * Native, low-latency implementation of SCTP (WebRTC DataChannels) and ICE/DTLS handshakes.
* **Responsibilities**:
  1. Accepts H.264 video RTP stream from FFmpeg via local loopback (`127.0.0.1:5004`).
  2. Receives client SDP Offer, generates SDP Answer, and collects local ICE candidates.
  3. Transmits RTP video/audio packets to the client over SRTP (UDP).
  4. Listens on the WebRTC DataChannel for high-frequency input events.

### Component B: Low-Latency Video Encoding Pipeline (FFmpeg + NVENC)
* **Capture Source**: Headless X11 dummy display (`:99.0`).
* **Encoder Configuration**:
  ```bash
  ffmpeg \
    -f x11grab -draw_mouse 0 -framerate 60 -video_size 1280x720 -i :99.0 \
    -c:v h264_nvenc \
    -preset p1 \
    -tune zerolatency \
    -profile:v baseline \
    -b:v 3000k -maxrate 3500k -bufsize 300k \
    -g 60 -keyint_min 60 \
    -forced-idr 1 \
    -surfaces 1 -delay 0 \
    -f rtp rtp://127.0.0.1:5004
  ```
  *(Note: `-preset p1` is NVENC's fastest ultra-low-latency preset; `-surfaces 1 -delay 0` eliminates encoder frame buffering).*

### Component C: High-Frequency Input Subsystem (DataChannel ➔ `uinput`)
* **Transport**: WebRTC DataChannel (ordered: false, maxRetransmits: 0) for zero-latency lossy input transit (similar to UDP packet semantics).
* **Wire Protocol (Binary Struct - 9 Bytes)**:
  ```
  Byte 0:     Event Type (0x01: KeyDown, 0x02: KeyUp, 0x03: MouseMove, 0x04: MouseBtnDown, 0x05: MouseBtnUp)
  Bytes 1-2:  Keycode / Mouse Button (uint16)
  Bytes 3-4:  Delta X (int16 signed)
  Bytes 5-6:  Delta Y (int16 signed)
  Bytes 7-8:  Reserved / Timestamp checksum
  ```
* **Injection**: Injected directly into Linux `/dev/uinput` to emulate a hardware mouse/keyboard. This bypasses window focus issues and works transparently with 3D camera mouse tracking.

### Component D: Signaling Server & Room State (Node.js/TypeScript + Redis)
* **Role**: Orchestrates handshakes between clients and containers.
* **WebSocket Events**:
  * `session:request`: Client requests a game session.
  * `session:provisioning`: Backend triggers container spin-up.
  * `signal:offer` / `signal:answer`: Exchanging SDP blobs.
  * `signal:candidate`: Trickle ICE candidate exchange.
  * `heartbeat`: Keep-alive pulse; triggers container reaper if absent for >10s.
* **Redis Role**:
  * Tracks active container IDs, port allocations, and user sessions across clustered signaling nodes.
  * Pub/Sub channel for routing signaling payloads between the orchestrator and distributed WebRTC endpoints.

### Component E: Selective Forwarding Unit (SFU) Architecture Concept
* In standard 1-to-1 cloud gaming, direct P2P (Client ➔ Container) yields lowest latency.
* **Where the SFU Wins Interviews**: **Live Spectator Mode & Multi-Stream Broadcast**.
  * Container renders once and pushes a single H.264 stream to the SFU.
  * The SFU replicates the stream to 100+ passive spectators without adding any GPU rendering or encoding burden to the game host.
  * Demonstrates knowledge of SFU packet replication, Simulcast, and RTCP bandwidth probing.

---

## 6. Functional & Non-Functional Requirements

### Functional Requirements
1. **On-Demand Session Provisioning**: Spin up an isolated Docker container within < 3 seconds upon client session request (or < 500ms using a pre-warmed standby pool).
2. **Interactive Stream Delivery**: Stream high-definition video (720p/1080p at 60 FPS) via WebRTC.
3. **Sub-100ms Input Synchronization**: Transmit keyboard and mouse movements from the browser to the game loop in real time.
4. **Heartbeat & Ephemeral Teardown**: Automatically tear down and prune containers upon tab close, network loss, or 10-second heartbeat failure.
5. **Multi-Session Isolation**: Multiple active sessions on the host without cross-talk or noisy-neighbor crashes.

### Non-Functional Requirements
1. **Latency**: End-to-end glass-to-glass latency strictly < 100ms (target: 50–70ms on LAN/broadband).
2. **Network Resilience**: Maintain stream stability during jitter and minor packet loss using periodic IDR frames and WebRTC NACK/PLI feedback.
3. **Resource Efficiency**: Maximize concurrent density on the 8GB RTX 5050 host (target: 3–4 concurrent containers).
4. **Zero Client Footprint**: Completely plugin-free; operates entirely within modern web browsers (Chrome, Firefox, Safari, Edge).

---

## 7. Deep-Dive Interview Talking Points & Defenses

When interviewers grill you on this system, here are the architectural trade-offs and battle-tested answers:

### 1. "Why WebRTC instead of WebSocket streaming (like canvas streaming over WS)?"
> *"WebSockets operate over TCP, which guarantees in-order packet delivery. If a single packet drops on a shaky connection, TCP stalls all subsequent packets (Head-of-Line blocking) while waiting for retransmission. For interactive gaming, a dropped frame is stale immediately; waiting for it destroys the user experience. WebRTC operates over UDP with SRTP, allowing us to drop lost frames instantly and request keyframe refreshes (PLI) without stalling playback."*

### 2. "How do you handle container cold start latency?"
> *"A cold container spin-up (Docker create, X11 start, audio daemon, game launch) takes ~3 to 5 seconds. To achieve sub-second response times, we implement a **Pre-Warmed Standby Pool** in Redis. The orchestrator maintains 1–2 idle, already-running containers in a 'warm' state. When a user requests a session, the orchestrator attaches the user to a warm container in under 300ms, and asynchronously replenishes the standby pool in the background."*

### 3. "How do you deal with mouse pointer locking in the browser?"
> *"Standard browser mouse events report absolute coordinates relative to the screen. In 3D games (FPS, action), the camera relies on continuous mouse deltas (`movementX`, `movementY`). We utilize the HTML5 Pointer Lock API (`element.requestPointerLock()`), which locks the cursor and reports continuous raw delta deltas, transmitting them via binary DataChannels to `/dev/uinput` on Linux."*

### 4. "How do you avoid GPU out-of-memory (OOM) crashes with multiple containers?"
> *"With an 8GB RTX 5050, uncontrolled container spawning would trigger GPU OOM and crash all active sessions. The provisioning microservice acts as an admission controller: it tracks active VRAM allocations in Redis. When the host hits its memory threshold (e.g., 3 active instances @ ~1.8GB VRAM each + host overhead), new requests are queued or routed to another host."*

---

## 8. Implementation Roadmap

- [ ] **Phase 1: In-Container Base Image & Graphics Pipeline**
  - Dockerfile with Ubuntu 22.04, NVIDIA CUDA/graphics drivers, headless Xorg dummy display, and `/dev/uinput` configuration.
  - Test harness launching an interactive OpenGL/Vulkan game (e.g., lightweight 3D/2D game or emulator).
- [ ] **Phase 2: In-Container Pion WebRTC & FFmpeg Streaming Daemon**
  - Static Go binary using Pion WebRTC.
  - FFmpeg pipeline feeding NVENC H.264 into Pion over local RTP.
  - DataChannel listener decoding binary input packets and injecting via `/dev/uinput`.
- [ ] **Phase 3: WebSocket Signaling Server & Client Web Player**
  - Node.js/TypeScript (or Python FastAPI) WebSocket signaling server.
  - Browser frontend with video element, WebRTC peer connection, and Pointer Lock input capture.
- [ ] **Phase 4: Docker Engine Orchestrator & Lifecycle Manager**
  - Microservice interfacing with Docker Engine SDK.
  - Dynamic port range mapping for WebRTC UDP traffic.
  - Redis session tracking, heartbeat monitoring, and automatic container reaper.
- [ ] **Phase 5: Benchmarking & Profiling**
  - Measuring glass-to-glass latency with high-speed camera / screen timer.
  - Profiling VRAM consumption and NVENC encoder utilization across 1, 2, and 3 concurrent containers.

