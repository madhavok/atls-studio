/**
 * Persistence helpers — date rehydration and schema validation for localStorage/DB.
 * Used by appStore project history and other persisted shapes.
 */

/**
 * Rehydrate a value to a valid Date. Handles string, number, Date, or invalid input.
 * Returns epoch (1970-01-01) as fallback for unparseable values.
 */
export function rehydrateDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}
