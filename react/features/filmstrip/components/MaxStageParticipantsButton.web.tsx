import { connect } from 'react-redux';

import { createToolbarEvent } from '../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../analytics/functions';
import { IReduxState } from '../../app/types';
import { openDialog } from '../../base/dialog/actions';
import { translate } from '../../base/i18n/functions';
import { IconMeter } from '../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../base/toolbox/components/AbstractButton';
import { isStageFilmstripEnabled } from '../functions';

import MaxStageParticipantsDialog from './MaxStageParticipantsDialog.web';

/**
 * The type of the React {@code Component} props of
 * {@link MaxStageParticipantsButton}.
 */
interface IProps extends AbstractButtonProps {

    /**
     * The currently configured maximum number of stage participants.
     */
    _maxStageParticipants: number;

    /**
     * Whether the stage filmstrip is enabled.
     */
    _stageFilmstripEnabled: boolean;
}

/**
 * React {@code Component} responsible for displaying a button in the toolbar
 * to open a dialog for selecting the maximum number of stage participants.
 *
 * @augments Component
 */
class MaxStageParticipantsButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.maxStageParticipants';
    override label = 'toolbar.maxStageParticipants';
    override tooltip = 'toolbar.maxStageParticipants';
    override icon = IconMeter;

    /**
     * Handles clicking the button, and opens the dialog.
     *
     * @private
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch } = this.props;

        sendAnalytics(createToolbarEvent('max.stage.participants'));

        dispatch(openDialog(MaxStageParticipantsDialog));
    }
}

/**
 * Maps part of the Redux state to the props of this component.
 *
 * @param {Object} state - The Redux state.
 * @returns {IProps}
 */
function _mapStateToProps(state: IReduxState) {
    const stageFilmstripEnabled = isStageFilmstripEnabled(state);

    return {
        _maxStageParticipants: state['features/base/settings'].maxStageParticipants ?? 6,
        _stageFilmstripEnabled: stageFilmstripEnabled,
        visible: true // Always show the button
    };
}

export default translate(connect(_mapStateToProps)(MaxStageParticipantsButton));
