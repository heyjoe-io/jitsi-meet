import { IStateful } from '../base/app/types';
import { toState } from '../base/redux/functions';
import { iAmVisitor } from '../visitors/functions';

/**
 * Tells whether or not the notifications should be displayed within
 * the conference feature based on the current Redux state.
 *
 * @param {Object|Function} stateful - The redux store state.
 * @returns {boolean}
 */
export function shouldDisplayNotifications(stateful: IStateful) {
    const state = toState(stateful);
    const { calleeInfoVisible } = state['features/invite'];

    return !calleeInfoVisible;
}


/**
 *
 * Returns true if polls feature is disabled.
 *
 * @param {(Function|Object)} stateful - The (whole) redux state, or redux's
 * {@code getState} function to be used to retrieve the state
 * features/base/config.
 * @returns {boolean}
 */
export function arePollsDisabled(stateful: IStateful) {
    const state = toState(stateful);

    // NOTE: lib-jitsi-meet pinned in this fork has no JitsiConference.getPolls();
    // calling conference.getPolls() (from newer upstream) throws "undefined is not
    // a function" inside a redux state listener on conference join, tearing down
    // the React tree (brand-yellow blank screen). Keep the pre-merge behavior:
    // polls are gated by config + visitor status, no lib polls API required.
    return state['features/base/config']?.disablePolls || iAmVisitor(state);
}
