import { describe, expect, it } from 'vitest';
import { getRuntimeErrorDetails } from './runtimeErrors';

describe('getRuntimeErrorDetails', () => {
  it('preserves a normal Error name and message', () => {
    expect(getRuntimeErrorDetails(new TypeError('video play failed'))).toEqual({
      name: 'TypeError',
      message: 'video play failed',
    });
  });

  it('preserves DOMException-like objects even when they are not Error instances', () => {
    const failure = { name: 'NotReadableError', message: 'Camera is already in use' };
    expect(getRuntimeErrorDetails(failure)).toEqual({
      name: 'NotReadableError',
      message: 'Camera is already in use',
    });
  });

  it('preserves string rejections rather than hiding them behind a generic error', () => {
    expect(getRuntimeErrorDetails('model download failed')).toEqual({
      name: '',
      message: 'model download failed',
    });
  });

  it('handles null and undefined rejections safely', () => {
    expect(getRuntimeErrorDetails(undefined).message).not.toBe('');
    expect(getRuntimeErrorDetails(null).message).not.toBe('');
  });
});
