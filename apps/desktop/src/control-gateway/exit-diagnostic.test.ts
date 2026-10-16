import { describe, expect, it } from 'vitest';
import {
  GATEWAY_EXIT_PHASES,
  formatGatewayExit,
  gatewayExitCode,
  parseGatewayExit,
} from './exit-diagnostic.js';

class CustomFailure extends Error {}
class $Odd extends Error {}

describe('gatewayExitCode', () => {
  it('uses a short [A-Z0-9_] code property, else the constructor name, else unknown', () => {
    expect(gatewayExitCode(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe(
      'EADDRINUSE',
    );
    expect(gatewayExitCode(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(
      'ERR_STREAM_DESTROYED',
    );
    expect(gatewayExitCode(new TypeError('x'))).toBe('TypeError');
    expect(gatewayExitCode(new CustomFailure('x'))).toBe('CustomFailure');
    // A code that is not a short [A-Z0-9_] string falls through to the constructor name.
    expect(gatewayExitCode(Object.assign(new TypeError('x'), { code: 'lower-case' }))).toBe(
      'TypeError',
    );
    expect(gatewayExitCode(Object.assign(new TypeError('x'), { code: 'A'.repeat(41) }))).toBe(
      'TypeError',
    );
    expect(gatewayExitCode(Object.assign(new TypeError('x'), { code: 42 }))).toBe('TypeError');
  });

  it('is unknown for anything that is not an object with a plain constructor name', () => {
    for (const value of [undefined, null, 'C:\\secret\\path', 42, () => undefined]) {
      expect(gatewayExitCode(value)).toBe('unknown');
    }
    expect(gatewayExitCode(Object.create(null))).toBe('unknown');
    expect(gatewayExitCode(new $Odd('x'))).toBe('unknown');
  });

  it('never throws, even for hostile objects', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    expect(gatewayExitCode(hostile)).toBe('unknown');
  });
});

describe('formatGatewayExit', () => {
  it('is one JSON line holding the phase and code and nothing else', () => {
    const error = Object.assign(new Error('listen failed at C:\\secret\\path token-abc'), {
      code: 'EADDRINUSE',
      stack: 'at C:\\secret\\path',
      path: 'C:\\secret\\path',
    });
    for (const phase of GATEWAY_EXIT_PHASES) {
      const text = formatGatewayExit(phase, error);
      expect(text).toBe(`{"nexarGatewayExit":{"phase":"${phase}","code":"EADDRINUSE"}}`);
      expect(text).not.toMatch(/secret|token|\n/);
    }
    expect(formatGatewayExit('config')).toBe(
      '{"nexarGatewayExit":{"phase":"config","code":"unknown"}}',
    );
  });
});

describe('parseGatewayExit', () => {
  it('round-trips what the child writes', () => {
    for (const phase of GATEWAY_EXIT_PHASES) {
      expect(parseGatewayExit(`${formatGatewayExit(phase, new RangeError('x'))}\n`)).toEqual({
        phase,
        code: 'RangeError',
      });
    }
  });

  it('finds the last well-formed line among noise and tolerates CRLF', () => {
    const text = [
      'some noise C:\\secret\\path',
      formatGatewayExit('stdin', Object.assign(new Error('x'), { code: 'EIO' })),
      formatGatewayExit('listen', Object.assign(new Error('x'), { code: 'EADDRINUSE' })),
      'trailing noise',
    ].join('\r\n');
    expect(parseGatewayExit(text)).toEqual({ phase: 'listen', code: 'EADDRINUSE' });
  });

  it('ignores lines that are not exactly the diagnostic shape', () => {
    const rejected = [
      '',
      'plain text',
      '{"nexarGatewayExit":',
      '{"nexarGatewayExit":"listen"}',
      '{"nexarGatewayExit":[]}',
      '{"nexarGatewayExit":{"phase":"bogus","code":"EIO"}}',
      '{"nexarGatewayExit":{"phase":"listen"}}',
      '{"nexarGatewayExit":{"phase":"listen","code":42}}',
      '{"nexarGatewayExit":{"phase":"listen","code":""}}',
      '{"nexarGatewayExit":{"phase":"listen","code":"has space"}}',
      '{"nexarGatewayExit":{"phase":"listen","code":"C:\\\\secret\\\\path"}}',
      `{"nexarGatewayExit":{"phase":"listen","code":"${'A'.repeat(41)}"}}`,
      '{"nexarGatewayExit":{"phase":"listen","code":"EIO","message":"extra"}}',
      '{"nexarGatewayExit":{"phase":"listen","code":"EIO"},"extra":1}',
      ' {"other":{"phase":"listen","code":"EIO"}}',
    ];
    for (const text of rejected) expect(parseGatewayExit(text)).toBeUndefined();
  });

  it('returns a fresh object with only the validated phase and code', () => {
    const parsed = parseGatewayExit('{"nexarGatewayExit":{"code":"EIO","phase":"stdin"}}');
    expect(parsed).toEqual({ phase: 'stdin', code: 'EIO' });
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['code', 'phase']);
  });
});
