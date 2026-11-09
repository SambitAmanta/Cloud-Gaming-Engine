//go:build !linux

package input

// NewUInputDriver returns the DummyDriver on non-Linux platforms
func NewUInputDriver() (Driver, error) {
	return NewDummyDriver(), nil
}

