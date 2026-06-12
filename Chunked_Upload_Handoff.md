# Chunked Upload (upload-while-recording) — Handoff

**Branch:** `feat/chunked-upload` (off `feat/optical-zoom`). iOS only.

## What it does

While a local recording is rolling, the phone ships the growing file to S3 as
multipart-upload parts. When the talent stops, only the last few seconds remain to
upload, so the take is available seconds after stop instead of minutes. If the app
dies mid-take, everything up to the last uploaded part is already in S3, and the
local file is recoverable up to the last ~6s fragment.

Two enablers:

1. **The recorder writes QuickTime movie fragments every 6s**
   (`movieFragmentInterval` in `HeyJoeVideoCapturer.m`, fork commit on
   `heyjoe-recording`). The file on disk is valid up to the last fragment boundary
   at all times, so committed byte ranges can be uploaded as-is — the assembled S3
   object is byte-identical to the final local file. NOTE: final files are now
   *fragmented* QuickTime (moov + moof boxes). AVPlayer/ffmpeg/browsers handle this
   fine, but validate the casting transcode/review pipeline with a real file.
2. **Parts never cross the JS bridge** — `HighResRecorder.uploadFileSlice(path,
   offset, length, url)` reads the byte range and PUTs it natively, resolving with
   the HTTP status and S3 ETag.

## Flow

- Recording starts → `startChunkedUpload` (both LocalRecordingButtons, gated on
  `autoUploadLocalRecording`) → `initiate` → poll the file every 4s, upload each
  new ≥6MB slice via a presigned part URL.
- Recording stops → existing `uploadLocalRecordingNative` flow detects the session
  → drains the tail → `complete` → server assembles and creates the video doc.
  The CD sees the same `upload-started/progress/complete` WS messages as today
  (progress just finishes much faster). No CD changes needed.
- **Every failure path falls back to the legacy whole-file upload** (initiate 404,
  part failures, complete failure). The backend half can ship after this app build
  with zero coordination: until the endpoints exist, behavior is unchanged.

## Backend contract (casting API — the other half of this ticket)

All `POST`, Bearer auth, base `https://casting.heyjoe.io/api/videos/chunked-upload`:

| endpoint | body | returns |
| --- | --- | --- |
| `/initiate` | `{ fileName, session, talentId }` | `{ uploadId, key }` — S3 `CreateMultipartUpload` against the same bucket/prefix the legacy upload uses |
| `/part-url` | `{ uploadId, key, partNumber }` | `{ url }` — presigned `UploadPart` URL (15min expiry is plenty) |
| `/complete` | `{ uploadId, key, parts: [{ PartNumber, ETag }], session, group, upKey, fileName }` | the created video doc — same shape/side-effects as `/videos/upload-video` (doc creation, notifications), minus the file transfer |
| `/abort` | `{ uploadId, key }` | `{}` — S3 `AbortMultipartUpload` |

Also add an **S3 lifecycle rule** to abort incomplete multipart uploads after ~7
days — phones that die mid-take can't always call `/abort`.

Notes:
- Parts are ≥6MB except the last (S3 requires ≥5MB for all but the final part).
- The phone sends parts strictly in order, one at a time, with 3 retries each.
- `complete` receives ETags verbatim from S3 response headers (quoted) — pass them
  through to `CompleteMultipartUpload` unmodified or normalize, S3 accepts both.

## Testing checklist

- [ ] Normal take (>1min): parts upload during recording (watch
      `[ChunkedUpload]` logs), stop → complete within seconds, file plays in CD.
- [ ] Short take (<6MB): no parts during recording, single part at finish.
- [ ] Endpoints absent (backend not deployed): initiate fails once, recording and
      legacy upload behave exactly as today.
- [ ] Airplane mode mid-take, restore before stop: parts retry/catch up, complete
      succeeds.
- [ ] Airplane mode through stop: chunked finish fails → abort → legacy upload
      retries per its existing logic.
- [ ] Recording interrupted (room transition): salvaged segment uploads via
      whichever path applies.
- [ ] Fragmented file plays/transcodes correctly in the full casting pipeline.
- [ ] 4K mode: upload lags recording (expected) and drains after stop.
