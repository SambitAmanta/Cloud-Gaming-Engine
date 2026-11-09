import { Opcodes, MouseButtons, serializeInput } from './protocol.js';

// Common JavaScript event.code to Linux Keycode mapping (Linux input-event-codes.h)
const KEY_MAP = {
  KeyW: 17,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyQ: 16,
  KeyE: 18,
  KeyR: 19,
  KeyF: 33,
  KeyC: 46,
  Space: 57,
  ShiftLeft: 42,
  ShiftRight: 54,
  ControlLeft: 29,
  ControlRight: 97,
  AltLeft: 56,
  Tab: 15,
  Escape: 1,
  Enter: 28,
  Backspace: 14,
  ArrowUp: 103,
  ArrowLeft: 105,
  ArrowRight: 106,
  ArrowDown: 108,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5
};

export class InputManager {
  /**
   * @param {HTMLElement} targetElement - Video player or canvas container
   * @param {RTCDataChannel} dataChannel - Active WebRTC DataChannel
   */
  constructor(targetElement, dataChannel) {
    this.target = targetElement;
    this.dc = dataChannel;
    this.isPointerLocked = false;
    this.bindEvents();
  }

  setDataChannel(dc) {
    this.dc = dc;
  }

  requestPointerLock() {
    this.target.requestPointerLock =
      this.target.requestPointerLock ||
      this.target.mozRequestPointerLock ||
      this.target.webkitRequestPointerLock;
    if (this.target.requestPointerLock) {
      this.target.requestPointerLock();
    }
  }

  bindEvents() {
    // 1. Pointer Lock Change Listeners
    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement === this.target;
    });

    // 2. Mouse Move with raw relative delta
    window.addEventListener('mousemove', (e) => {
      if (!this.isPointerLocked || !this.isChannelOpen()) return;
      const dx = Math.round(e.movementX || 0);
      const dy = Math.round(e.movementY || 0);
      if (dx !== 0 || dy !== 0) {
        this.send(serializeInput(Opcodes.MouseMove, 0, dx, dy));
      }
    });

    // 3. Mouse Click (Down/Up)
    this.target.addEventListener('mousedown', (e) => {
      if (!this.isPointerLocked) {
        this.requestPointerLock();
      }
      if (!this.isChannelOpen()) return;

      let btn = MouseButtons.Left;
      if (e.button === 1) btn = MouseButtons.Middle;
      if (e.button === 2) btn = MouseButtons.Right;

      this.send(serializeInput(Opcodes.MouseDown, btn));
      e.preventDefault();
    });

    this.target.addEventListener('mouseup', (e) => {
      if (!this.isChannelOpen()) return;
      let btn = MouseButtons.Left;
      if (e.button === 1) btn = MouseButtons.Middle;
      if (e.button === 2) btn = MouseButtons.Right;

      this.send(serializeInput(Opcodes.MouseUp, btn));
      e.preventDefault();
    });

    // Disable context menu on right click inside player
    this.target.addEventListener('contextmenu', (e) => e.preventDefault());

    // 4. Mouse Wheel
    this.target.addEventListener('wheel', (e) => {
      if (!this.isChannelOpen()) return;
      const delta = Math.sign(e.deltaY);
      this.send(serializeInput(Opcodes.MouseWheel, 0, 0, 0, delta));
      e.preventDefault();
    });

    // 5. Keyboard Events
    window.addEventListener('keydown', (e) => {
      if (!this.isChannelOpen()) return;
      const linuxCode = KEY_MAP[e.code] || e.keyCode;
      this.send(serializeInput(Opcodes.KeyDown, linuxCode));
      // Prevent browser default actions for gaming keys (e.g. Tab, Space scroll)
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (!this.isChannelOpen()) return;
      const linuxCode = KEY_MAP[e.code] || e.keyCode;
      this.send(serializeInput(Opcodes.KeyUp, linuxCode));
    });
  }

  isChannelOpen() {
    return this.dc && this.dc.readyState === 'open';
  }

  send(buffer) {
    if (this.isChannelOpen()) {
      this.dc.send(buffer);
    }
  }
}

