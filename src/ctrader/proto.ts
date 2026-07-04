// Minimal protobuf encoder/decoder for cTrader Open API messages

function encodeVarint(n: number): Uint8Array {
  const buf: number[] = [];
  while (n > 0x7f) {
    buf.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  buf.push(n & 0x7f);
  return new Uint8Array(buf);
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; bytesRead: number } {
  let value = 0, shift = 0, i = 0;
  while (true) {
    const b = bytes[offset + i]!;
    value += (b & 0x7f) * Math.pow(2, shift);
    i++;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value, bytesRead: i };
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function tag(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

export function fieldVarint(field: number, value: number): Uint8Array {
  return concat(tag(field, 0), encodeVarint(value));
}

export function fieldString(field: number, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat(tag(field, 2), encodeVarint(bytes.length), bytes);
}

export function fieldBytes(field: number, bytes: Uint8Array): Uint8Array {
  return concat(tag(field, 2), encodeVarint(bytes.length), bytes);
}

// Wrap payload in ProtoMessage and add 4-byte big-endian length prefix
export function frameMessage(payloadType: number, payload: Uint8Array): Uint8Array {
  const msg = concat(fieldVarint(1, payloadType), fieldBytes(2, payload));
  const frame = new Uint8Array(4 + msg.length);
  new DataView(frame.buffer).setUint32(0, msg.length, false);
  frame.set(msg, 4);
  return frame;
}

// Decode a framed ProtoMessage → { payloadType, payload }
export function decodeFrame(data: ArrayBuffer): { payloadType: number; payload: Uint8Array } {
  const len = new DataView(data).getUint32(0, false);
  const msg = new Uint8Array(data, 4, len);
  return decodeProtoMessage(msg);
}

function decodeProtoMessage(bytes: Uint8Array): { payloadType: number; payload: Uint8Array } {
  let payloadType = 0;
  let payload = new Uint8Array(0);
  let i = 0;
  while (i < bytes.length) {
    const { value: tagVal, bytesRead: tr } = readVarint(bytes, i);
    i += tr;
    const field = tagVal >>> 3;
    const wire  = tagVal & 0x7;
    if (wire === 0) {
      const { value, bytesRead } = readVarint(bytes, i);
      i += bytesRead;
      if (field === 1) payloadType = value;
    } else if (wire === 2) {
      const { value: len, bytesRead } = readVarint(bytes, i);
      i += bytesRead;
      const slice = bytes.slice(i, i + len);
      i += len;
      if (field === 2) payload = slice;
    } else break;
  }
  return { payloadType, payload };
}

// Decode all fields from a payload bytes
export function decodeFields(payload: Uint8Array): Map<number, (number | Uint8Array)[]> {
  const fields = new Map<number, (number | Uint8Array)[]>();
  const add = (k: number, v: number | Uint8Array) => {
    if (!fields.has(k)) fields.set(k, []);
    fields.get(k)!.push(v);
  };
  let i = 0;
  while (i < payload.length) {
    const { value: tagVal, bytesRead: tr } = readVarint(payload, i);
    i += tr;
    const field = tagVal >>> 3;
    const wire  = tagVal & 0x7;
    if (wire === 0) {
      const { value, bytesRead } = readVarint(payload, i);
      i += bytesRead;
      add(field, value);
    } else if (wire === 2) {
      const { value: len, bytesRead } = readVarint(payload, i);
      i += bytesRead;
      add(field, payload.slice(i, i + len));
      i += len;
    } else break;
  }
  return fields;
}

export function str(v: Uint8Array): string {
  return new TextDecoder().decode(v);
}

export { concat };
