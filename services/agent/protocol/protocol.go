package protocol

import (
	"encoding/binary"
	"errors"
)

// Opcodes for low-latency binary input serialization
const (
	OpcodeKeyDown    uint8 = 0x01
	OpcodeKeyUp      uint8 = 0x02
	OpcodeMouseMove  uint8 = 0x03
	OpcodeMouseDown  uint8 = 0x04
	OpcodeMouseUp    uint8 = 0x05
	OpcodeMouseWheel uint8 = 0x06
	OpcodePing       uint8 = 0x07
	OpcodePong       uint8 = 0x08
)

// Mouse Button definitions
const (
	MouseButtonLeft   uint16 = 1
	MouseButtonMiddle uint16 = 2
	MouseButtonRight  uint16 = 3
)

// InputPacket represents a deserialized input event (strictly 9 bytes wire size)
type InputPacket struct {
	Opcode uint8
	Code   uint16
	DeltaX int16
	DeltaY int16
	Extra  int16
}

var ErrPacketTooShort = errors.New("input packet is shorter than 9 bytes")

// Unmarshal decodes a 9-byte raw payload received over the WebRTC DataChannel
func (p *InputPacket) Unmarshal(data []byte) error {
	if len(data) < 9 {
		return ErrPacketTooShort
	}

	p.Opcode = data[0]
	p.Code = binary.LittleEndian.Uint16(data[1:3])
	p.DeltaX = int16(binary.LittleEndian.Uint16(data[3:5]))
	p.DeltaY = int16(binary.LittleEndian.Uint16(data[5:7]))
	p.Extra = int16(binary.LittleEndian.Uint16(data[7:9]))
	return nil
}

// Marshal encodes an InputPacket into a 9-byte binary array
func (p *InputPacket) Marshal() []byte {
	buf := make([]byte, 9)
	buf[0] = p.Opcode
	binary.LittleEndian.PutUint16(buf[1:3], p.Code)
	binary.LittleEndian.PutUint16(buf[3:5], uint16(p.DeltaX))
	binary.LittleEndian.PutUint16(buf[5:7], uint16(p.DeltaY))
	binary.LittleEndian.PutUint16(buf[7:9], uint16(p.Extra))
	return buf
}

