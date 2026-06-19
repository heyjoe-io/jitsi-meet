import { AnyAction } from 'redux';

import { IStore } from '../app/types';
import { ENDPOINT_MESSAGE_RECEIVED } from '../base/conference/actionTypes';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';

import { setTeleprompter } from './actions';

/**
 * Receives teleprompter payloads the Casting Admin broadcasts over the Jitsi data
 * channel. The CD sends them as endpoint text messages (the External API's
 * `sendEndpointTextMessage` → `sendEndpointMessage(to, { name: 'endpoint-text-message',
 * text })`, where `text` is `JSON.stringify({ type: 'teleprompter', payload })`).
 * We parse that and store the payload so the native overlay can render it.
 */
MiddlewareRegistry.register((store: IStore) => (next: Function) => (action: AnyAction) => {
    const result = next(action);

    if (action.type === ENDPOINT_MESSAGE_RECEIVED) {
        const { data } = action;

        if (data?.name === 'endpoint-text-message' && typeof data.text === 'string') {
            let parsed;

            try {
                parsed = JSON.parse(data.text);
            } catch (e) {
                return result;
            }

            if (parsed?.type === 'teleprompter' && parsed.payload) {
                store.dispatch(setTeleprompter(parsed.payload));
            }
        }
    }

    return result;
});
