import { describe, expect, it } from 'vitest';
import { encodeMessage, createFramer } from '../src/shared/helperProtocol.js';

describe('encodeMessage', () => {
  it('serializes to a single newline-terminated JSON line', () => {
    expect(encodeMessage({ id: 1, type: 'ping' })).toBe('{"id":1,"type":"ping"}\n');
  });
});

describe('createFramer', () => {
  it('emits one object per complete line', () => {
    const framer = createFramer();
    expect(framer.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('buffers a partial line until its newline arrives', () => {
    const framer = createFramer();
    expect(framer.push('{"a":')).toEqual([]);
    expect(framer.push('1}\n')).toEqual([{ a: 1 }]);
  });

  it('ignores empty lines between complete messages', () => {
    const framer = createFramer();
    expect(framer.push('{"a":1}\n\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
