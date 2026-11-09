package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"

	"github.com/nebulastream/agent/input"
)

// SignalMessage format exchanged with the WebSocket signaling server
type SignalMessage struct {
	Type      string                    `json:"type"`
	SessionID string                    `json:"sessionId,omitempty"`
	SDP       string                    `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

type Config struct {
	SignalingURL string
	SessionID    string
	RTPPort      int
	STUNServer   string
}

func main() {
	cfg := Config{}
	flag.StringVar(&cfg.SignalingURL, "signaling", getEnv("SIGNALING_URL", "ws://127.0.0.1:8080/ws/agent"), "Signaling server WebSocket URL")
	flag.StringVar(&cfg.SessionID, "session", getEnv("SESSION_ID", "default-session"), "Session ID for this container")
	flag.IntVar(&cfg.RTPPort, "rtp-port", 5004, "Local UDP port to receive RTP packets from FFmpeg")
	flag.StringVar(&cfg.STUNServer, "stun", getEnv("STUN_SERVER", "stun:stun.l.google.com:19302"), "STUN server URL")
	flag.Parse()

	log.Printf("[NebulaStream Agent] Starting agent for Session: %s", cfg.SessionID)

	// 1. Initialize Input Driver (uinput on Linux, dummy fallback on others)
	driver, err := input.NewUInputDriver()
	if err != nil {
		log.Fatalf("[Input] Critical driver failure: %v", err)
	}
	defer driver.Close()
	dispatcher := input.NewDispatcher(driver)

	// 2. Prepare WebRTC Media Engine & H.264 Codec
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:     webrtc.MimeTypeH264,
			ClockRate:    90000,
			Channels:     0,
			SDPFmtpLine:  "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
			RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}},
		},
		PayloadType: 96,
	}, webrtc.RTPCodecTypeVideo); err != nil {
		log.Fatalf("[WebRTC] Failed to register H.264 codec: %v", err)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))

	peerConnectionConfig := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{cfg.STUNServer}},
		},
	}

	peerConnection, err := api.NewPeerConnection(peerConnectionConfig)
	if err != nil {
		log.Fatalf("[WebRTC] Failed to create PeerConnection: %v", err)
	}
	defer peerConnection.Close()

	// 3. Create WebRTC Video Track for H.264
	videoTrack, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
		"video",
		"nebulastream-video",
	)
	if err != nil {
		log.Fatalf("[WebRTC] Failed to create video track: %v", err)
	}

	rtpSender, err := peerConnection.AddTrack(videoTrack)
	if err != nil {
		log.Fatalf("[WebRTC] Failed to add video track to PeerConnection: %v", err)
	}

	// Read incoming RTCP feedback (PLI / NACK) in background
	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, err := rtpSender.Read(rtcpBuf); err != nil {
				return
			}
		}
	}()

	// 4. Handle incoming WebRTC DataChannel for Input events
	peerConnection.OnDataChannel(func(d *webrtc.DataChannel) {
		log.Printf("[WebRTC] DataChannel established: %s", d.Label())
		if d.Label() != "input" {
			return
		}

		d.OnMessage(func(msg webrtc.DataChannelMessage) {
			if msg.IsString {
				return
			}
			if err := dispatcher.ProcessRaw(msg.Data); err != nil {
				// Suppress repeated format warnings
			}
		})
	})

	// 5. Connect to WebSocket Signaling Server
	wsURL, err := url.Parse(cfg.SignalingURL)
	if err != nil {
		log.Fatalf("[Signaling] Invalid URL: %v", err)
	}
	q := wsURL.Query()
	q.Set("sessionId", cfg.SessionID)
	q.Set("role", "agent")
	wsURL.RawQuery = q.Encode()

	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL.String(), nil)
	if err != nil {
		log.Printf("[Signaling] Warning: Could not connect to signaling server at %s: %v. Running in offline/wait mode.", wsURL.String(), err)
	} else {
		log.Printf("[Signaling] Connected to signaling gateway at %s", wsURL.String())
		defer wsConn.Close()

		// Stream ICE candidates to signaling
		peerConnection.OnICECandidate(func(c *webrtc.ICECandidate) {
			if c == nil {
				return
			}
			candJSON := c.ToJSON()
			msg := SignalMessage{
				Type:      "signal:candidate",
				SessionID: cfg.SessionID,
				Candidate: &candJSON,
			}
			_ = wsConn.WriteJSON(msg)
		})

		// Listen for SDP Offer and ICE from Signaling in background
		go handleSignaling(wsConn, peerConnection, cfg.SessionID)
	}

	peerConnection.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Printf("[WebRTC] PeerConnection State changed to: %s", s.String())
	})

	// 6. Ingest RTP stream from FFmpeg over UDP
	go ingestRTPFromFFmpeg(cfg.RTPPort, videoTrack)

	// Keep alive until OS signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan
	log.Println("[NebulaStream Agent] Shutting down cleanly.")
}

func handleSignaling(ws *websocket.Conn, pc *webrtc.PeerConnection, sessionID string) {
	for {
		var msg SignalMessage
		if err := ws.ReadJSON(&msg); err != nil {
			log.Printf("[Signaling] Read error: %v", err)
			return
		}

		switch msg.Type {
		case "signal:offer":
			log.Println("[Signaling] Received SDP Offer from client")
			offer := webrtc.SessionDescription{
				Type: webrtc.SDPTypeOffer,
				SDP:  msg.SDP,
			}
			if err := pc.SetRemoteDescription(offer); err != nil {
				log.Printf("[WebRTC] Failed to set remote description: %v", err)
				continue
			}

			answer, err := pc.CreateAnswer(nil)
			if err != nil {
				log.Printf("[WebRTC] Failed to create answer: %v", err)
				continue
			}

			if err := pc.SetLocalDescription(answer); err != nil {
				log.Printf("[WebRTC] Failed to set local description: %v", err)
				continue
			}

			_ = ws.WriteJSON(SignalMessage{
				Type:      "signal:answer",
				SessionID: sessionID,
				SDP:       answer.SDP,
			})
			log.Println("[Signaling] Dispatched SDP Answer to client")

		case "signal:candidate":
			if msg.Candidate != nil {
				if err := pc.AddICECandidate(*msg.Candidate); err != nil {
					log.Printf("[WebRTC] Failed to add ICE candidate: %v", err)
				}
			}
		}
	}
}

func ingestRTPFromFFmpeg(port int, track *webrtc.TrackLocalStaticRTP) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	udpAddr, err := net.ResolveUDPAddr("udp", addr)
	if err != nil {
		log.Fatalf("[RTP] Resolve error: %v", err)
	}

	conn, err := net.ListenUDP("udp", udpAddr)
	if err != nil {
		log.Fatalf("[RTP] ListenUDP error on %s: %v", addr, err)
	}
	defer conn.Close()

	log.Printf("[RTP] Listening for FFmpeg H.264 stream on UDP %s", addr)

	buf := make([]byte, 1600)
	for {
		n, _, err := conn.ReadFrom(buf)
		if err != nil {
			log.Printf("[RTP] Read error: %v", err)
			time.Sleep(10 * time.Millisecond)
			continue
		}

		if _, err := track.Write(buf[:n]); err != nil {
			// Video track write error (e.g. before connection established or buffer full)
		}
	}
}

func getEnv(key, defaultVal string) string {
	if val := os.Getenv(key); val != "" {
		return val
	}
	return defaultVal
}

