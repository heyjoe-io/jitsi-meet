import { AnyAction } from 'redux';

import { IStore } from '../app/types';
import {
    CONFERENCE_JOINED,
    CONFERENCE_WILL_JOIN
} from '../base/conference/actionTypes';
import { getCurrentConference } from '../base/conference/functions';
import { JitsiConferenceEvents } from '../base/lib-jitsi-meet';
import {
    PARTICIPANT_JOINED,
    PARTICIPANT_LEFT
} from '../base/participants/actionTypes';
import { getLocalParticipant } from '../base/participants/functions';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';

import {
    checkWaitingForHost,
    hostHasJoined,
    setWaitingRoomParticipantCount
} from './actions';
import {
    isJibriParticipant,
    isWaitingForHost,
    shouldWaitForHost
} from './functions';

/**
 * Implements the middleware of the feature waiting-for-host.
 */
MiddlewareRegistry.register(store => next => action => {
    switch (action.type) {
    case CONFERENCE_WILL_JOIN: {
        return _conferenceWillJoin(store, next, action);
    }
    
    case CONFERENCE_JOINED: {
        return _conferenceJoined(store, next, action);
    }
    
    case PARTICIPANT_JOINED: {
        return _participantJoined(store, next, action);
    }
    
    case PARTICIPANT_LEFT: {
        return _participantLeft(store, next, action);
    }
    }

    return next(action);
});

/**
 * Notifies the feature waiting-for-host that the action CONFERENCE_WILL_JOIN is being dispatched.
 *
 * @param {Store} store - The redux store.
 * @param {Function} next - The redux dispatch function to dispatch the specified action to the specified store.
 * @param {Action} action - The redux action CONFERENCE_WILL_JOIN which is being dispatched.
 * @private
 * @returns {Object} The new state that is the result of the reduction of the specified action.
 */
function _conferenceWillJoin({ dispatch, getState }: IStore, next: Function, action: AnyAction) {
    const result = next(action);
    const state = getState();
    
    // Check if this is Jibri - if so, allow joining without waiting
    if (isJibriParticipant(state)) {
        return result;
    }
    
    // Check if participant should wait for host
    dispatch(checkWaitingForHost());
    
    return result;
}

/**
 * Notifies the feature waiting-for-host that the action CONFERENCE_JOINED is being dispatched.
 *
 * @param {Store} store - The redux store.
 * @param {Function} next - The redux dispatch function to dispatch the specified action to the specified store.
 * @param {Action} action - The redux action CONFERENCE_JOINED which is being dispatched.
 * @private
 * @returns {Object} The new state that is the result of the reduction of the specified action.
 */
function _conferenceJoined({ dispatch, getState }: IStore, next: Function, action: AnyAction) {
    const result = next(action);
    const { conference } = action;
    const state = getState();
    
    // Skip waiting logic for Jibri
    if (isJibriParticipant(state)) {
        return result;
    }
    
    // Set up listeners for participant changes
    if (conference) {
        conference.on(JitsiConferenceEvents.USER_JOINED, (id: string, user: any) => {
            const hasJWT = user.getIdentity()?.jwt || user.hasFeature?.('moderator');
            
            if (hasJWT) {
                // A moderator has joined, notify waiting participants
                dispatch(hostHasJoined());
            }
        });
        
        conference.on(JitsiConferenceEvents.USER_LEFT, () => {
            // Recheck if we should still wait for host
            dispatch(checkWaitingForHost());
        });
    }
    
    return result;
}

/**
 * Notifies the feature waiting-for-host that the action PARTICIPANT_JOINED is being dispatched.
 *
 * @param {Store} store - The redux store.
 * @param {Function} next - The redux dispatch function to dispatch the specified action to the specified store.
 * @param {Action} action - The redux action PARTICIPANT_JOINED which is being dispatched.
 * @private
 * @returns {Object} The new state that is the result of the reduction of the specified action.
 */
function _participantJoined({ dispatch, getState }: IStore, next: Function, action: AnyAction) {
    const result = next(action);
    const state = getState();
    const { participant } = action;
    
    // Skip waiting logic for Jibri
    if (isJibriParticipant(state)) {
        return result;
    }
    
    // If a moderator joined, allow waiting participants to join
    if (participant.role === 'moderator') {
        dispatch(hostHasJoined());
    } else {
        // Update waiting room count
        const conference = getCurrentConference(state);
        if (conference) {
            const participantCount = conference.getParticipantCount();
            dispatch(setWaitingRoomParticipantCount(participantCount));
        }
    }
    
    return result;
}

/**
 * Notifies the feature waiting-for-host that the action PARTICIPANT_LEFT is being dispatched.
 *
 * @param {Store} store - The redux store.
 * @param {Function} next - The redux dispatch function to dispatch the specified action to the specified store.
 * @param {Action} action - The redux action PARTICIPANT_LEFT which is being dispatched.
 * @private
 * @returns {Object} The new state that is the result of the reduction of the specified action.
 */
function _participantLeft({ dispatch, getState }: IStore, next: Function, action: AnyAction) {
    const result = next(action);
    const state = getState();
    
    // Skip waiting logic for Jibri
    if (isJibriParticipant(state)) {
        return result;
    }
    
    // Recheck if we should wait for host after someone leaves
    setTimeout(() => {
        dispatch(checkWaitingForHost());
        
        const conference = getCurrentConference(getState());
        if (conference) {
            const participantCount = conference.getParticipantCount();
            dispatch(setWaitingRoomParticipantCount(participantCount));
        }
    }, 1000); // Small delay to ensure participant count is updated
    
    return result;
}