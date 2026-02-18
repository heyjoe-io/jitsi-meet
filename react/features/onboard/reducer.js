import PersistenceRegistry from '../base/redux/PersistenceRegistry';
import ReducerRegistry from '../base/redux/ReducerRegistry';

import {
    ADD_NATIVE_LOCAL_RECORDING,
    REMOVE_NATIVE_LOCAL_RECORDING,
    SET_CURRENT_RECORDING_PATH,
    SET_LOCAL_RECORD_AUTO_UPLOAD,
    SET_ONBOARD,
    SET_TALENT_INFO,
    SET_ENABLE_1080P,
    START_NATIVE_LOCAL_RECORDING,
    STOP_NATIVE_LOCAL_RECORDING,
    UPDATE_LOCAL_RECORDING_STATUS,
    UPLOAD_NATIVE_LOCAL_RECORDING_FINISH,
    UPLOAD_NATIVE_LOCAL_RECORDING_START,
    UPDATE_UPLOAD_PROGRESS,
    SET_UPLOAD_ERROR,
    SET_IOS_RECORDING_QUALITY,
} from './actionTypes';

/**
 * The name of the redux store/state property which is the root of the redux
 * state of the feature {@code welcome}.
 */
export const STORE_NAME = 'features/talent';

/**
 * Sets up the persistence of the feature {@code welcome}.
 */
PersistenceRegistry.register(STORE_NAME);

/**
 * Reduces redux actions for the purposes of the feature {@code welcome}.
 */
ReducerRegistry.register(STORE_NAME, (state = {
    autoUploadLocalRecording: true,
    enable1080p: true,
    iosRecordingQuality: '1080p'
}, action) => {
    let idx = -1;
    console.log('action ', action)
    switch (action.type) {
        case SET_ONBOARD:
            return {
                ...state,
                onboardUrl: action.url,
                talent: null
            };

        case SET_TALENT_INFO:
            return {
                ...state,
                talent: action.talent,
                studio: action.studio || state.studio,
                session: action.session || state.session,
                token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFwcEBoZXlqb2UuaW8iLCJsb2dvIjpudWxsLCJpYXQiOjE3MzE3NzQ4ODB9.wJpYoLNNZVsHGU4jZIO_JER1F2Ixxas-7n5s9SPbajE'
            };

        case SET_CURRENT_RECORDING_PATH:
            return {
                ...state,
                currentRecordingPath: action.key
            }

        case START_NATIVE_LOCAL_RECORDING:
            return {
                ...state,
                isNativeLocalRecording: true
            }

        case STOP_NATIVE_LOCAL_RECORDING:
            return {
                ...state,
                isNativeLocalRecording: false
            }

        case ADD_NATIVE_LOCAL_RECORDING:
            return {
                ...state,
                nativeLocalRecordings: (state.nativeLocalRecordings || []).concat({
                    key: action.key,
                    fileSize: action.fileSize,
                    startTime: action.startTime,
                    endTime: action.endTime,
                    upKey: action.upKey,
                    timestamp: new Date(),
                    status: 'pending',
                    studio: {
                        jitsi_meeting_id: state.studio?.jitsi_meeting_id,
                        name: state.studio?.name
                    },
                    session: {
                        id: state.session?._id,
                        name: state.session?.name,
                    },
                    talent: {
                        id: state.talent?._id,
                        name: `${state.talent?.first_name} ${state.talent?.last_name}`,
                        role: state.talent?.role
                    }
                }),
            }

        case REMOVE_NATIVE_LOCAL_RECORDING:
            return {
                ...state,
                nativeLocalRecordings: state.nativeLocalRecordings.filter(item => !(action.keys || []).includes(item.key)),
            }

        case UPLOAD_NATIVE_LOCAL_RECORDING_START:
            idx =  state.nativeLocalRecordings.findIndex(k => k.key === action.key)
            return {
                ...state,
                nativeLocalRecordings: state.nativeLocalRecordings.map((k, i) => i !== idx ? k : { ...k, status: 'uploading', progress: 0 })
            }

        case UPLOAD_NATIVE_LOCAL_RECORDING_FINISH:
            idx =  state.nativeLocalRecordings.findIndex(k => k.key === action.key)
            return {
                ...state,
                nativeLocalRecordings: state.nativeLocalRecordings.map((k, i) => i !== idx ? k : { ...k, status: action.ok ? 'uploaded': 'upload_failed' })
            }

        case UPDATE_LOCAL_RECORDING_STATUS:
            idx =  state.nativeLocalRecordings.findIndex(k => k.key === action.key)
            return {
                ...state,
                nativeLocalRecordings: state.nativeLocalRecordings.map((k, i) => i !== idx ? k : { ...k, status: action.status })
            }

        case UPDATE_UPLOAD_PROGRESS:
            idx =  state.nativeLocalRecordings.findIndex(k => k.key === action.key)
            return {
                ...state,
                nativeLocalRecordings: state.nativeLocalRecordings.map((k, i) => i !== idx ? k : { ...k, progress: action.progress })
            }

        case SET_UPLOAD_ERROR:
            idx =  state.nativeLocalRecordings.findIndex(k => k.key === action.key)
            return {
                ...state,
                nativeLocalRecordings: state.nativeLocalRecordings.map((k, i) => i !== idx ? k : { ...k, error: action.error })
            }

        case SET_LOCAL_RECORD_AUTO_UPLOAD:
            return {
                ...state,
                autoUploadLocalRecording: action.enabled
            }
        
        case SET_ENABLE_1080P:
            return {
                ...state,
                enable1080p: action.enabled
            }

        case SET_IOS_RECORDING_QUALITY:
            return {
                ...state,
                iosRecordingQuality: action.quality
            }

        default:
            return state;
    }
});
