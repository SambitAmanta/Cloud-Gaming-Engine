// Binary Wire Protocol matching Go Pion Agent (strictly 9 bytes)
export const Opcodes = {
  KeyDown: 0x01,
  KeyUp: 0x02,
  MouseMove: 0x03,
  MouseDown: 0x04,
  MouseUp: 0x05,
  MouseWheel: 0x06,
  Ping: 0x07,
  Pong: 0x08
};

export const MouseButtons = {
  Left: 1,
  Middle: 2,
  Right: 3
};

// Reusable ArrayBuffer and DataView to avoid GC allocations at 60-120Hz
const buffer = new ArrayBuffer(9);
const view = new DataView(buffer);

/**
 * Serializes an input event into a 9-byte binary packet
 * @param {number} opcode - Action type
 * @param {number} code - Key code or mouse button
 * @param {number} deltaX - Relative mouse X movement
 * @param {number} deltaY - Relative mouse Y movement
 * @param {number} extra - Wheel delta or extra parameter
 * @returns {ArrayBuffer}
 */
export function serializeInput(opcode, code = 0, deltaX = 0, deltaY = 0, extra = 0) {
  view.setUint8(0, opcode);
  view.setUint16(1, code, true); // LittleEndian
  view.setInt16(3, deltaX, true);
  view.setInt16(5, deltaY, true);
  view.setInt16(7, extra, true);
  return buffer;
}

