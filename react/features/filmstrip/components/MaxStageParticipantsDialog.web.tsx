import React, { useCallback } from 'react';
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
        selectWrapper: {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
        },
        select: {
            padding: '12px 16px',
            border: '1px solid #ccc',
            borderRadius: '6px',
            fontSize: '16px',
            cursor: 'pointer',
            backgroundColor: 'white',
            '&:focus': {
                outline: '2px solid #0074e0',
                borderColor: '#0074e0'
            }
        },
        description: {
            margin: 0,
            fontSize: '14px',
            color: '#666'
        }
    };
});

/**
 * Dialog to select the maximum number of stage participants.
 *
 * @returns {JSX.Element}
 */
function MaxStageParticipantsDialog() {
    const { classes } = useStyles();
    const { t } = useTranslation();
    const dispatch = useDispatch();

    const maxStageParticipants = useSelector((state: IReduxState) =>
        state['features/base/settings'].maxStageParticipants ?? 6
    );

    const handleChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        const value = parseInt(event.target.value, 10);
        dispatch(updateSettings({ maxStageParticipants: value }));
    }, [dispatch]);

    const options = Array.from({ length: MAX_ACTIVE_PARTICIPANTS }, (_, i) => i + 1);

    return (
        <Dialog
            cancel = {{ hidden: true }}
            ok = {{ hidden: true }}
            titleKey = 'toolbar.maxStageParticipants'>
            <div className = { classes.container }>
                <p className = { classes.description }>
                    {t('settings.maxStageParticipantsDescription',
                        'Set the maximum number of participants to appear on the main stage during the recording. (Only adjust this if you are recording the session.)')}
                </p>
                <div className = { classes.selectWrapper }>
                    <label htmlFor = 'max-stage-participants-select'>
                        {t('settings.maxStageParticipantsLabel', 'Maximum stage participants')}
                    </label>
                    <select
                        className = { classes.select }
                        id = 'max-stage-participants-select'
                        onChange = { handleChange }
                        value = { maxStageParticipants }>
                        {options.map(value => (
                            <option
                                key = { value }
                                value = { value }>
                                {value}
                            </option>
                        ))}
                    </select>
                </div>
            </div>
        </Dialog>
    );
}

export default MaxStageParticipantsDialog;
