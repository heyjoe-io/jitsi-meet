import { useCallback, useEffect, useRef } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import { useSelector } from 'react-redux';

import { IReduxState } from '../../../../app/types';
import { addWsListener, removeWsListener, sendMessage } from '../../../../onboard/functions';

const { GimbalControl } = NativeModules;

const gimbalEmitter = GimbalControl ? new NativeEventEmitter(GimbalControl) : null;

/**
 * The seven V1 discrete commands the CD may send. Anything else is rejected by
 * the phone so a future/typo'd command can't be silently dropped. Continuous
 * press-and-hold moves (move_start / move_keepalive / move_stop, per
 * Gimbal_Continuous_PanTilt_Spec) are handled separately before this check.
 */
const ALLOWED_COMMANDS = [
    'start_tracking',
    'stop_tracking',
    'recenter',
    'pan_left',
    'pan_right',
    'tilt_up',
    'tilt_down'
];

/** Directions a continuous hold may move in. */
const MOVE_DIRECTIONS = [ 'pan_left', 'pan_right', 'tilt_up', 'tilt_down' ];

/**
 * RemoteGimbalControl — headless (renders nothing). Lets the Casting Admin drive a
 * DockKit-controlled gimbal (e.g. Insta360 Flow) attached to the talent's phone.
 *
 * Same asymmetric rooms as RemoteCameraControl: the phone only JOINS
 * `talent-${talentId}`, so CD→phone commands arrive there; the phone reports to
 * `talent-session-${sessionId}`, which the CD joins.
 *
 * CD → phone (room `talent-${talentId}`):
 *   { type: 'admin.gimbal.command', sessionId, targetParticipantId, command, requestId }
 *       command ∈ ALLOWED_COMMANDS. targetParticipantId is the talentId in our model.
 *
 * Phone → CD (room `talent-session-${sessionId}`):
 *   { type: 'device.gimbal.command_result', requestId, ok, status:{connected,tracking} }
 *       or on failure { type: 'device.gimbal.command_result', requestId, ok:false, error }
 *   { type: 'device.gimbal.status', talentId, supported, connected, tracking }
 *       Capability signal — sent on mount and whenever the gimbal connects/disconnects
 *       or tracking changes. The CD enables controls only when supported && connected.
 *
 * Gimbal control is iOS 17+ / DockKit only; on anything else the native module
 * reports supported:false and every command fails cleanly.
 */
const RemoteGimbalControl = () => {
    const sessionId = useSelector((state: IReduxState) => state['features/talent'].session?._id);
    const talentId = useSelector((state: IReduxState) => state['features/talent'].talent?._id);

    const sessionIdRef = useRef(sessionId);
    const talentIdRef = useRef(talentId);

    sessionIdRef.current = sessionId;
    talentIdRef.current = talentId;

    /** Push the current capability/status to the CD so it can enable/disable controls. */
    const reportStatus = useCallback(async () => {
        if (!sessionIdRef.current || !talentIdRef.current || !GimbalControl?.getStatus) {
            return;
        }

        try {
            const status = await GimbalControl.getStatus();

            sendMessage(`talent-session-${sessionIdRef.current}`, {
                type: 'device.gimbal.status',
                talentId: talentIdRef.current,
                supported: Boolean(status.supported),
                connected: Boolean(status.connected),
                tracking: Boolean(status.tracking),

                // Press-and-hold pan/tilt capability — the CD panel switches
                // the D-pad to hold mode only when it sees this flag.
                continuousMove: Boolean(GimbalControl?.startMove)
            });
        } catch {
            // Native unavailable (old build / non-iOS) — stay silent; the CD simply
            // never sees a gimbal-status and keeps the controls disabled.
        }
    }, []);

    // Handle CD commands.
    useEffect(() => {
        if (!GimbalControl?.executeCommand) {
            return undefined;
        }

        const handler = (ev: any) => {
            const msg = ev.message;

            if (msg?.type !== 'admin.gimbal.command') {
                return;
            }

            const { command, requestId } = msg;
            const session = sessionIdRef.current;

            const respond = (body: any) =>
                sendMessage(`talent-session-${session}`, {
                    type: 'device.gimbal.command_result',
                    requestId,
                    ...body
                });

            // Continuous press-and-hold moves. Per spec: only failures reply
            // (requestId = moveId) — success is silence, and the web side sets
            // no timeout on moves. keepalive/stop never reply; the native
            // dead-man watchdog (1s without keepalive → stop) is the safety
            // net, so a lost stop can't leave the gimbal spinning.
            if (command === 'move_start') {
                if (!GimbalControl.startMove) {
                    respond({ ok: false, error: 'Continuous move not supported by this build' });

                    return;
                }
                if (!MOVE_DIRECTIONS.includes(msg.direction)) {
                    respond({ ok: false, error: `Unsupported direction: ${msg.direction}` });

                    return;
                }
                GimbalControl.startMove(msg.direction, msg.moveId)
                    .then((result: any) => {
                        if (!result.ok) {
                            respond({ ok: false, error: result.error || 'Gimbal move failed' });
                        }
                    })
                    .catch((error: any) => {
                        respond({ ok: false, error: error?.message || 'Gimbal move failed' });
                    });

                return;
            }
            if (command === 'move_keepalive') {
                GimbalControl.moveKeepalive?.(msg.moveId);

                return;
            }
            if (command === 'move_stop') {
                GimbalControl.stopMove?.(msg.moveId);

                return;
            }

            if (!ALLOWED_COMMANDS.includes(command)) {
                respond({ ok: false, error: `Unsupported command: ${command}` });

                return;
            }

            console.log('[RemoteGimbalControl] Executing gimbal command:', command);
            GimbalControl.executeCommand(command)
                .then((result: any) => {
                    if (result.ok) {
                        respond({
                            ok: true,
                            status: {
                                connected: Boolean(result.connected),
                                tracking: Boolean(result.tracking)
                            }
                        });
                    } else {
                        respond({ ok: false, error: result.error || 'Gimbal command failed' });
                    }
                    // A command may have changed connected/tracking — refresh the CD.
                    reportStatus();
                })
                .catch((error: any) => {
                    respond({ ok: false, error: error?.message || 'Gimbal command failed' });
                });
        };

        addWsListener(handler);

        return () => removeWsListener(handler);
    }, [ reportStatus ]);

    // Report status on mount and whenever the native module signals a change
    // (gimbal docked/undocked, tracking toggled).
    useEffect(() => {
        reportStatus();

        if (!gimbalEmitter) {
            return undefined;
        }

        const sub = gimbalEmitter.addListener('onGimbalStatus', () => reportStatus());

        return () => sub.remove();
    }, [ reportStatus ]);

    // Re-announce when the session/talent identity resolves (mount can beat it).
    useEffect(() => {
        reportStatus();
    }, [ sessionId, talentId, reportStatus ]);

    return null;
};

export default RemoteGimbalControl;
