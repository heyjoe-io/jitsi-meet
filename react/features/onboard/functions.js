/* eslint-disable no-empty-function */
/* eslint-disable require-jsdoc */
import { getDomainFromUrl } from '../base/util/uri';
// import BackgroundService from 'react-native-background-actions';
import axios from 'axios';

import { setOnboard } from './actions';
import { STORE_NAME } from './reducer';
import { SET_UPLOAD_ERROR, UPDATE_LOCAL_RECORDING_STATUS, UPDATE_UPLOAD_PROGRESS, UPLOAD_NATIVE_LOCAL_RECORDING_FINISH, UPLOAD_NATIVE_LOCAL_RECORDING_START } from './actionTypes';
import { colors } from '../base/ui/Tokens';

let ws = null;
let pingIntervalHandle = null;
let pongTimeoutHandle = null;
let expireHandle = null;
const wsListeners = [];

// Upload configuration
const UPLOAD_CONFIG = {
    maxFileSize: 500 * 1024 * 1024, // 500MB max
    uploadTimeout: 300000, // 5 minutes
    ackTimeout: 30000, // 30s to wait for a server ACK after all bytes are flushed
    maxRetries: 3,
    retryDelay: 2000
};

// upKeys with an upload currently in flight. Used to suppress duplicate uploads of
// the same take when both the auto-upload path and the resume sweep fire. Cleared
// when uploadLocalRecordingNative settles (success or final failure).
const uploadsInFlight = new Set();

/**
 * Whether an upload for the given upKey is currently in flight in this process.
 * The resume queue uses this to avoid starting a duplicate upload.
 *
 * @param {string} upKey - The stable S3 key for the take.
 * @returns {boolean}
 */
export function isUploadInFlight(upKey) {
    return !!upKey && uploadsInFlight.has(upKey);
}

export function needToOnboard(state) {
    return state[STORE_NAME].onboardUrl && !state[STORE_NAME].talent;
}

export function scheduleExpire() {
    return (dispatch, getState) => {
        if (expireHandle) {
            clearTimeout(expireHandle);
        }
        const state = getState();

        if (!state[STORE_NAME].talent) {
            return;
        }
        const expireTime = state[STORE_NAME].talent.expireAt - new Date();

        expireHandle = setTimeout(() => {
            console.log('expireHandle: ');
            dispatch(setOnboard(null));
        }, expireTime);
    };
}

export function joinRoom (roomId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            meta: 'join',
            room: roomId
        }));
    }
}

export function leaveRoom (roomId) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            meta: 'leave',
            room: roomId
        }));
    }
}

export function sendMessage (roomId, message) {
    console.log("trying to send msg ", roomId, message)
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("api called")
        ws.send(JSON.stringify({
            meta: 'message',
            room: roomId,
            message
        }));
    }
}

export function addWsListener(listener) {
    wsListeners.push(listener);
}

export function removeWsListener(listener) {
    wsListeners.splice(wsListeners.indexOf(listener), 1);
}

export function stopWebsocket() {
    console.log('stop ws');
    if (ws) {
        clearInterval(pingIntervalHandle);
        clearTimeout(pongTimeoutHandle);
        ws.onopen = () => {};
        ws.onclose = () => {};
        ws.onmessage = () => {};
        ws = null;
    }
}

export function initWebsocket(onboardUrl, talentId) {
    console.log('-------- init ws', onboardUrl, talentId);
    try {
        if (ws) {
            clearInterval(pingIntervalHandle);
            clearTimeout(pongTimeoutHandle);
            ws.onclose = () => {};
            ws = null;
        }
        const host = getDomainFromUrl(onboardUrl);
        const wsLink = `wss://${host}/sock`;

        ws = new WebSocket(wsLink);
        ws.onopen = () => {
            console.log('-------- ws opened')
            ws.send(JSON.stringify({
                meta: 'join',
                room: `talent-${talentId}`
            }));
            console.log(`-------- joined talent-${talentId}`);
            pingIntervalHandle = setInterval(() => {
                try {
                    ws.send(JSON.stringify({ meta: 'ping',
                        room: `talent-${talentId}` }));
                } catch (err) {
                    console.log('err: ', err);
                }
                pongTimeoutHandle = setTimeout(() => {
                    initWebsocket(onboardUrl, talentId);
                }, 50000);
            }, 30000);
        };
        ws.onerror = err => {
            console.log('-------- ws.onerror', err);
        };
        ws.onclose = () => {
            console.log('-------- ws closed');
            initWebsocket(onboardUrl, talentId);
        };
        ws.onmessage = event => {
            try {
                const ev = JSON.parse(event.data);
                console.log('-------- ws msg: ', ev);

                if (ev.type === 'pong') {
                    clearTimeout(pongTimeoutHandle);
                }
                if (ev.data && global.wsHandle) {
                    global.wsHandle(`ws-${ev.type}`, ev.data);
                }
                wsListeners.forEach(listener => {
                    listener(ev);
                });
            } catch (err) {
                console.log('-------- socket msg handle err: ', err);
            }
        };
    } catch (err) {
        console.log('-------- err', err);
        stopWebsocket();
    }
}

