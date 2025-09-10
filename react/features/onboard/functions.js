/* eslint-disable no-empty-function */
/* eslint-disable require-jsdoc */
import { getDomainFromUrl } from '../base/util/uri';
// import BackgroundService from 'react-native-background-actions';
import axios from 'axios';

import { setOnboard } from './actions';
import { STORE_NAME } from './reducer';
import { SET_UPLOAD_ERROR, UPDATE_UPLOAD_PROGRESS, UPLOAD_NATIVE_LOCAL_RECORDING_FINISH, UPLOAD_NATIVE_LOCAL_RECORDING_START } from './actionTypes';
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
    maxRetries: 3,
    retryDelay: 2000
};

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

const uploadFile = async (fullUrl, formData, token, onUploadProgress, onError, onFinish, retryCount = 0) => {
    console.log(`📤 Starting upload attempt ${retryCount + 1}/${UPLOAD_CONFIG.maxRetries}`);
    console.log('📍 Upload URL:', fullUrl);
    console.log('🔑 Authorization header:', token ? `Bearer ${token.substring(0, 10)}...` : 'No token');
    
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const startTime = Date.now();
        
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
            }
        });
        
        // Handle load event (success)
        xhr.addEventListener('load', () => {
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
            console.error('🌐 Network connection issue detected');
            console.log('💡 Possible causes:');
            console.log('   - No internet connection');
            console.log('   - Server is unreachable');
            console.log('   - SSL certificate issues');
            console.log('   - CORS issues');
            
            const error = new Error('Network request failed');
            
            // Retry logic
            if (retryCount < UPLOAD_CONFIG.maxRetries - 1) {
                console.log(`🔄 Retrying upload in ${UPLOAD_CONFIG.retryDelay}ms...`);
                setTimeout(() => {
                    uploadFile(fullUrl, formData, token, onUploadProgress, onError, onFinish, retryCount + 1)
                        .then(resolve)
                        .catch(reject);
                }, UPLOAD_CONFIG.retryDelay);
            } else {
                onError && onError(error);
                reject(error);
            }
        });
        
        // Handle timeout
        xhr.addEventListener('timeout', () => {
            console.error('❌ Upload timed out');
            const error = new Error('Request timeout');
            
            // Retry on timeout
            if (retryCount < UPLOAD_CONFIG.maxRetries - 1) {
                console.log(`🔄 Retrying upload after timeout...`);
                setTimeout(() => {
                    uploadFile(fullUrl, formData, token, onUploadProgress, onError, onFinish, retryCount + 1)
                        .then(resolve)
                        .catch(reject);
                }, UPLOAD_CONFIG.retryDelay);
            } else {
                onError && onError(error);
                reject(error);
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
    console.log('\n🎬 === STARTING LOCAL RECORDING UPLOAD ===');
    console.log('📝 Parameters:', {
        localFilePath,
        sessionId,
        talentId,
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
        
        // Upload file
        await uploadFile(fullUrl, formData, token, 
            (progress) => {
                dispatch({
                    type: UPDATE_UPLOAD_PROGRESS,
                    key: localFilePath,
                    progress
                });
            },
            (error) => {
                console.error('🚨 Upload failed with error:', {
                    message: error.message,
                    code: error.code,
                    response: error.response?.data,
                    status: error.response?.status,
                    stack: error.stack
                });
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
                dispatch({
                    type: UPLOAD_NATIVE_LOCAL_RECORDING_FINISH,
                    key: localFilePath,
                    ok: !!result._id
                });
                formData = null;
            }
        );
        
    } catch (error) {
        console.error('🚨 Upload process error:', {
            message: error.message,
            stack: error.stack,
            toString: error.toString()
        });
        dispatch({
            type: SET_UPLOAD_ERROR,
            key: localFilePath,
            error: {
                message: error.message || 'Unknown error',
                details: error.toString()
            }
        });
    }
}