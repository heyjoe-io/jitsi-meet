import { IStore } from '../app/types';
import { getCurrentConference } from '../base/conference/functions';
import { showNotification } from '../notifications/actions';

import {
    SET_WAITING_FOR_HOST,
    SET_WAITING_ROOM_PARTICIPANT_COUNT
} from './actionTypes';
import { shouldWaitForHost } from './functions';

/**
 * Action to set the waiting for host state.
 *
 * @param {boolean} waiting - Whether we are waiting for host.
 * @returns {{
 *     type: SET_WAITING_FOR_HOST,
 *     waiting: boolean
 * }}
 */
export function setWaitingForHost(waiting: boolean) {
    return {
        type: SET_WAITING_FOR_HOST,
        waiting
    };
}

/**
 * Action to update the count of participants waiting for host.
 *
 * @param {number} count - Number of participants waiting.
 * @returns {{
 *     type: SET_WAITING_ROOM_PARTICIPANT_COUNT,
 *     count: number
 * }}
 */
export function setWaitingRoomParticipantCount(count: number) {
    return {
        type: SET_WAITING_ROOM_PARTICIPANT_COUNT,
        count
    };
}

/**
 * Checks if the current participant should wait for host.
 *
 * @returns {Function}
 */
export function checkWaitingForHost() {
    return (dispatch: IStore['dispatch'], getState: IStore['getState']) => {
        const state = getState();
        
        if (shouldWaitForHost(state)) {
            dispatch(setWaitingForHost(true));
            dispatch(showNotification({
                titleKey: 'waitingForHost.title',
                descriptionKey: 'waitingForHost.message'
            }));
        } else {
            dispatch(setWaitingForHost(false));
        }
    };
}

/**
 * Allows participant to join after host has joined.
 *
 * @returns {Function}
 */
export function hostHasJoined() {
    return (dispatch: IStore['dispatch']) => {
        dispatch(setWaitingForHost(false));
    };
}