// Helper function to format bytes
const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// Helper function to prepare file path for Android
const prepareFilePath = (filePath) => {
    console.log('🔍 Preparing file path:', filePath);
    
    // Try different path formats
    const pathVariations = [
        filePath,
        filePath.replace(/^file:\/\//, ''), // Remove file:// if present
        `file://${filePath}`, // Add file:// if not present
        `file://${filePath.replace(/^file:\/\//, '')}` // Ensure only one file://
    ];
    
    // For Android, we typically need the file:// prefix
    // Log all variations for debugging
    pathVariations.forEach((path, index) => {
        console.log(`  Path variation ${index + 1}: ${path}`);
    });
    
    // Default to using file:// prefix for Android
    const validPath = filePath.startsWith('file://') 
        ? filePath 
        : `file://${filePath.replace(/^file:\/\//, '')}`;
    
    console.log('✅ Using path:', validPath);
    
    return { validPath };
};

const uploadFile = async (fullUrl, formData, token, onUploadProgress, onError, onFinish, onFinalizing, retryCount = 0) => {
    console.log(`📤 Starting upload attempt ${retryCount + 1}/${UPLOAD_CONFIG.maxRetries}`);
    console.log('📍 Upload URL:', fullUrl);
    console.log('🔑 Authorization header:', token ? `Bearer ${token.substring(0, 10)}...` : 'No token');

    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const startTime = Date.now();

        // Once the browser reports 100% it has only flushed bytes to the socket — the
        // server (S3 put + Mongo doc) hasn't acknowledged yet. If nothing breaks the
        // connection in between this is fine, but backgrounding, a tower handoff, or an
        // expired URL can wedge it here forever. The watchdog bounds that wait: if no
        // ACK arrives within ackTimeout, abort and retry. Retries reuse the same
        // formData (same upKey), so the idempotent backend upsert dedupes cleanly.
        let ackTimer = null;
        let finalizingNotified = false;
        let watchdogAborted = false;

        const clearAckTimer = () => {
            if (ackTimer) {
                clearTimeout(ackTimer);
                ackTimer = null;
            }
        };

        const retry = (error, reason) => {
            clearAckTimer();
            if (retryCount < UPLOAD_CONFIG.maxRetries - 1) {
                console.log(`🔄 Retrying upload (${reason}) in ${UPLOAD_CONFIG.retryDelay}ms...`);
                setTimeout(() => {
                    uploadFile(fullUrl, formData, token, onUploadProgress, onError, onFinish, onFinalizing, retryCount + 1)
                        .then(resolve)
                        .catch(reject);
                }, UPLOAD_CONFIG.retryDelay);
            } else {
                onError && onError(error);
                reject(error);
            }
        };

        // Configure upload progress
        xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
                const progress = Math.round((event.loaded * 100) / event.total);
                const elapsed = (Date.now() - startTime) / 1000;
                const speed = event.loaded / elapsed;
                const remaining = (event.total - event.loaded) / speed;

                console.log(`📊 Upload progress: ${progress}% (${formatBytes(event.loaded)}/${formatBytes(event.total)})`);
                console.log(`⚡ Speed: ${formatBytes(speed)}/s, ETA: ${Math.round(remaining)}s`);

                onUploadProgress && onUploadProgress(progress);

                // All bytes flushed: tell the caller we're now waiting on the server
                // (so the UI can show "Finalizing…") and arm the ACK watchdog.
                if (event.loaded >= event.total && !finalizingNotified) {
                    finalizingNotified = true;
                    onFinalizing && onFinalizing();
                    clearAckTimer();
                    ackTimer = setTimeout(() => {
                        console.warn(`⏱️ No server ACK within ${UPLOAD_CONFIG.ackTimeout}ms of bytes flushed — aborting to retry`);
                        watchdogAborted = true;
                        try {
                            xhr.abort();
                        } catch (e) {
                            // no-op
                        }
                    }, UPLOAD_CONFIG.ackTimeout);
                }
            }
        });

        // Handle load event (success)
        xhr.addEventListener('load', () => {
            clearAckTimer();
            const uploadTime = (Date.now() - startTime) / 1000;
            console.log(`📡 Response received in ${uploadTime}s`);
            console.log(`📊 Response status: ${xhr.status} ${xhr.statusText}`);

            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const result = JSON.parse(xhr.responseText);
                    console.log(`✅ Upload successful!`);
                    console.log('📥 Server response:', result);

                    onFinish && onFinish(result);
                    resolve(result);
                } catch (parseError) {
                    console.error('❌ Failed to parse response:', parseError);
                    console.error('📄 Raw response:', xhr.responseText);
                    const error = new Error('Invalid JSON response from server');
                    onError && onError(error);
                    reject(error);
                }
            } else {
                console.error('❌ Server error response:', xhr.responseText);
                const error = new Error(`HTTP error! status: ${xhr.status}, message: ${xhr.responseText}`);
                onError && onError(error);
                reject(error);
            }
        });

        // Handle error event
        xhr.addEventListener('error', () => {
            console.error('❌ Upload failed - Network error');
            retry(new Error('Network request failed'), 'network error');
        });

        // Handle timeout
        xhr.addEventListener('timeout', () => {
            console.error('❌ Upload timed out');
            retry(new Error('Request timeout'), 'timeout');
        });

        // Handle abort. Currently abort is only ever triggered by the ACK watchdog
        // above; treat it as a retryable failure.
        xhr.addEventListener('abort', () => {
            if (watchdogAborted) {
                retry(new Error('No server acknowledgement (watchdog)'), 'ack watchdog');
            }
        });

        // Open and configure request
        xhr.open('POST', fullUrl);
        xhr.timeout = UPLOAD_CONFIG.uploadTimeout;

        // Set headers
        xhr.setRequestHeader('Accept', 'application/json');
        if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
        // Don't set Content-Type - let XMLHttpRequest handle it for FormData

        console.log('🚀 Sending request with XMLHttpRequest...');

        // Send the request
        xhr.send(formData);
    });
};

