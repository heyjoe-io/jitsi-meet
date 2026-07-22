import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconPin, IconPinned } from '../../../base/icons/svg';
import { MEDIA_TYPE, VIDEO_TYPE } from '../../../base/media/constants';
import { getRemoteParticipants, isLocalParticipantModerator } from '../../../base/participants/functions';
import { updateSettings } from '../../../base/settings/actions';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { addStageParticipant, removeStageParticipant } from '../../../filmstrip/actions.web';
import { isStageFilmstripAvailable } from '../../../filmstrip/functions.web';

/**
 * The type of the React {@code Component} props of {@link PinAllCamerasButton}.
 */
interface IProps extends AbstractButtonProps {

    /**
     * Array of participant IDs with camera enabled.
     */
    participantsWithCamera: string[];

    /**
     * Whether all camera participants are currently pinned.
     */
    allCamerasPinned: boolean;
}

/**
 * A button that pins/unpins every participant whose camera is on, raising the
 * stage cap so they all fit (the filmstrip otherwise keeps only
 * maxStageParticipants, default 1, and evicts the rest).
 */
class PinAllCamerasButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.pinAllCameras';
    override toggledAccessibilityLabel = 'toolbar.accessibilityLabel.unpinAllCameras';
    override icon = IconPin;
    override toggledIcon = IconPinned;
    override label = 'toolbar.pinAllCameras';
    override toggledLabel = 'toolbar.unpinAllCameras';
    override tooltip = 'toolbar.pinAllCameras';
    override toggledTooltip = 'toolbar.unpinAllCameras';

    /**
     * Toggles pin/unpin of all participants with camera enabled.
     *
     * @private
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch, participantsWithCamera, allCamerasPinned } = this.props;

        if (allCamerasPinned) {
            sendAnalytics(createToolbarEvent('unpin.all.cameras'));

            participantsWithCamera.forEach(participantId => {
                dispatch(removeStageParticipant(participantId));
            });

            // Restore the default stage cap once cameras are unpinned.
            dispatch(updateSettings({ maxStageParticipants: 1 }));
        } else {
            sendAnalytics(createToolbarEvent('pin.all.cameras'));

            // Raise the cap to fit EVERY on-camera participant before pinning,
            // otherwise the stage keeps only the first and drops the rest.
            dispatch(updateSettings({ maxStageParticipants: Math.max(1, participantsWithCamera.length) }));

            participantsWithCamera.forEach(participantId => {
                dispatch(addStageParticipant(participantId, true));
            });
        }
    }

    /**
     * Disabled when no participant has a camera on.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isDisabled() {
        return this.props.participantsWithCamera.length === 0;
    }

    /**
     * Toggled when all camera participants are pinned.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isToggled() {
        return this.props.allCamerasPinned;
    }
}

/**
 * Maps Redux state to component props.
 *
 * @param {Object} state - Redux state.
 * @returns {Object}
 */
function mapStateToProps(state: IReduxState) {
    const remoteParticipants = getRemoteParticipants(state);
    const participantsWithCamera: string[] = [];
    const stageFilmstripAvailable = isStageFilmstripAvailable(state);
    const { activeParticipants } = state['features/filmstrip'];
    const isModerator = isLocalParticipantModerator(state);

    remoteParticipants.forEach((participant, id) => {
        const videoSources = participant.sources?.get(MEDIA_TYPE.VIDEO);

        if (videoSources) {
            const hasCameraEnabled = Array.from(videoSources.values()).some(
                source => source.videoType === VIDEO_TYPE.CAMERA && !source.muted
            );

            if (hasCameraEnabled) {
                participantsWithCamera.push(id);
            }
        }
    });

    const pinnedParticipantIds = activeParticipants
        .filter(p => p.pinned)
        .map(p => p.participantId);

    const allCamerasPinned = participantsWithCamera.length > 0
        && participantsWithCamera.every(id => pinnedParticipantIds.includes(id));

    return {
        participantsWithCamera,
        allCamerasPinned,
        visible: isModerator && stageFilmstripAvailable && participantsWithCamera.length > 0
    };
}

export default translate(connect(mapStateToProps)(PinAllCamerasButton));
