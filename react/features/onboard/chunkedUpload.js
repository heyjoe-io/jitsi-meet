// Chunked upload-while-recording (iOS).
//
// The recorder writes QuickTime movie fragments every ~6s, so the file on disk is
// valid up to the last fragment boundary at all times. This module tails the growing
// file and ships it to S3 as multipart-upload parts while the take is still rolling;
// when the recording stops, only the tail remains and the upload completes within
// seconds instead of re-sending the whole file.
//
// Backend contract (casting API, Bearer auth) — see Chunked_Upload_Handoff.md:
//   POST /api/videos/chunked-upload/initiate  { fileName, session, talentId }
//       → { uploadId, key }
//   POST /api/videos/chunked-upload/part-url  { uploadId, key, partNumber }
//       → { url }                      (presigned S3 UploadPart URL)
//   POST /api/videos/chunked-upload/complete  { uploadId, key, parts, session,
//                                               group, upKey, fileName }
//       → video doc (same shape as /api/videos/upload-video)
//   POST /api/videos/chunked-upload/abort     { uploadId, key }
//
// This module is pure transport: no redux, no websocket. Callers own messaging.
// Every failure path degrades to { ok: false } so the caller can fall back to the
// legacy whole-file upload — the complete file is always on disk regardless.

import { NativeModules } from 'react-native';

const { HighResRecorder } = NativeModules;

const API_BASE = 'https://casting.heyjoe.io/api/videos/chunked-upload';

// S3 multipart parts must be ≥5MB (except the last). ~6MB ≈ 5s of 1080p@10Mbps,
// so parts line up roughly with fragment boundaries.
const PART_SIZE = 6 * 1024 * 1024;

// How often to check the growing file for a new part's worth of bytes.
const POLL_MS = 4000;

const PART_RETRIES = 3;

// Active sessions keyed by file basename (callers hold paths in different forms —
// with/without file:// — but the basename is stable).
const sessions = {};

const keyFor = filePath => String(filePath).split('/').pop();

