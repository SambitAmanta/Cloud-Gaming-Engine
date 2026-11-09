//go:build linux

package input

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"log"
	"os"
	"syscall"
	"time"
	"unsafe"

	"github.com/nebulastream/agent/protocol"
)

// Linux uinput constants
const (
	uinputPath = "/dev/uinput"

	EV_SYN = 0x00
	EV_KEY = 0x01
	EV_REL = 0x02

	SYN_REPORT = 0

	REL_X     = 0x00
	REL_Y     = 0x01
	REL_WHEEL = 0x08

	BTN_LEFT   = 0x110
	BTN_RIGHT  = 0x111
	BTN_MIDDLE = 0x112

	UI_SET_EVBIT  = 0x40045564
	UI_SET_KEYBIT = 0x40045565
	UI_SET_RELBIT = 0x40045566
	UI_DEV_CREATE = 0x5501
	UI_DEV_DESTROY = 0x5502
)

type inputEvent struct {
	Time  syscall.Timeval
	Type  uint16
	Code  uint16
	Value int32
}

type uinputUserDev struct {
	Name       [80]byte
	ID         struct{ Bustype, Vendor, Product, Version uint16 }
	FFEffectsMax uint32
	Absmax     [64]int32
	Absmin     [64]int32
	Absfuzz    [64]int32
	Absflat    [64]int32
}

type UInputDriver struct {
	file *os.File
}

func NewUInputDriver() (Driver, error) {
	f, err := os.OpenFile(uinputPath, os.O_WRONLY|os.O_NONBLOCK, 0660)
	if err != nil {
		log.Printf("[Input] Warning: Could not open %s: %v. Falling back to DummyDriver.", uinputPath, err)
		return NewDummyDriver(), nil
	}

	driver := &UInputDriver{file: f}
	if err := driver.init(); err != nil {
		f.Close()
		log.Printf("[Input] Warning: Failed to init uinput: %v. Falling back to DummyDriver.", err)
		return NewDummyDriver(), nil
	}

	log.Println("[Input] Successfully initialized Linux /dev/uinput virtual input device")
	return driver, nil
}

func ioctl(fd uintptr, request uintptr, val uintptr) error {
	_, _, err := syscall.Syscall(syscall.SYS_IOCTL, fd, request, val)
	if err != 0 {
		return err
	}
	return nil
}

func (u *UInputDriver) init() error {
	fd := u.file.Fd()

	// Enable Key and Relative events
	if err := ioctl(fd, UI_SET_EVBIT, EV_KEY); err != nil {
		return fmt.Errorf("UI_SET_EVBIT EV_KEY: %w", err)
	}
	if err := ioctl(fd, UI_SET_EVBIT, EV_REL); err != nil {
		return fmt.Errorf("UI_SET_EVBIT EV_REL: %w", err)
	}
	if err := ioctl(fd, UI_SET_EVBIT, EV_SYN); err != nil {
		return fmt.Errorf("UI_SET_EVBIT EV_SYN: %w", err)
	}

	// Enable relative axes (mouse movement & wheel)
	for _, rel := range []uintptr{REL_X, REL_Y, REL_WHEEL} {
		if err := ioctl(fd, UI_SET_RELBIT, rel); err != nil {
			return fmt.Errorf("UI_SET_RELBIT %d: %w", rel, err)
		}
	}

	// Enable mouse buttons
	for _, btn := range []uintptr{BTN_LEFT, BTN_RIGHT, BTN_MIDDLE} {
		if err := ioctl(fd, UI_SET_KEYBIT, btn); err != nil {
			return fmt.Errorf("UI_SET_KEYBIT %d: %w", btn, err)
		}
	}

	// Enable standard keyboard keys (1 - 255)
	for code := uintptr(1); code <= 255; code++ {
		_ = ioctl(fd, UI_SET_KEYBIT, code)
	}

	// Create user device
	var dev uinputUserDev
	copy(dev.Name[:], []byte("NebulaStream-Virtual-Input"))
	dev.ID.Bustype = 0x03 // BUS_USB
	dev.ID.Vendor = 0x1234
	dev.ID.Product = 0x5678
	dev.ID.Version = 1

	var buf bytes.Buffer
	if err := binary.Write(&buf, binary.LittleEndian, &dev); err != nil {
		return fmt.Errorf("binary.Write uinputUserDev: %w", err)
	}

	if _, err := u.file.Write(buf.Bytes()); err != nil {
		return fmt.Errorf("write uinputUserDev: %w", err)
	}

	if err := ioctl(fd, UI_DEV_CREATE, 0); err != nil {
		return fmt.Errorf("UI_DEV_CREATE: %w", err)
	}

	return nil
}

func (u *UInputDriver) emit(evType, code uint16, value int32) error {
	now := time.Now()
	ev := inputEvent{
		Time: syscall.Timeval{
			Sec:  int64(now.Unix()),
			Usec: int64(now.Nanosecond() / 1000),
		},
		Type:  evType,
		Code:  code,
		Value: value,
	}

	b := (*[unsafe.Sizeof(ev)]byte)(unsafe.Pointer(&ev))[:]
	_, err := u.file.Write(b)
	return err
}

func (u *UInputDriver) syn() error {
	return u.emit(EV_SYN, SYN_REPORT, 0)
}

func (u *UInputDriver) HandlePacket(pkt *protocol.InputPacket) error {
	switch pkt.Opcode {
	case protocol.OpcodeMouseMove:
		if pkt.DeltaX != 0 {
			_ = u.emit(EV_REL, REL_X, int32(pkt.DeltaX))
		}
		if pkt.DeltaY != 0 {
			_ = u.emit(EV_REL, REL_Y, int32(pkt.DeltaY))
		}
		return u.syn()

	case protocol.OpcodeMouseDown, protocol.OpcodeMouseUp:
		var btnCode uint16
		switch pkt.Code {
		case protocol.MouseButtonLeft:
			btnCode = BTN_LEFT
		case protocol.MouseButtonRight:
			btnCode = BTN_RIGHT
		case protocol.MouseButtonMiddle:
			btnCode = BTN_MIDDLE
		default:
			btnCode = BTN_LEFT
		}
		val := int32(1)
		if pkt.Opcode == protocol.OpcodeMouseUp {
			val = 0
		}
		_ = u.emit(EV_KEY, btnCode, val)
		return u.syn()

	case protocol.OpcodeKeyDown, protocol.OpcodeKeyUp:
		val := int32(1)
		if pkt.Opcode == protocol.OpcodeKeyUp {
			val = 0
		}
		_ = u.emit(EV_KEY, pkt.Code, val)
		return u.syn()

	case protocol.OpcodeMouseWheel:
		_ = u.emit(EV_REL, REL_WHEEL, int32(pkt.Extra))
		return u.syn()
	}

	return nil
}

func (u *UInputDriver) Close() error {
	if u.file != nil {
		_ = ioctl(u.file.Fd(), UI_DEV_DESTROY, 0)
		return u.file.Close()
	}
	return nil
}

