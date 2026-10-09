import { describe, expect, it } from 'vitest';
import { coworkControlText, executorReasonText, laneExecutorText } from './code.js';

describe('executor reason text', () => {
  it('maps the known codes to fixed texts', () => {
    for (const code of [
      'engine-unavailable',
      'control-unavailable',
      'engine-not-selected',
      'control-resource-failed',
    ]) {
      expect(executorReasonText(code)).not.toBe(code);
    }
  });

  it('shows an unknown code as itself', () => {
    expect(executorReasonText('something-new')).toBe('something-new');
  });
});

describe('laneExecutorText', () => {
  it('names the engine and its control resource', () => {
    expect(
      laneExecutorText({
        role: 'implementation',
        resourceId: 'dsh:deepseek',
        executor: 'engine',
        engine: 'dsh',
        controlResourceId: 'pi:deepseek-chat',
      }),
    ).toBe('Executor: DeepSeek Harness (control: pi:deepseek-chat)');
  });

  it('says native with the mapped reason', () => {
    expect(
      laneExecutorText({
        role: 'review',
        resourceId: 'claude-code:sonnet',
        executor: 'native',
        executorReason: 'engine-not-selected',
      }),
    ).toBe('Executor: native (the engine was not selected for this lane)');
    expect(laneExecutorText({ role: 'review', resourceId: 'x', executor: 'native' })).toBe(
      'Executor: native',
    );
  });

  it('is null when the plane reported no executor facts', () => {
    expect(laneExecutorText({ role: 'review', resourceId: 'x' })).toBeNull();
  });
});

describe('coworkControlText', () => {
  it('describes the gateway and the temporary direct key', () => {
    expect(coworkControlText({ path: 'gateway', resourceId: 'pi:local' })).toBe(
      'Control: Nexar gateway on pi:local',
    );
    expect(coworkControlText({ path: 'direct-key' })).toBe('Control: direct key (temporary)');
  });

  it('shows restarts only when above zero', () => {
    expect(coworkControlText({ path: 'gateway', resourceId: 'r', restarts: 0 })).toBe(
      'Control: Nexar gateway on r',
    );
    expect(coworkControlText({ path: 'gateway', resourceId: 'r', restarts: 2 })).toBe(
      'Control: Nexar gateway on r · restarts: 2',
    );
  });

  it('is null without control facts', () => {
    expect(coworkControlText(undefined)).toBeNull();
  });
});
