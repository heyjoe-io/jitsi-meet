# Progressive S3 Multipart Upload (Spec — Phase 3)

Status: proposal / not yet implemented.
Scope: spans two repos — `jitsi-meet` (talent app + native recorder) and `casting` (backend).

## Why

Today a local recording is uploaded as a single multipart-form POST to
`https://casting.heyjoe.io/api/videos/upload-video` *after* the take finishes
(`react/features/onboard/functions.js → uploadLocalRecordingNative`). The whole
file rides one connection at the end, which is exactly when the talent is most
likely to background the app or move — the failure window behind the "stuck at
100%" and "file in S3 with no Video doc" incidents.

Phases 1 and 2 (the ACK watchdog and the persistent resume queue) make that final
POST survivable. Progressive multipart attacks the root cause instead: upload the
bytes *while the take is still recording*, so by the time the user hits stop almost
everything is already in S3 and only a small tail rides the fragile final hop.

Net effect: a 3-minute take that currently uploads ~150 MB after stop would instead
upload ~145 MB during recording and only the last few MB + a CompleteMultipartUpload
call after stop.

## Current state (what's already true)

- `upKey` is stable and deterministic: `${jitsi_meeting_id}_${start}_to_${end}.${ext}`
  (`LocalRecordingButton.tsx`). Same take → same key. This is the natural idempotency
  / resume key for multipart too.
- `nativeLocalRecordings` is persisted via `PersistenceRegistry` (`onboard/reducer.js`),
  so per-take state already survives relaunch. Checkpoints can live here.
- The casting backend's `add-video-entry` / video upsert is idempotent on `upKey`
  (commit `6c3fbe6b`). The multipart completion path should reuse that upsert.

## The hard constraint: file format

`HeyJoeVideoCapturer` writes a standard `.mov`/`.mp4` via `AVAssetWriter` and finalizes
it at stop (`finishWritingWithCompletionHandler`). Two problems for streaming the bytes
out mid-recording:

1. The `moov` index atom is written at the **end** on finalize.
2. Finalize can **seek back and patch byte offsets** earlier in the file.

If we upload byte ranges as S3 parts during recording and finalize then rewrites any
of those bytes, the already-uploaded parts are stale and the assembled object is
corrupt.

**Required recorder change:** emit **fragmented MP4 (fMP4)**. Set
`AVAssetWriter.movieFragmentInterval` (e.g. `CMTimeMake(1, 1)` … `CMTimeMakeWithSeconds(2, 1)`)
so the writer flushes self-contained `moof`/`mdat` fragments progressively and never
rewrites earlier bytes. With fMP4:

- Bytes, once written to disk, are immutable → safe to upload as parts.
- The file is also more resilient if recording is interrupted (each completed fragment
  is independently valid).

Open question: confirm downstream playback/transcode (CD review, thumbnailing) accepts
fMP4, or transcode to a faststart MP4 server-side on completion. Likely fine, but verify
before committing.

## Architecture

Three workstreams. They can land incrementally behind a feature flag; the existing
single-POST path stays as the fallback.

### A. Native recorder (`jitsi-meet`, `HeyJoeVideoCapturer.m`)

1. Enable fragmented output (`movieFragmentInterval`).
2. Expose progress to JS so the chunker knows how many bytes are durably flushed:
   - Option 1 (simplest): the chunker reads the growing file from disk and tracks an
     offset; the recorder just needs to guarantee append-only (fMP4 gives this).
   - Option 2 (cleaner): emit a `NativeEventEmitter` event per flushed fragment with
     `{ byteOffset, length }` so JS uploads on fragment boundaries without polling.
3. On stop, return final file size so the chunker can upload the final tail and complete.

### B. Casting backend (`casting`) — new presigned multipart endpoints

All keyed by `upKey` so they're idempotent and resumable across app restarts. Suggested
routes under `/api/videos`:

- `POST /multipart/initiate` — body `{ upKey, session, group, talentId, contentType }`.
  Returns `{ uploadId, key }`. If an upload for this `upKey` already exists, return the
  existing `uploadId` (idempotent) rather than starting a new one.
- `POST /multipart/sign-part` — body `{ upKey, uploadId, partNumber }`. Returns a
  short-lived presigned URL for `UploadPart`. (Client PUTs the part bytes directly to S3.)
- `POST /multipart/complete` — body `{ upKey, uploadId, parts: [{ partNumber, eTag }] }`.
  Calls S3 `CompleteMultipartUpload`, then **runs the existing idempotent Video upsert**
  (the `6c3fbe6b` path) so the DB row is created exactly as the single-POST flow does
  today. Returns the Video doc (`_id`).
