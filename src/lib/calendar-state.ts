/**
 * Shared state for calendar access control
 * Stored separately to avoid circular dependencies
 */

// Set of calendar IDs that failed write access check (disabled for booking)
export const disabledCalendars = new Set<string>();
