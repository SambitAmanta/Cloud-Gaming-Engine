package input

import (
	"log"

	"github.com/nebulastream/agent/protocol"
)

// Driver defines the interface for injecting inputs into the container's OS
type Driver interface {
	HandlePacket(pkt *protocol.InputPacket) error
	Close() error
}

// Dispatcher coordinates packet unmarshaling and driver execution
type Dispatcher struct {
	driver Driver
}

func NewDispatcher(driver Driver) *Dispatcher {
	return &Dispatcher{driver: driver}
}

// ProcessRaw processes binary bytes straight from the WebRTC DataChannel
func (d *Dispatcher) ProcessRaw(data []byte) error {
	var pkt protocol.InputPacket
	if err := pkt.Unmarshal(data); err != nil {
		return err
	}
	return d.driver.HandlePacket(&pkt)
}

func (d *Dispatcher) Close() error {
	if d.driver != nil {
		return d.driver.Close()
	}
	return nil
}

// DummyDriver is a fallback driver that logs events for testing/emulation
type DummyDriver struct{}

func NewDummyDriver() *DummyDriver {
	log.Println("[Input] Initializing DummyDriver (Logging only)")
	return &DummyDriver{}
}

func (d *DummyDriver) HandlePacket(pkt *protocol.InputPacket) error {
	switch pkt.Opcode {
	case protocol.OpcodeMouseMove:
		// Suppress verbose logs for mouse delta to avoid spamming stdout
	case protocol.OpcodeKeyDown:
		log.Printf("[Input] KeyDown: code=%d", pkt.Code)
	case protocol.OpcodeKeyUp:
		log.Printf("[Input] KeyUp: code=%d", pkt.Code)
	case protocol.OpcodeMouseDown:
		log.Printf("[Input] MouseDown: btn=%d", pkt.Code)
	case protocol.OpcodeMouseUp:
		log.Printf("[Input] MouseUp: btn=%d", pkt.Code)
	}
	return nil
}

func (d *DummyDriver) Close() error {
	return nil
}