async function api(token, endpoint, body) {
    const response = await fetch(`${API_BASE}/${endpoint}`, {
        method: 'POST',
        headers: {
            ...token ? { 'Authorization': `Bearer ${token}` } : {},
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        throw new Error(`chunked-upload/${endpoint} failed: ${response.status}`);
    }

    return response.json();
}

/**
 * Upload the next part (s.uploadedBytes .. +length) with retries. On success the
 * session's offset and parts list advance; on exhausted retries the error
 * propagates to the caller (pump tolerates it and retries next tick; finish
 * converts it into the legacy-upload fallback).
 */
async function uploadPart(s, length) {
    const partNumber = s.parts.length + 1;
    let lastError;

    for (let attempt = 0; attempt < PART_RETRIES; attempt++) {
        try {
            const { url } = await api(s.token, 'part-url', {
                uploadId: s.uploadId,
                key: s.key,
                partNumber
            });
            const res = await HighResRecorder.uploadFileSlice(s.filePath, s.uploadedBytes, length, url);

            if (res.status >= 200 && res.status < 300 && res.etag) {
                s.parts.push({ PartNumber: partNumber, ETag: res.etag });
                s.uploadedBytes += length;
                console.log(`[ChunkedUpload] Part ${partNumber} uploaded (${Math.round(s.uploadedBytes / 1048576)}MB total)`);

                return;
            }
            lastError = new Error(`Part PUT returned status ${res.status}`);
        } catch (error) {
            lastError = error;
        }
        console.warn(`[ChunkedUpload] Part ${partNumber} attempt ${attempt + 1} failed:`, lastError?.message);
    }

    throw lastError;
}

/**
 * One pump pass: read the current file size and upload every full part that has
 * been committed since the last pass. Serialized via s.pumping so finish() can
 * drain in-flight work before taking over.
 */
function pump(s) {
    if (s.pumping || s.finishing || s.aborted) {
        return;
    }

    s.pumping = (async () => {
        try {
            for (;;) {
                const info = await HighResRecorder.getFileInfo(s.filePath);

                if (!info.exists || info.size - s.uploadedBytes < PART_SIZE) {
                    return;
                }
                await uploadPart(s, PART_SIZE);
            }
        } catch (error) {
            // Tolerated mid-recording — the next tick retries from the same offset.
            // Persistent failure just means more bytes left for finish().
            console.warn('[ChunkedUpload] Pump pass failed (will retry):', error?.message);
        } finally {
            s.pumping = null;
        }
    })();
}

/**
 * Begin a chunked upload session for a recording that just started. Failure is
 * silent by design: with no session registered, the post-stop flow takes the
 * legacy whole-file path.
 */
export function startChunkedUpload({ filePath, fileName, sessionId, talentId, token }) {
    if (!HighResRecorder?.uploadFileSlice || !filePath) {
        return;
    }

    const sessionKey = keyFor(filePath);

    api(token, 'initiate', { fileName, session: sessionId, talentId })
        .then(({ uploadId, key }) => {
            if (!uploadId || !key) {
                throw new Error('initiate returned no uploadId/key');
            }

            const s = {
                filePath,
                fileName,
                token,
                uploadId,
                key,
                uploadedBytes: 0,
                parts: [],
                pumping: null,
                finishing: false,
                aborted: false,
                timer: null
            };

            s.timer = setInterval(() => pump(s), POLL_MS);
            sessions[sessionKey] = s;
            console.log('[ChunkedUpload] Session started:', sessionKey, 'uploadId:', uploadId);
        })
        .catch(error => {
            // Backend half not deployed yet, or offline — legacy upload will handle it.
            console.warn('[ChunkedUpload] initiate failed, recording will use legacy upload:', error?.message);
        });
}

export function hasChunkedSession(filePath) {
    return Boolean(sessions[keyFor(filePath)]);
}

/**
 * Finish a chunked session after the recording is FINALIZED on disk: drain
 * in-flight work, upload the tail (every part except the final one must be
 * ≥5MB, which holds because only the loop's last slice is short), and ask the
 * backend to assemble. Returns { ok: true, result } with the created video doc,
 * or { ok: false } after aborting — in which case the caller must run the
 * legacy whole-file upload.
 */
export async function finishChunkedUpload({ filePath, upKey, session, group, onProgress }) {
    const sessionKey = keyFor(filePath);
    const s = sessions[sessionKey];

    if (!s) {
        return { ok: false };
    }

    s.finishing = true;
    clearInterval(s.timer);

    try {
        if (s.pumping) {
            await s.pumping;
        }

        const info = await HighResRecorder.getFileInfo(s.filePath);

        if (!info.exists || info.size <= 0) {
            throw new Error('Recording file missing at finish');
        }

        while (s.uploadedBytes < info.size) {
            await uploadPart(s, Math.min(PART_SIZE, info.size - s.uploadedBytes));
            onProgress?.(Math.round((s.uploadedBytes / info.size) * 100));
        }

        const result = await api(s.token, 'complete', {
            uploadId: s.uploadId,
            key: s.key,
            parts: s.parts,
            session,
            group,
            upKey,
            fileName: s.fileName
        });

        delete sessions[sessionKey];
        console.log('[ChunkedUpload] Completed:', sessionKey, `(${s.parts.length} parts)`);

        return { ok: true, result };
    } catch (error) {
        console.warn('[ChunkedUpload] Finish failed, falling back to legacy upload:', error?.message);
        await abortChunkedUpload(filePath);

        return { ok: false };
    }
}

/**
 * Abort a session and best-effort clean up the server-side multipart upload.
 * Safe to call when no session exists.
 */
export async function abortChunkedUpload(filePath) {
    const sessionKey = keyFor(filePath);
    const s = sessions[sessionKey];

    if (!s) {
        return;
    }

    s.aborted = true;
    clearInterval(s.timer);
    delete sessions[sessionKey];

    try {
        await api(s.token, 'abort', { uploadId: s.uploadId, key: s.key });
    } catch {
        // The S3 lifecycle rule reaps abandoned multipart uploads.
    }
    console.log('[ChunkedUpload] Aborted:', sessionKey);
}
