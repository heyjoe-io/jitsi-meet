/**
 * Stores the latest teleprompter payload broadcast by the Casting Admin (CD)
 * over the Jitsi data channel.
 *
 * {
 *     type: SET_TELEPROMPTER,
 *     payload: { script, fontSize, scrollSpeed, isScrolling, resetTrigger, nudgeTrigger, nudgeDir }
 * }
 */
export const SET_TELEPROMPTER = 'SET_TELEPROMPTER';