- `POST /multipart/abort` — body `{ upKey, uploadId }`. Calls S3 `AbortMultipartUpload`
  to release parts. Optional; also handle via an S3 lifecycle rule (below).

Backend notes:
- **S3 part size:** every part except the last must be ≥ 5 MB. The chunker must buffer
  flushed bytes until it has ≥ 5 MB before uploading a part (except the final tail).
- **Idempotent complete:** completing an already-completed `upKey` should return the
  existing Video doc, not error — mirrors the current upsert behaviour.
- **Orphan/abort cleanup:** add an S3 lifecycle rule to abort incomplete multipart
  uploads after N days, so abandoned takes don't accrue storage. This replaces, for the
  multipart path, the manual `recover-orphan-videos.js` situation — there is no
  "object in S3 with no doc" state because the doc is only created at `complete`, and
  incomplete uploads are auto-aborted.
- **Auth:** same talent bearer token as the existing endpoints.

### C. Talent app chunker (`jitsi-meet`, `onboard/functions.js`)

New function alongside `uploadLocalRecordingNative`, e.g. `uploadLocalRecordingMultipart`,
selected when the feature flag is on:

1. On record start (or first flushed fragment): call `/multipart/initiate` with `upKey`,
   store `uploadId` on the take's `nativeLocalRecordings` entry.
2. While recording: maintain a byte offset. As ≥ 5 MB of new immutable bytes are
   available, read that slice, request a presigned URL via `/multipart/sign-part`, `PUT`
   it to S3, and on success persist `{ partNumber, eTag, byteRange }` to the take entry
   (the checkpoint). Use XHR so the existing progress/watchdog machinery applies per part.
3. On stop: upload the final (< 5 MB allowed) tail part, then call `/multipart/complete`
   with the full ordered `parts` list. On success dispatch `UPLOAD_NATIVE_LOCAL_RECORDING_FINISH`
   exactly as today.
4. Resume: the Phase 2 queue already re-invokes the uploader for any take not `uploaded`.
   The multipart uploader resumes from persisted checkpoints — re-initiate is idempotent
   (returns existing `uploadId`), already-uploaded parts are skipped, and it continues
   from the first missing part. S3's `ListParts` can be used to reconcile if local
   checkpoint state is suspect.

### Checkpoint data model (extends the `nativeLocalRecordings` entry)

```jsonc
{
  "key": "file:///.../take.mp4",   // local path (existing)
  "upKey": "1234_...to_....mp4",   // stable S3 key (existing)
  "status": "uploading",            // existing
  "multipart": {                     // NEW
    "uploadId": "S3-upload-id",
    "partSize": 8388608,
    "nextByteOffset": 134217728,
    "parts": [ { "partNumber": 1, "eTag": "\"abc\"" }, ... ],
    "completed": false
  }
}
```

This lives in the already-persisted store, so it survives app kill/relaunch.

## Edge cases

- **App killed mid-recording:** completed parts are in S3 and checkpointed locally; the
  local fMP4 file is valid up to the last fragment. On relaunch the resume queue continues
  uploading remaining parts and completes. (If the user never returns, the S3 lifecycle
  rule aborts the incomplete upload.)
- **Local file purged by iOS (tmp/Caches):** can't resume; mark `upload_failed` after the
  Phase 2 attempt cap. Consider recording into a non-purgeable directory
  (`Application Support`) to reduce this.
- **Presigned part URL expired:** re-sign that part via `/multipart/sign-part` and retry
  (reuse the watchdog/retry logic).
- **Last-part-only takes (< 5 MB total):** single part, allowed to be < 5 MB; complete
  immediately. Falls back to behaving like the current single upload.
- **Clock/format mismatch:** keep `contentType` consistent between initiate and complete.

## Rollout

1. Land the backend endpoints first (additive; nothing uses them yet).
2. Land the fMP4 recorder change behind a build check; verify CD-side playback/transcode.
3. Land the chunker behind a feature flag (default off). Dogfood on a real session.
4. Flip the flag for a studio, watch the chip counters + orphan reports, then ramp.

The single-POST path (`uploadLocalRecordingNative`) plus Phases 1–2 remain the fallback
for any device/flag where multipart is off.

## Testing

- Unit: chunker part-boundary math (5 MB minimum, final tail), checkpoint persist/restore.
- Integration: kill the app mid-recording, relaunch, confirm the take completes with one
  Video doc and a byte-exact object in S3.
- Backgrounding: background during recording and during the final complete; confirm resume.
- Idempotency: invoke `/multipart/complete` twice; confirm one Video doc, same `_id`.
- Orphans: abandon a take; confirm the S3 lifecycle rule aborts the incomplete upload and
  no Video doc is created.
- Regression: feature flag off → identical behaviour to current single-POST upload.
