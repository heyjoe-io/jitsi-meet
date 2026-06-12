import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, View, Text, NativeModules, NativeEventEmitter, Dimensions,
    TouchableOpacity, Platform } from 'react-native'
import { connect } from 'react-redux'
import DeviceInfo from 'react-native-device-info'
import { getLocalAudioTrack, getLocalVideoTrack } from '../../base/tracks/functions.any'
import { IReduxState, IStore } from '../../app/types'
import { ADD_NATIVE_LOCAL_RECORDING, SET_CURRENT_RECORDING_PATH,
    START_NATIVE_LOCAL_RECORDING, STOP_NATIVE_LOCAL_RECORDING } from '../actionTypes'
import styles from './styles'
import { IconRecord } from '../../base/icons/svg'
import { abortChunkedUpload, startChunkedUpload } from '../chunkedUpload'
import { addWsListener, removeWsListener, sendMessage, uploadLocalRecordingNative } from '../functions'

console.log("NativeModules", NativeModules)

// Use HighResRecorder for iOS (native 4K with H.265), fallback to legacy Recorder for Android
const HighResRecorder = NativeModules.HighResRecorder
const LegacyRecorder = NativeModules.Recorder

// iOS uses HighResRecorder (direct camera capture at native resolution)
// Android uses legacy Recorder (WebRTC-based)
const useHighResRecorder = Platform.OS === 'ios' && HighResRecorder != null

// Event emitter for native recording interruption events (iOS only)
const highResRecorderEmitter = useHighResRecorder
    ? new NativeEventEmitter(HighResRecorder)
    : null

let active = true

const formatDateString = (str?: string) => {
    if (!str) return ''
    return str.replace(/:/g, '-').replace('T', '-').replace(/\s/g, '-').replace(/\./g, '-').replace('Z', '')
}