export async function uploadLocalRecordingNative(
    state,
    dispatch,
    localFilePath,
    sessionId,
    talentId,
    upKey = ''
) {
    // Suppress duplicate uploads of the same take (auto-upload + resume sweep can race).
    if (upKey && uploadsInFlight.has(upKey)) {
        console.log('⏭️ Upload already in flight for upKey, skipping duplicate:', upKey);
        return;
    }
    if (upKey) {
        uploadsInFlight.add(upKey);
    }

    console.log('\n🎬 === STARTING LOCAL RECORDING UPLOAD ===');
    console.log('📝 Parameters:', {
        localFilePath,
        sessionId,
        talentId,
        upKey,
        hasToken: !!state['features/talent'].token
    });

    dispatch({
        type: UPLOAD_NATIVE_LOCAL_RECORDING_START,
        key: localFilePath,
    });

    try {
        // Prepare file path
        const { validPath } = prepareFilePath(localFilePath);
        
        const token = state['features/talent'].token;
        const groupsUrl = `https://casting.heyjoe.io/api/records/record-groups/${sessionId}/${talentId}`;
        
        console.log('🔗 Fetching groups from:', groupsUrl);
        console.log('🔑 Token present:', !!token);
        
        // Fetch groups with better error handling
        const groupsResponse = await fetch(groupsUrl, {
            headers: {
                ...token ? { 'Authorization': `Bearer ${token}` } : {},
                'Content-Type': 'application/json'
            },
        });
        
        console.log('📋 Groups response status:', groupsResponse.status, groupsResponse.statusText);
        
        if (!groupsResponse.ok) {
            const errorText = await groupsResponse.text();
            console.error('❌ Groups fetch error:', errorText);
            throw new Error(`Failed to fetch groups: ${groupsResponse.status} ${groupsResponse.statusText}`);
        }
        
        const res = await groupsResponse.json();
        console.log('📋 Groups response data:', JSON.stringify(res, null, 2));
        
        if (!res || !res[0] || !res[0]._id) {
            throw new Error('Invalid groups response: missing group ID');
        }
        
        const currentGroupId = res[0]._id;
        console.log('🎯 Using group ID:', currentGroupId);
        
        const fullUrl = "https://casting.heyjoe.io/api/videos/upload-video";
        const fileName = validPath.split('/').pop();
        
        // Create file object with validated path
        const file = {
            uri: validPath,
            type: 'video/mp4',
            name: fileName
        };
        
        console.log('📁 File object:', JSON.stringify(file, null, 2));
        
        // Create FormData
        let formData = new FormData();
        
        // Log FormData construction
        console.log('📦 Building FormData...');
        
        // IMPORTANT: For React Native, the file must be passed as an object with uri, type, and name
        formData.append('file', {
            uri: validPath,
            type: 'video/mp4',
            name: fileName
        });
        console.log('  ✓ Added file:', fileName);
        
        formData.append('session', sessionId);
        console.log('  ✓ Added session:', sessionId);
        
        formData.append('group', currentGroupId);
        console.log('  ✓ Added group:', currentGroupId);
        
        if (upKey) {
            formData.append('upKey', upKey);
            console.log('  ✓ Added upKey:', upKey);
        }

        console.log('📦 FormData prepared successfully');

        // Notify CD that upload is starting. upKey lets the casting side dedupe
        // counters per-take instead of per-attempt.
        sendMessage(`talent-session-${sessionId}`, { type: 'upload-started', talentId, sessionId, upKey });

        // Track last sent progress bucket to throttle WS messages
        let lastSentProgress = -1;

        // Upload file
        await uploadFile(fullUrl, formData, token,
            (progress) => {
                // Cap the displayed value at 99% until the server actually ACKs the
                // upload — 100% is reserved for confirmed completion (status uploaded).
                const display = Math.min(progress, 99);
                dispatch({
                    type: UPDATE_UPLOAD_PROGRESS,
                    key: localFilePath,
                    progress: display
                });
                // Throttle WS progress messages to 10% increments
                const bucket = Math.floor(display / 10) * 10;
                if (bucket !== lastSentProgress) {
                    lastSentProgress = bucket;
                    sendMessage(`talent-session-${sessionId}`, { type: 'upload-progress', talentId, sessionId, upKey, progress: display });
                }
            },
            (error) => {
                console.error('🚨 Upload failed with error:', {
                    message: error.message,
                    code: error.code,
                    response: error.response?.data,
                    status: error.response?.status,
                    stack: error.stack
                });
                // upload-failed WS message is sent by the outer catch block
                dispatch({
                    type: SET_UPLOAD_ERROR,
                    key: localFilePath,
                    error: {
                        message: error.message || 'Upload failed',
                        code: error.code,
                        details: error.response?.data
                    }
                });
                formData = null;
            },
            (result) => {
                console.log('🎉 Upload completed successfully!');
                console.log('📥 Server response:', JSON.stringify(result, null, 2));
                sendMessage(`talent-session-${sessionId}`, { type: 'upload-complete', talentId, sessionId, upKey });
                dispatch({
                    type: UPLOAD_NATIVE_LOCAL_RECORDING_FINISH,
                    key: localFilePath,
                    ok: !!result._id
                });
                formData = null;
            },
            () => {
                // All bytes flushed; waiting on the server ACK. Surface a "Finalizing…"
                // state so the UI never sits at a misleading 100% before S3 confirms.
                dispatch({
                    type: UPDATE_LOCAL_RECORDING_STATUS,
                    key: localFilePath,
                    status: 'finalizing'
                });
            }
        );

    } catch (error) {
        console.error('🚨 Upload process error:', {
            message: error.message,
            stack: error.stack,
            toString: error.toString()
        });
        sendMessage(`talent-session-${sessionId}`, { type: 'upload-failed', talentId, sessionId, upKey });
        dispatch({
            type: SET_UPLOAD_ERROR,
            key: localFilePath,
            error: {
                message: error.message || 'Unknown error',
                details: error.toString()
            }
        });
    } finally {
        if (upKey) {
            uploadsInFlight.delete(upKey);
        }
    }
}