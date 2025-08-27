import React from 'react';
import { connect } from 'react-redux';

import { translate } from '../../base/i18n/functions';
import { IReduxState } from '../../app/types';

import { getWaitingRoomParticipantCount, isWaitingForHost } from '../functions';

interface IProps {
    
    /**
     * True if waiting for host.
     */
    _isWaiting: boolean;
    
    /**
     * Number of participants waiting.
     */
    _participantCount: number;
    
    /**
     * Invoked to obtain translated strings.
     */
    t: Function;
}

/**
 * Component that renders the waiting for host screen.
 */
class WaitingForHostScreen extends React.Component<IProps> {
    
    /**
     * Implements React's {@link Component#render()}.
     *
     * @inheritdoc
     * @returns {ReactElement}
     */
    override render() {
        const { _isWaiting, _participantCount, t } = this.props;
        
        if (!_isWaiting) {
            return null;
        }
        
        return (
            <div className = 'waiting-for-host-screen'>
                <div className = 'waiting-for-host-content'>
                    <div className = 'waiting-for-host-icon'>
                        <i className = 'icon-users' />
                    </div>
                    <h2 className = 'waiting-for-host-title'>
                        {t('waitingForHost.title')}
                    </h2>
                    <p className = 'waiting-for-host-message'>
                        {t('waitingForHost.message')}
                    </p>
                    {_participantCount > 0 && (
                        <p className = 'waiting-for-host-count'>
                            {t('waitingForHost.participantCount', { count: _participantCount })}
                        </p>
                    )}
                    <div className = 'waiting-for-host-spinner'>
                        <div className = 'spinner' />
                    </div>
                </div>
            </div>
        );
    }
}

/**
 * Maps (parts of) the Redux state to the associated props for this component.
 *
 * @param {Object} state - The Redux state.
 * @private
 * @returns {IProps}
 */
function _mapStateToProps(state: IReduxState) {
    return {
        _isWaiting: isWaitingForHost(state),
        _participantCount: getWaitingRoomParticipantCount(state)
    };
}

export default translate(connect(_mapStateToProps)(WaitingForHostScreen));