const LocalRecordingButton = ({
    state,
    talent,
    videoTrack,
    audioTrack,
    mirror,
    isNativeLocalRecording,
    nativeLocalRecordings,
    roomName,
    currentRecordingPath,
    autoUploadLocalRecording,
    sessionId,
    talentId,

    setCurrentReccordingPath,
    startNativeLocalRecording,
    stopNativeLocalRecording,
    addNativeLocalRecording,
    uploadRecording,
    enable1080p,
    iosRecordingQuality
}) => {
    const recordingFilePath = useRef(currentRecordingPath)
    const [enabled, setEnabled]= useState(false)
    const startTime = useRef<Date | null>(null)

    const startRecording = useCallback(() => {
        if (!videoTrack) { return }

        startTime.current = new Date()
        const fileName = roomName + "_" + (+new Date())

        if (useHighResRecorder) {
            // iOS: Use HighResRecorder for native 4K with H.265
            // Pre-flight: force-reset any stale native recording state from room transitions
            const enable4K = iosRecordingQuality === '4K'
            console.log(`[HighResRecorder] Starting recording (${enable4K ? '4K' : '1080p'})...`)
            HighResRecorder.forceResetRecordingState().then((resetResult: any) => {
                if (resetResult.wasRecording) {
                    console.log('[HighResRecorder] Cleaned up stale recording state before starting')
                }
                return HighResRecorder.startRecording(
                    videoTrack.id,
                    fileName,
                    enable4K
                )
            }).then((result: { filePath: string, width: number, height: number }) => {
                console.log('[HighResRecorder] Recording started:', result)
                recordingFilePath.current = result.filePath
                setCurrentReccordingPath(result.filePath)
                startNativeLocalRecording()

                // Upload-while-recording: ship the growing file to S3 in parts so
                // only the tail remains when the take stops. On any failure the
                // post-stop flow falls back to the legacy whole-file upload.
                if (autoUploadLocalRecording) {
                    startChunkedUpload({
                        filePath: result.filePath,
                        fileName: result.filePath.split('/').pop(),
                        sessionId,
                        talentId,
                        token: state['features/talent'].token
                    })
                }
            }).catch((error: any) => {
                console.error('[HighResRecorder] Error starting recording:', error)
                Alert.alert("Recording Error", error.message || "Could not start recording")
            })
        } else {
            // Android/Fallback: Use legacy Recorder (WebRTC-based)
            const isLandScape = Dimensions.get('screen').width > Dimensions.get('screen').height
            let width = Math.max(videoTrack._constraints.width, videoTrack._constraints.height)
            let height = Math.min(videoTrack._constraints.width, videoTrack._constraints.height)
            if (!isLandScape) {
                width = Math.min(videoTrack._constraints.width, videoTrack._constraints.height)
                height = Math.max(videoTrack._constraints.width, videoTrack._constraints.height)
            }
            LegacyRecorder.startRecording(
                videoTrack.id,
                width,
                height,
                videoTrack._constraints.frameRate,
                mirror === true,
                fileName,
                enable1080p === true
            ).then((filePath: string) => {
                recordingFilePath.current = filePath
                setCurrentReccordingPath(filePath)
                startNativeLocalRecording()
            })
        }
    }, [enable1080p, iosRecordingQuality, videoTrack, nativeLocalRecordings, roomName, mirror,
        autoUploadLocalRecording, sessionId, talentId, state])

    // Shared bookkeeping for a finished recording file: reset redux state, add the
    // file to the recordings list and kick off auto-upload. Used by both the normal
    // stop path and the native interruption path (which also produces a valid file).
    const saveRecording = useCallback((fileSize: string, filePath?: string) => {
        stopNativeLocalRecording()
        const path = filePath || recordingFilePath.current
        if (path) {
            const endTime = new Date()
            const ext = path.split('.').pop()
            const upKey = `${state['features/talent'].studio?.jitsi_meeting_id}_${formatDateString(startTime.current?.toISOString())}_to_${formatDateString(endTime.toISOString())}.${ext}`
            addNativeLocalRecording(path, fileSize, startTime.current, endTime, upKey)
            if (autoUploadLocalRecording) {
                uploadRecording(state, path, sessionId, talentId, upKey)
            }
        }
    }, [sessionId, talentId, autoUploadLocalRecording, state])

    const stopRecording = useCallback(() => {
        const handleStopResult = (fileSize: string) => {
            if (fileSize.startsWith("ERROR:")) {
                Alert.alert("Error!", fileSize)
            }
            saveRecording(fileSize)
        }

        if (useHighResRecorder) {
            // iOS: Use HighResRecorder
            console.log('[HighResRecorder] Stopping recording...')
            HighResRecorder.stopRecording().then((result: { filePath: string, fileSize: string, width: number, height: number }) => {
                console.log('[HighResRecorder] Recording stopped:', result)
                handleStopResult(result.fileSize)
            }).catch((error: any) => {
                console.error('[HighResRecorder] Error stopping recording:', error)
                Alert.alert("Recording Error", error.message || "Could not stop recording")
                stopNativeLocalRecording()
                // No upload will follow a failed stop — release the multipart upload.
                abortChunkedUpload(recordingFilePath.current)
            })
        } else {
            // Android/Fallback: Use legacy Recorder
            LegacyRecorder.stopRecording().then((fileSize: string) => {
                handleStopResult(fileSize)
            })
        }
    }, [videoTrack, saveRecording])

    const handleRecordPress = () => {
        if (!isNativeLocalRecording) {
            startRecording()
        } else {
            stopRecording()
        }
    }

    const checkEnabled = async () => {
        setEnabled(false)
        if (Platform.OS === 'android') {
            const apiLevel = await DeviceInfo.getApiLevel();
            console.log('apiLevel', apiLevel)
            if (!active) { return }

            if (apiLevel >= 34) {
                setEnabled(true)
            }
        } else {
            if (!active) { return }
            setEnabled(true)
        }
    };

    useEffect(() => {
        active = true
        checkEnabled()
        return () => { active = false }
    }, [])

    useEffect(() => {
        if (!enabled) return
        const wsHandler = (ev: any) => { 
            const type = ev.message?.type
            switch (type) {
                case 'start-local-recording':
                    startRecording()
                    break
                case 'stop-local-recording':
                    stopRecording()
                    break
            }
        }
        addWsListener(wsHandler)
        return () => {
            removeWsListener(wsHandler)
        }
    }, [enabled, startRecording, stopRecording])

    // Listen for native recording interruption events (room transitions on iOS).
    // The capturer finalizes the file before interrupting, so when a file path is
    // included the partial segment is saved/uploaded instead of stranded on disk.
    useEffect(() => {
        if (!highResRecorderEmitter) return
        const subscription = highResRecorderEmitter.addListener(
            'onRecordingInterrupted',
            (event: any) => {
                console.log('[HighResRecorder] Recording interrupted by native:', event.reason, event.filePath)
                if (!isNativeLocalRecording) return
                if (event.filePath) {
                    saveRecording(event.fileSize || '0 B', event.filePath)
                } else {
                    stopNativeLocalRecording()
                }
            }
        )
        return () => {
            subscription.remove()
        }
    }, [isNativeLocalRecording, stopNativeLocalRecording, saveRecording])

    // Guard: when videoTrack is lost during a room transition, sync recording state
    useEffect(() => {
        if (!videoTrack && isNativeLocalRecording && useHighResRecorder) {
            console.log('[HighResRecorder] videoTrack lost while recording - checking native state')
            HighResRecorder.getRecordingCapabilities().then((caps: any) => {
                if (!caps.isRecording) {
                    console.log('[HighResRecorder] Native not recording - syncing JS state')
                    stopNativeLocalRecording()
                }
            }).catch(() => {
                stopNativeLocalRecording()
            })
        }
    }, [videoTrack, isNativeLocalRecording, stopNativeLocalRecording])

    useEffect(() => {
        if (!sessionId || !talentId) return
        let intervalHandler: NodeJS.Timeout | null = null
        if (isNativeLocalRecording) {
            intervalHandler = setInterval(() => {
                sendMessage(`talent-session-${sessionId}`, {
                    type: 'local-record-started',
                    talentId,
                })
            }, 1000);
        } else {
            sendMessage(`talent-session-${sessionId}`, {
                type: 'local-record-stopped',
                talentId,
            })
        }
        return () => {
            if (!intervalHandler) return
            clearInterval(intervalHandler)
        }
    }, [isNativeLocalRecording, sessionId, talentId])

    if (!videoTrack || !talent) return null
    if (!enabled) return null

    const color = isNativeLocalRecording ? "white": "black"

    return (
        <TouchableOpacity onPress={() => handleRecordPress()}>
            <View style={[
                styles.nativeRecordingButtonWrapper,
                { backgroundColor: isNativeLocalRecording ? "red": "rgba(255,255,255,0.8)" }
            ]}>
                <IconRecord fill={color} />
                <Text style={{ color, fontWeight: 900 }}>
                    {isNativeLocalRecording ? "STOP": "REC"}
                </Text>
            </View>
        </TouchableOpacity>
    )
}

