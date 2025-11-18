import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconPin } from '../../../base/icons/svg';
import { MEDIA_TYPE, VIDEO_TYPE } from '../../../base/media/constants';
import { getRemoteParticipants } from '../../../base/participants/functions';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { addStageParticipant } from '../../../filmstrip/actions.web';
import { isStageFilmstripAvailable } from '../../../filmstrip/functions.web';

/**
 * The type of the React {@code Component} props of {@link PinAllCamerasButton}.
 */
interface IProps extends AbstractButtonProps {

    /**
     * Array of participant IDs with camera enabled.
     */
    participantsWithCamera: string[];
}

/**
 * Implementation of a button for pinning all participants with camera enabled.
 */
class PinAllCamerasButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.pinAllCameras';
    override icon = IconPin;
    override label = 'toolbar.pinAllCameras';
    override tooltip = 'toolbar.pinAllCameras';

    /**
     * Handles clicking the button to add all participants with camera enabled to stage.
     *
     * @private
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch, participantsWithCamera } = this.props;

        sendAnalytics(createToolbarEvent('pin.all.cameras'));

        console.log('PinAllCamerasButton: Adding participants to stage:', participantsWithCamera);

        participantsWithCamera.forEach(participantId => {
            console.log('PinAllCamerasButton: Adding participant to stage:', participantId);
            dispatch(addStageParticipant(participantId, true));
        });
    }

    /**
     * Indicates whether this button is disabled or not.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isDisabled() {
        return this.props.participantsWithCamera.length === 0;
    }
}

/**
 * Function that maps parts of Redux state tree into component props.
 *
 * @param {Object} state - Redux state.
 * @returns {Object}
 */
function mapStateToProps(state: IReduxState) {
    const remoteParticipants = getRemoteParticipants(state);
    const participantsWithCamera: string[] = [];
    const stageFilmstripAvailable = isStageFilmstripAvailable(state);

    console.log('PinAllCamerasButton: Total remote participants:', remoteParticipants.size);
    console.log('PinAllCamerasButton: Stage filmstrip available:', stageFilmstripAvailable);

    remoteParticipants.forEach((participant, id) => {
        if (participant.sources) {
            const videoSources = participant.sources.get(MEDIA_TYPE.VIDEO);

            if (videoSources) {
                const hasCameraEnabled = Array.from(videoSources.values()).some(
                    source => source.videoType === VIDEO_TYPE.CAMERA && !source.muted
                );

                console.log(`PinAllCamerasButton: Participant ${id} has camera:`, hasCameraEnabled, 'videoSources:', videoSources);

                if (hasCameraEnabled) {
                    participantsWithCamera.push(id);
                }
            }
        }
    });

    console.log('PinAllCamerasButton: Participants with camera:', participantsWithCamera);

    return {
        participantsWithCamera,
        visible: stageFilmstripAvailable && participantsWithCamera.length > 0
    };
}

export default translate(connect(mapStateToProps)(PinAllCamerasButton));
