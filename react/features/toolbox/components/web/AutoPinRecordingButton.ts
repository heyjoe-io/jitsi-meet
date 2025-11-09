import { connect } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconPin, IconPinned } from '../../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { toggleAutoPinRecording } from '../../../recording/actions.any';
import { isCloudRecordingRunning } from '../../../recording/functions';

interface IProps extends AbstractButtonProps {

    /**
     * Whether auto-pin recording is enabled.
     */
    _autoPinEnabled: boolean;

    /**
     * Whether recording is currently running.
     */
    _isRecording: boolean;
}

/**
 * Implementation of a button for toggling auto-pin recording feature.
 */
class AutoPinRecordingButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.autoPinRecording';
    override toggledAccessibilityLabel = 'toolbar.accessibilityLabel.autoPinRecordingDisabled';
    override label = 'toolbar.autoPinRecording';
    override toggledLabel = 'toolbar.autoPinRecordingDisabled';
    override tooltip = 'toolbar.autoPinRecording';
    override toggledTooltip = 'toolbar.autoPinRecordingDisabled';
    override icon = IconPin;
    override toggledIcon = IconPinned;

    /**
     * Indicates whether this button is in toggled state or not.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isToggled() {
        return this.props._autoPinEnabled;
    }

    /**
     * Handles clicking the button, and toggles auto-pin recording.
     *
     * @private
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch, _autoPinEnabled } = this.props;

        sendAnalytics(createToolbarEvent(
            'toggle.autopin.recording',
            {
                enable: !_autoPinEnabled
            }));

        dispatch(toggleAutoPinRecording());
    }
}

/**
 * Function that maps parts of Redux state tree into component props.
 *
 * @param {Object} state - Redux state.
 * @returns {Object}
 */
const mapStateToProps = (state: IReduxState) => {
    return {
        _autoPinEnabled: state['features/recording'].autoPinEnabled,
        _isRecording: isCloudRecordingRunning(state),
        visible: true
    };
};

export default translate(connect(mapStateToProps)(AutoPinRecordingButton));
