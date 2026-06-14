import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, View, Text, NativeModules, NativeEventEmitter, Dimensions,
    TouchableOpacity, Platform } from 'react-native'
import { connect } from 'react-redux'
import DeviceInfo from 'react-native-device-info'
import { getLocalAudioTrack, getLocalVideoTrack } from '../../../base/tracks/functions.any'
import { IReduxState, IStore } from '../../app/types'
import { ADD_NATIVE_LOCAL_RECORDING, SET_CURRENT_RECORDING_PATH,
    START_NATIVE_LOCAL_RECORDING, STOP_NATIVE_LOCAL_RECORDING } from '../../../onboard/actionTypes'
import styles from './styles'
import { IconRecord } from '../../../base/icons/svg'
import { abortChunkedUpload, startChunkedUpload } from '../../../onboard/chunkedUpload'
import { addWsListener, removeWsListener, sendMessage, uploadLocalRecordingNative } from '../../../onboard/functions'

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
                        token: state['features/talent'].token,
                        // Drive the CD's per-talent upload bar while recording — the
                        // pump uploads parts as the file grows, so without this the
                        // bar sits at 0 then jumps to done at stop. The CD chip keys
                        // on talentId, same message shape as the legacy/finish path.
                        onProgress: (progress: number) => {
                            sendMessage(`talent-session-${sessionId}`, {
                                type: 'upload-progress', talentId, sessionId, progress
                            })
                        }
                    })
                }
            }).catch((error: any) => {
                console.error('[HighResRecorder] Error starting recording:', error)
                Alert.alert("Recording Error", `Could not start recording: ${error.message || "Unknown error"}`)
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
                setTimeout(() => {
                    uploadRecording(state, path, sessionId, talentId, upKey)
                }, 1000)
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
                Alert.alert("Recording Error", `Could not stop recording: ${error.message || "Unknown error"}`)
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
                    // When triggered via WS (from CD), the message may arrive before
                    // the capture session is fully ready after a room transition.
                    // Check native capturer readiness and retry if not ready.
                    if (useHighResRecorder) {
                        const attemptStart = (retries: number) => {
                            HighResRecorder.getRecordingCapabilities()
                                .then((caps: any) => {
                                    if (caps.isCapturing && !caps.isRecording) {
                                        startRecording()
                                    } else if (retries < 3) {
                                        console.log(`[HighResRecorder] WS start: capturer not ready (isCapturing=${caps.isCapturing}, isRecording=${caps.isRecording}), retry ${retries + 1}/3`)
                                        setTimeout(() => attemptStart(retries + 1), 1500)
                                    } else {
                                        console.warn('[HighResRecorder] WS start: capturer not ready after 3 retries, attempting anyway')
                                        startRecording()
                                    }
                                })
                                .catch(() => {
                                    if (retries < 3) {
                                        setTimeout(() => attemptStart(retries + 1), 1500)
                                    } else {
                                        startRecording()
                                    }
                                })
                        }
                        attemptStart(0)
                    } else {
                        startRecording()
                    }
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

    // Listen for mid-stream recording failures (writer setup/append errors).
    // Without this, JS thinks recording is active but native has already stopped,
    // causing the error to only surface when stop is triggered (often from CD via WS).
    useEffect(() => {
        if (!highResRecorderEmitter) return
        const subscription = highResRecorderEmitter.addListener(
            'onRecordingFailed',
            (event: any) => {
                console.error('[HighResRecorder] Recording failed mid-stream:', event.error)
                if (isNativeLocalRecording) {
                    stopNativeLocalRecording()
                    // The writer cancelled — the file is gone, release the multipart upload.
                    abortChunkedUpload(recordingFilePath.current)
                    Alert.alert("Recording Error", `Recording failed: ${event.error || "Unknown error"}`)
                }
            }
        )
        return () => {
            subscription.remove()
        }
    }, [isNativeLocalRecording, stopNativeLocalRecording])

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

    // Fix #4: Sync recording state on mount / new room join.
    // If the component remounts after a room transition and JS still thinks
    // recording is active (notification was missed), check native state and reset.
    useEffect(() => {
        if (!useHighResRecorder || !videoTrack) return
        if (isNativeLocalRecording) {
            HighResRecorder.getRecordingCapabilities().then((caps: any) => {
                if (!caps.isRecording) {
                    console.log('[HighResRecorder] Mount sync: JS says recording but native is not - resetting')
                    stopNativeLocalRecording()
                }
            }).catch(() => {})
        }
    }, [videoTrack])

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
