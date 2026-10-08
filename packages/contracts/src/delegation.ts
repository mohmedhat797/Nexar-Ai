import { NexarError } from './errors.js';

/** Existing Cowork ceiling; an owner turn may only narrow it. */
export const MAX_COWORK_DELEGATED_UNITS = 16;

/** Read only an own data property. Never normalize an invalid restriction to the default. */
export function coworkDelegationLimit(input: object): number {
  const invalid = (): never => {
    throw new NexarError('VALIDATION_ERROR', 'Invalid Cowork delegation limit', {
      details: { reason: 'delegation-limit.invalid' },
    });
  };
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(input, 'maxDelegatedUnits');
  if (descriptor === undefined) {
    if ('maxDelegatedUnits' in input) return invalid();
    return MAX_COWORK_DELEGATED_UNITS;
  }
  if (!Object.hasOwn(descriptor, 'value')) return invalid();
  const value: unknown = descriptor.value;
  if (value === undefined) return MAX_COWORK_DELEGATED_UNITS;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_COWORK_DELEGATED_UNITS
  )
    return invalid();
  return value;
}
