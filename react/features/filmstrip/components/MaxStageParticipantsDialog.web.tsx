import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../app/types';
import Dialog from '../../base/ui/components/web/Dialog';
import { updateSettings } from '../../base/settings/actions';
import { MAX_ACTIVE_PARTICIPANTS } from '../constants';

const useStyles = makeStyles()(() => {
    return {
        container: {
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            padding: '16px'
        },
        optionButton: {
            padding: '12px 16px',
            border: '1px solid #ccc',
            borderRadius: '6px',
            cursor: 'pointer',
            textAlign: 'center',
            transition: 'all 0.2s',
            fontSize: '16px',
            '&:hover': {
                backgroundColor: '#f0f0f0'
            }
        },
        selected: {
            backgroundColor: '#0074e0',
            color: 'white',
            borderColor: '#0074e0',
            '&:hover': {
                backgroundColor: '#005bb5'
            }
        }
    };
});

/**
 * Dialog to select the maximum number of stage participants.
 *
 * @returns {JSX.Element}
 */
function MaxStageParticipantsDialog() {
    const { classes, cx } = useStyles();
    const { t } = useTranslation();
    const dispatch = useDispatch();

    const maxStageParticipants = useSelector((state: IReduxState) =>
        state['features/base/settings'].maxStageParticipants ?? 6
    );

    const handleSelect = useCallback((value: number) => {
        dispatch(updateSettings({ maxStageParticipants: value }));
    }, [dispatch]);

    const options = Array.from({ length: MAX_ACTIVE_PARTICIPANTS }, (_, i) => i + 1);

    return (
        <Dialog
            cancel = {{ hidden: true }}
            ok = {{ hidden: true }}
            titleKey = 'toolbar.maxStageParticipants'>
            <div className = { classes.container }>
                <p>{t('settings.maxStageParticipantsDescription',
                    'Select the maximum number of participants that can be pinned to the main stage')}</p>
                {options.map(value => (
                    <button
                        className = { cx(classes.optionButton, maxStageParticipants === value && classes.selected) }
                        key = { value }
                        onClick = { () => handleSelect(value) }
                        type = 'button'>
                        {value} {value === 1 ? t('settings.participant') : t('settings.participants')}
                    </button>
                ))}
            </div>
        </Dialog>
    );
}

export default MaxStageParticipantsDialog;
