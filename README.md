# Face Attendance (PoC)

A teacher leaves the camera open on a laptop / iPad; students walk up one by one and are marked present by face.
Everything runs **on the device in the browser** (face-api.js: TinyFaceDetector + 68-point landmarks + 128-d dlib embedding). No cloud face API, no cost.
The backend (Express + `node:sqlite`) stores students, sessions and attendance.

```bash
npm install
npm start            # http://localhost:3009
npm test             # unit + API tests (49)
npm run e2e          # real Chrome + fake webcam, needs /tmp/e2e/cam{A,Live,C}.y4m (see below)
```

Node 22.5+. The camera needs **HTTPS or localhost**: an iPad opening `http://<laptop-ip>:3009` is blocked from the camera, so use a tunnel/HTTPS for iPad.

## Run on the Android emulator (Mac webcam as the camera)
```bash
npm run android                     # boots Pixel_Tablet_API_34, starts the server, opens Chrome
scripts/android-emulator.sh Pixel_3a_API_34_extension_level_7_arm64-v8a   # another AVD
WEBCAM=webcam0 PORT=3009 npm run android
```
It launches the emulator with `-camera-front webcam0 -camera-back webcam0` (list yours with `emulator -webcam-list`) and runs `adb reverse tcp:3009 tcp:3009`, so the emulator's Chrome opens `http://localhost:3009`. This matters: Chrome only allows the camera on HTTPS or localhost, and `10.0.2.2` is not a secure context.
The first time, dismiss Chrome's first-run prompts and allow the camera. The emulator runs with software GL (`-gpu swiftshader_indirect`) because Chrome crashed in the default host-GPU mode on this Mac; override with `GPU=host` if yours is fine. Each run opens one more Chrome tab. Testing tip: hold a photo of an enrolled student up to the Mac webcam to try the spoof check, or sit in front of it.

## How it works

| Step | Where | Notes |
|---|---|---|
| Cheap gate (160px detector) | browser | skips the heavy work when nobody is in front of the camera |
| Detect -> landmarks -> embedding | browser | 224px TinyFaceDetector; the frame is frozen on a canvas first |
| 1:N match | browser, [matching.js](public/matching.js) | `MatchingService`, Euclidean (cosine supported), threshold + look-alike gap |
| Confirm | browser | **3 consecutive frames** of the same student **and** liveness (blink or head turn) |
| Save | `AttendanceService` -> `/api/sessions/:id/attendance` | idempotent; queued in `localStorage` while offline, replayed with the real timestamp |

Mirroring: the video is only mirrored by CSS for display. Detection and embedding use the raw (un-mirrored) frame, so there is no mirror/rotation mismatch between enrolment and scanning.

### Screens
- **Scan**: live preview, face guide, result card (name, photo, **Wrong person** undo), "Not recognised" + manual picker, recent list with undo, **Debug overlay** (fps, face box, distance, runner-up, EAR, yaw, liveness state, live threshold slider).
- **Session**: start a session (class + date), live present/absent list with manual toggle, end session, past sessions, CSV export.
- **Students**: consent notice, enrol (5 quality-checked samples with pose prompts), re-enrol, **Delete face data**, remove student.

### Services (public/)
| File | Role |
|---|---|
| `face-service.js` | `FaceService`: detection gate, landmarks, embedding, blur score, thumbnail (the only face-api / DOM code) |
| `matching.js` | `MatchingService`, `LivenessTracker`, `MatchConfirmer`, similarity + geometry maths. Pure, DOM-free |
| `attendance-service.js` | `AttendanceService`: send, offline queue, retry, cancel |
| `api.js` | HTTP client and the enrolment/session repository |

## Data, privacy, security
- Stored per student: **embeddings + one 96px thumbnail**, **AES-256-GCM encrypted at rest** ([crypto-store.js](crypto-store.js)). Key = `FACE_DATA_KEY` (64 hex chars) or an auto-generated `data/face.key` (mode 0600). **Back the key up and keep it out of git**: without it the face data cannot be decrypted.
- Enrolment requires explicit consent (notice + per-student guardian checkbox, stored as `consent_at`). Students are minors and biometric data falls under Japan's APPI: get your legal/school sign-off before real use.
- **Delete face data** erases the template + thumbnail and keeps the student for manual attendance. **Remove** deletes everything.
- Descriptors are decrypted by the server and sent to the teacher's browser for matching. Use HTTPS in any real deployment.
- Old PoC tables (`students`, `attendance`) are renamed `*_legacy` on first start, not deleted.