function _mapStateToProps(state: IReduxState, ownProps: any) {
    const videoTrack = getLocalVideoTrack(state['features/base/tracks']);
    const audioTrack = getLocalAudioTrack(state['features/base/tracks']);
    const isNativeLocalRecording = state['features/talent'].isNativeLocalRecording
    const nativeLocalRecordings = state['features/talent'].nativeLocalRecordings || []
    const talent = state['features/talent'].talent
    const currentRecordingPath = state['features/talent'].currentRecordingPath
    const autoUploadLocalRecording = state['features/talent'].autoUploadLocalRecording
    const sessionId = state['features/talent'].session?._id
    const talentId = state['features/talent'].talent?._id
    const enable1080p = state['features/talent'].enable1080p
    const iosRecordingQuality = state['features/talent'].iosRecordingQuality || '1080p'

    const roomName = state['features/base/conference'].room

    console.log('videoTrack', isNativeLocalRecording)

    return {
        state,
        videoTrack: videoTrack?.jitsiTrack?.track,
        audioTrack: audioTrack?.jitsiTrack?.track,
        mirror: videoTrack?.mirror,
        currentRecordingPath,
        isNativeLocalRecording,
        nativeLocalRecordings,
        roomName,
        talent,
        autoUploadLocalRecording,
        sessionId,
        talentId,
        enable1080p,
        iosRecordingQuality
    };
}

function _mapDispatchToProps(dispatch: IStore['dispatch']) {
    const uploadRecording = (state, key, session, talent, upKey) => {
        return uploadLocalRecordingNative(
            state, dispatch, key, session, talent, upKey
        )
    }
    return {
        setCurrentReccordingPath(key: string) {
            dispatch({ type: SET_CURRENT_RECORDING_PATH, key })
        },
        startNativeLocalRecording() {
            dispatch({ type: START_NATIVE_LOCAL_RECORDING })
        },
        stopNativeLocalRecording() {
            dispatch({ type: STOP_NATIVE_LOCAL_RECORDING })
        },
        addNativeLocalRecording(key: string, fileSize: string, startTime: Date, endTime: Date, upKey: string) {
            dispatch({ type: ADD_NATIVE_LOCAL_RECORDING, key, fileSize, startTime, endTime, upKey })
        },
        uploadRecording
    };
}


export default connect(_mapStateToProps, _mapDispatchToProps)(LocalRecordingButton)
