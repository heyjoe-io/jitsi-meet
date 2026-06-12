# Chunked Upload (upload-while-recording) — Handoff

**Branch:** `feat/chunked-upload` (off `feat/optical-zoom`). iOS only. No fork
changes — the react-native-webrtc pin is unchanged.

## What it does

While a local recording is rolling, the phone ships the growing file to S3 as
multipart-upload parts. When the talent stops, only the tail (plus one patched part,
see below) remains to upload, so the take is available seconds after stop instead of
minutes.

**The deliverable format does not change.** Recordings stay standard (non-fragmented)
QuickTime files, byte-identical to what the phone writes today — required because
native files are handed off downstream with no transcode step.

How that works: while recording, the file is append-only, so committed byte ranges
upload as-is. The recorder's finalize step then patches a small header region at the
FRONT of the file (the `mdat` size) and appends the `moov` index. At finish the phone
**verifies every uploaded part's SHA-256 against the disk and re-uploads the ones
that changed** (in practice just part 1, ~6MB), then uploads the tail and completes.
The assembled S3 object is guaranteed byte-identical to the local file — the
verify-and-patch step makes that a checked property, not an assumption.

Parts never cross the JS bridge: `HighResRecorder.uploadFileSlice(path, offset,
length, url)` reads the byte range and PUTs it natively, resolving with the HTTP
status, S3 ETag, and the slice's SHA-256. `hashFileSlice` provides the comparison
hash at finish.

## Flow

- Recording starts → `startChunkedUpload` (both LocalRecordingButtons, gated on
  `autoUploadLocalRecording`) → `initiate` → poll the file every 4s, upload each
  new ≥6MB slice via a presigned part URL.
- Recording stops → existing `uploadLocalRecordingNative` flow detects the session
  → verify-and-patch changed parts → drain the tail → `complete` → server assembles
  and creates the video doc. The CD sees the same `upload-started/progress/complete`
  WS messages as today (progress just finishes much faster). No CD changes needed.
- **Every failure path falls back to the legacy whole-file upload** (initiate 404,
  part failures, complete failure). The backend half can ship after this app build
  with zero coordination: until the endpoints exist, behavior is unchanged.

## Backend contract (casting API — the other half of this ticket)

All `POST`, Bearer auth, base `https://casting.heyjoe.io/api/videos/chunked-upload`:

| endpoint | body | returns |
| --- | --- | --- |
| `/initiate` | `{ fileName, session, talentId }` | `{ uploadId, key }` — S3 `CreateMultipartUpload` against the same bucket/prefix the legacy upload uses |
| `/part-url` | `{ uploadId, key, partNumber }` | `{ url }` — presigned `UploadPart` URL (15min expiry is plenty). **Must allow re-requesting an already-uploaded partNumber** (the verify-and-patch step re-PUTs part 1; S3 replaces the part and issues a new ETag) |
| `/complete` | `{ uploadId, key, parts: [{ PartNumber, ETag }], session, group, upKey, fileName }` | the created video doc — same shape/side-effects as `/videos/upload-video` (doc creation, notifications), minus the file transfer |
| `/abort` | `{ uploadId, key }` | `{}` — S3 `AbortMultipartUpload` |

Also add an **S3 lifecycle rule** to abort incomplete multipart uploads after ~7
days — phones that die mid-take can't always call `/abort`.

Notes:
- Parts are ≥6MB except the last (S3 requires ≥5MB for all but the final part).
- The phone sends parts strictly in order, one at a time, with 3 retries each.
- `complete` receives ETags verbatim from S3 response headers (quoted) — pass them
  through to `CompleteMultipartUpload` unmodified or normalize, S3 accepts both.
- Crash recovery (assembling a playable partial from a dead phone's parts) is NOT
  possible in this design — a standard QuickTime file without its `moov` is
  unplayable. Same as today's behavior; fragments would enable it but would change
  the deliverable format.

## Testing checklist

- [ ] Normal take (>1min): parts upload during recording (watch
      `[ChunkedUpload]` logs), stop → "Part 1 changed at finalize — re-uploading"
      appears → complete within seconds.
- [ ] **Byte-identity:** download the S3 object and `shasum -a 256` it against the
      file in the phone's Documents/recordings — must match exactly.
- [ ] Downloaded file plays and imports cleanly in the downstream handoff tools
      (same format as today, so this is a sanity check, not a format validation).
- [ ] Short take (<6MB): no parts during recording, single part at finish, no
      patch step.
- [ ] Endpoints absent (backend not deployed): initiate fails once, recording and
      legacy upload behave exactly as today.
- [ ] Airplane mode mid-take, restore before stop: parts retry/catch up, complete
      succeeds.
- [ ] Airplane mode through stop: chunked finish fails → abort → legacy upload
      retries per its existing logic.
- [ ] Recording interrupted (room transition): salvaged segment uploads via
      whichever path applies.
- [ ] 4K mode: upload lags recording (expected) and drains after stop.
