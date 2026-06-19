import { SET_TELEPROMPTER } from './actionTypes';
import { ITeleprompterState } from './reducer';

/**
 * Stores a teleprompter payload received from the CD.
 *
 * @param {ITeleprompterState} payload - The latest teleprompter state.
 * @returns {{ type: string, payload: ITeleprompterState }}
 */
export function setTeleprompter(payload: ITeleprompterState) {
    return {
        type: SET_TELEPROMPTER,
        payload
    };
}
