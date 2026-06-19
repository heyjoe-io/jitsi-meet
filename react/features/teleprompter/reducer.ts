import ReducerRegistry from '../base/redux/ReducerRegistry';

import { SET_TELEPROMPTER } from './actionTypes';

export interface ITeleprompterState {

    /**
     * Font size (px) for the script text.
     */
    fontSize?: number;

    /**
     * Whether the script is auto-scrolling.
     */
    isScrolling?: boolean;

    /**
     * Direction of the most recent nudge (+1 down / -1 up).
     */
    nudgeDir?: number;

    /**
     * Increments to trigger a one-shot scroll nudge.
     */
    nudgeTrigger?: number;

    /**
     * Increments to trigger a scroll-to-top reset.
     */
    resetTrigger?: number;

    /**
     * The teleprompter script text.
     */
    script?: string;

    /**
     * Pixels-per-second auto-scroll speed.
     */
    scrollSpeed?: number;
}

ReducerRegistry.register<ITeleprompterState>(
    'features/teleprompter',
    (state = {}, action): ITeleprompterState => {
        switch (action.type) {
        case SET_TELEPROMPTER:
            return {
                ...state,
                ...action.payload
            };
        }

        return state;
    });