## Tuning the threshold
1. Open **Scan**, tick **Debug overlay**.
2. Have each enrolled student walk up. Note `dist` (distance to the best match) and `next` (the next-best *other* student).
3. Have a few **non-enrolled** people (and look-alikes / siblings) walk up. Note their `dist`.
4. Set the slider **between** the two groups, closer to the genuine side. Wrong matches are worse than "not recognised", so err strict.
   The value is remembered per browser; the server default is `FACE_THRESHOLD` (0.5). `gap` (default 0.04) makes the scanner refuse when two students are almost equally close.
- Rough guide for these dlib embeddings: same person ~0.2-0.45, different people usually > 0.55.
- Blur check: `BLUR_MIN` in `public/app.js` (Laplacian variance of the face crop). Raise it if blurry enrolments slip through; lower it if sharp ones are rejected.

## Liveness (what it does and does not stop)
A blink (eye-aspect-ratio dip) or a head turn (yaw swing of >= 0.12 from landmarks) is required before a mark. A **still photo or a photo on a screen** produces neither, so it is rejected (covered by the e2e "SPOOF" step). A **video replay** of the student blinking/turning can pass. If that matters, add a depth/IR or challenge-response check, or supervise the kiosk.

## Testing checklist (do on a real iPad before relying on it)
- [ ] **Similar-looking students** (siblings/twins): enrol both, scan each; expect the right name or "Not recognised", never the wrong one. If one is accepted wrongly, lower the threshold / raise `gap`.
- [ ] **Glasses**: enrol with and without; scan with each. Add a second enrolment if the distance rises > 0.45.
- [ ] **Masks**: expect "Not recognised" (the landmark model cannot cover them). Verify the manual picker flow instead.
- [ ] **Low light / backlight (window behind)**: check detection rate and `dist`; enrolment should reject blurry/dark frames.
- [ ] **Photo of a photo / phone screen**: must NOT mark present (liveness on). Also try a video of the student.
- [ ] **Distance and angle**: a face ~1.5 m away (`MIN_FACE_RATIO`), a student looking down at a phone.
- [ ] **Crowd**: two students at once; each should be marked separately and not swapped.
- [ ] **Duplicate**: same student twice, "Already checked in", no second record.
- [ ] **Wrong person**: undo removes the mark and opens the picker; the face is not re-marked for 15 s.
- [ ] **Offline**: turn Wi-Fi off, scan; "waiting to sync" appears; turn it on and the scan is replayed with its original time.
- [ ] **Orientation**: rotate the iPad portrait/landscape; the front/rear camera switch works.
- [ ] **Camera permission denied** shows a clear message; model files missing shows "Could not load face models".
- [ ] **Delete face data** then scan that student: not recognised, manual works.

## E2E fixtures
```bash
mkdir -p /tmp/e2e
V="scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2"
ffmpeg -loop 1 -framerate 15 -t 20 -i test/fixtures/A.jpg -vf "$V" -pix_fmt yuv420p /tmp/e2e/camA.y4m   # still photo (spoof)
ffmpeg -loop 1 -framerate 15 -t 20 -i test/fixtures/C.jpg -vf "$V" -pix_fmt yuv420p /tmp/e2e/camC.y4m   # stranger
# camLive.y4m: A.jpg warped back and forth so the head appears to turn (passes the liveness check)
ffmpeg -loop 1 -framerate 15 -t 20 -i test/fixtures/A.jpg -vf "$V,perspective=x0=0:y0='0.13*H*sin(2*PI*on/12)':x1=W:y1='-0.13*H*sin(2*PI*on/12)':x2=0:y2='H-0.13*H*sin(2*PI*on/12)':x3=W:y3='H+0.13*H*sin(2*PI*on/12)':eval=frame:sense=destination" -pix_fmt yuv420p /tmp/e2e/camLive.y4m
```

## Porting into the Expo app later
Keep `matching.js` and `attendance-service.js` as-is (pure TypeScript-able logic; they already carry JSDoc types and `// @ts-check`). Replace `face-service.js` with react-native-vision-camera + a face detector + a TFLite embedding model (MobileFaceNet; switch `MatchingService` to `metric: 'cosine'` and retune the threshold), swap `localStorage` for expo-sqlite in `AttendanceService`, and the encryption key for expo-secure-store. The API contract in [app.js](app.js) (`/api/students`, `/api/sessions/...`) stays the same.

## Known limits of this PoC
- JavaScript with JSDoc types on the pure modules, not strict TypeScript.
- Landmarks-based liveness is a deterrent for held-up photos, not a certified anti-spoofing system.
- The offline queue survives a Wi-Fi drop but the page itself must already be loaded (no service worker yet).
- The legacy Ollama face-login endpoints still exist in the backend (and tests) but nothing in the UI uses them.
