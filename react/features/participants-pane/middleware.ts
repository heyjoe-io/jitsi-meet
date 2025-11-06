import { AnyAction } from 'redux';

import JitsiMeetJS from '../base/lib-jitsi-meet';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';

import { PARTICIPANTS_PANE_CLOSE, PARTICIPANTS_PANE_OPEN } from './actionTypes';

/**
 * Middleware which intercepts participants pane actions.
 *
 * @param {IStore} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(({ getState }) => (next: Function) => (action: AnyAction) => {
    switch (action.type) {
    case PARTICIPANTS_PANE_OPEN: {
        const state = getState();
        const { sessionDatas } = state['features/recording'];
        const isRecording = sessionDatas.some(
            (session: any) => session.mode === JitsiMeetJS.constants.recording.mode.FILE
                && session.status === JitsiMeetJS.constants.recording.status.ON
        );

        if (isRecording) {
            return;
        }

        if (typeof APP !== 'undefined') {
            APP.API.notifyParticipantsPaneToggled(true);
        }
        break;
    }
    case PARTICIPANTS_PANE_CLOSE:
        if (typeof APP !== 'undefined') {
            APP.API.notifyParticipantsPaneToggled(false);
        }
        break;
    }

    return next(action);
});
