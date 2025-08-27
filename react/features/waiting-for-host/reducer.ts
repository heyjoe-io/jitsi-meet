import { AnyAction } from 'redux';
import ReducerRegistry from '../base/redux/ReducerRegistry';

import {
    SET_WAITING_FOR_HOST,
    SET_WAITING_ROOM_PARTICIPANT_COUNT
} from './actionTypes';

export interface IWaitingForHostState {
    waiting: boolean;
    participantCount: number;
}

const DEFAULT_STATE: IWaitingForHostState = {
    waiting: false,
    participantCount: 0
};

/**
 * Reduces the Redux actions of the feature waiting-for-host.
 */
ReducerRegistry.register<IWaitingForHostState>('features/waiting-for-host', (state = DEFAULT_STATE, action: AnyAction) => {
    switch (action.type) {
    case SET_WAITING_FOR_HOST:
        return {
            ...state,
            waiting: action.waiting
        };
    
    case SET_WAITING_ROOM_PARTICIPANT_COUNT:
        return {
            ...state,
            participantCount: action.count
        };
    
    default:
        return state;
    }
});