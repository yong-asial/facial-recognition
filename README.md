# Face Attendance (PoC)

A teacher leaves the camera open on a laptop / iPad; students walk up one by one and are marked present by face.
Everything runs **on the device in the browser** (face-api.js: TinyFaceDetector + 68-point landmarks + 128-d dlib embedding). No cloud face API, no cost.
The backend (Express + `node:sqlite`) stores students, sessions and attendance.

```bash
npm install
npm start            # http://localhost:3009
npm test             # unit + API tests (104)
npm run e2e          # real Chrome + fake webcam, needs /tmp/e2e/cam{A,Live,C}.y4m (see below)
node scripts/e2e-palm.mjs palmA.y4m [palmB.y4m]   # palm kiosk E2E (see "Palm scanning")
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
Modelled on how production systems (Face ID, AWS Rekognition, Azure Face) structure it: detect -> quality gate -> align -> embed -> match -> decide -> update the template.

| Step | Where | Notes |
|---|---|---|
| Cheap gate (160px detector) | browser | only while nobody is being tracked; skipped mid check-in to save a pass |
| Detect -> landmarks -> embedding | browser | 224px TinyFaceDetector on a frozen frame. **Tilted heads (> 6°) are straightened** before the embedding (face-api doesn't; dlib does): same-person distance halved on our fixtures |
| Face box | browser | corner box + name over each face: white = seen, amber = needs something, green = recognised, red = not recognised. **Show face box** (default on) / **Show position guide** (oval, default off; a soft target, never required) |
| Quality gate | browser, `faceQuality` | size, tilt, pose, light, blur, detector score. **Lenient at scan** (`SCAN_QUALITY`, a bad frame is just skipped), **strict at enrolment** (`ENROLL_QUALITY`) |
| Track + fuse | browser, `FaceTracker` | each face is followed by box overlap; its good frames are **averaged into one descriptor** (less noise than any single frame); a different face in the same spot restarts it |
| 1:N match | browser, [matching.js](public/matching.js) | score = mean of the student's **2 nearest** samples (one stray sample can't attract strangers); threshold + gap + **ratio test** (best/next <= 0.8) |
| Confirm | browser | 3 fused frames (2 if the match is very close) **and** the liveness check below, on the same tracked face |
| Learn | `POST /api/students/:id/face/learned` | Face ID-style: a clear match (0.15-0.35, big margin) or a teacher-picked near miss adds one sample per student per session to a **separate pool of 5** (FIFO). Never touches the enrolment; refused if far from it; **Wrong person** removes it; re-enrol clears it |
| Save | `AttendanceService` -> `/api/sessions/:id/attendance` | idempotent; queued in `localStorage` while offline, replayed with the real timestamp |

Enrolment (strict, slower is fine): 6 samples with pose prompts through the strict gate, each double-checked by the **SSD detector** (exactly one face, score >= 0.8; loaded only on the Students tab, never by the scanner; the stored descriptor still comes from the Tiny pipeline so it matches what the scanner computes), the outlier farthest from the medoid dropped, and a **duplicate check** (warns if the face is already enrolled under another name).

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
- Palm (when enrolled): only the hand (Left/Right) and its 512-byte palm-line code per template (max 10 per hand), in a **separate encrypted column** `palm_data` with its own `palm_consent_at`. No palm image and no hand geometry are stored. `DELETE /api/students/:id/palm[?hand=Left|Right]` withdraws one hand or all palm data without touching the face data.
- Descriptors and palm codes are decrypted by the server and sent to the teacher's browser for matching. Use HTTPS in any real deployment.
- **Template hashes (display only):** the roster shows `face #xxxxxxxx` and `palm: right #xxxxxxxx`, the first 8 hex digits of SHA-256 over the stored template (all face samples incl. learned ones; per hand, current-version palm templates). The check-in card shows `scan #… → matched face/palm template #…`. A hash identifies an exact template, not a person: every scan hashes differently (matching is by distance), and the stored hash changes on re-enrol or when a face sample is learned. Nothing is stored or compared by hash.
- Old PoC tables (`students`, `attendance`) are renamed `*_legacy` on first start, not deleted.

## Tuning the threshold
Quickest: **Students -> Check roster**. It compares every student's samples with their own template and with every other student, lists look-alike pairs, and suggests a threshold that stays below the closest pair of different students.

By hand:
1. Open **Scan**, tick **Debug overlay**.
2. Have each enrolled student walk up. Note `dist` (distance to the best match) and `next` (the next-best *other* student).
3. Have a few **non-enrolled** people (and look-alikes / siblings) walk up. Note their `dist`.
4. Set the slider **between** the two groups, closer to the genuine side. Wrong matches are worse than "not recognised", so err strict.
   The value is remembered per browser; the server default is `FACE_THRESHOLD` (0.5). `gap` (default 0.04) makes the scanner refuse when two students are almost equally close.
- Rough guide for these dlib embeddings: same person ~0.2-0.45, different people usually > 0.55.
- Quality limits: `SCAN_QUALITY` / `ENROLL_QUALITY` in `public/matching.js` (blur = Laplacian variance of a 96px face crop, brightness 0-255, roll in degrees after straightening). Debug overlay shows `quality <reason>` when a frame is skipped. Keep the scan limits loose: a rejected frame costs ~100 ms per student.

## Liveness (what it does and does not stop)
Scan sidebar -> **Liveness check** (saved per browser):

| Mode | What the student does | Speed | Stops |
|---|---|---|---|
| **Blink or head turn** (default) | nothing special: a natural blink or small head movement within 4 s | fast | held-up photo / photo on a screen |
| **+ random spot checks** | 1 in 5 check-ins also get "Turn your head ←/→" on cue | fast on average | as above, and makes a replayed video a gamble |
| **Turn on cue, every student** | "Turn your head ←/→" in a random direction, within 4 s | ~1 s slower each | as above for every check-in |
| Off | nothing | fastest | nothing (photos pass) |

Turn on cue: the direction is random and judged against where the head started; turning the wrong way fails at once, so a video that wiggles both ways doesn't pass. After 2 failed cues the card says **Not verified** and offers the manual picker. A replayed video still has ~50% per cue of turning the right way; real protection against replays needs depth/IR hardware or supervision.

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
- [ ] **Palm**: enrol right palms (strict gate passes within ~10 s at 30 cm?), scan with *Scan with: Palm*: time to "Present", the back of the hand is refused, the left hand gets "Use your right hand", two hands at once, a printed palm photo with *Finger movement* liveness (must NOT pass), the close & open challenge (does the track survive the fist?), gloves / plasters / wet hands.

## E2E fixtures
```bash
mkdir -p /tmp/e2e
V="scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2"
ffmpeg -loop 1 -framerate 15 -t 20 -i test/fixtures/A.jpg -vf "$V" -pix_fmt yuv420p /tmp/e2e/camA.y4m   # still photo (spoof)
ffmpeg -loop 1 -framerate 15 -t 20 -i test/fixtures/C.jpg -vf "$V" -pix_fmt yuv420p /tmp/e2e/camC.y4m   # stranger
# camLive.y4m: A.jpg warped back and forth so the head appears to turn (passes the liveness check)
ffmpeg -loop 1 -framerate 15 -t 20 -i test/fixtures/A.jpg -vf "$V,perspective=x0=0:y0='0.13*H*sin(2*PI*on/12)':x1=W:y1='-0.13*H*sin(2*PI*on/12)':x2=0:y2='H-0.13*H*sin(2*PI*on/12)':x3=W:y3='H+0.13*H*sin(2*PI*on/12)':eval=frame:sense=destination" -pix_fmt yuv420p /tmp/e2e/camLive.y4m
```

## Palm scanning
Check-in by showing an open palm to the same camera (target < 1 s from palm in view to "Present").
- **Kiosk:** Scan sidebar -> **Scan with: Palm** (saved per browser; one method at a time, so only one model runs per frame). Same card, cooldown, *Wrong person*, manual picker and offline queue as faces; attendance is recorded with method `palm`. Hints: "Show the palm of your hand", "Open your hand, fingers apart", "Use your right hand" (when nobody enrolled the hand shown), "Move your fingers a little" (liveness).
- **Liveness (same menu, palm wording):** *Finger movement* (passive: fingertips must move relative to the palm; a held photo is rigid), *+ random close & open spot checks*, *Close & open hand for every student*, *Off*. Passive thresholds are first guesses: tune them with real hands and printed palms (debug overlay shows `finger travel`).
- **Enrolment:** Students -> *Capture palm & add student* (or *Enrol / Re-enrol palm* on a roster row), right hand by default, left or both from the menu. 6 frames per hand through the strict gate (prompts ask for fingers together, then with small gaps, so both poses are in the template), outliers dropped, duplicate warning. A student can have face, palm or both; *Delete palm data* withdraws palms only.
- **Fingers:** gaps between the fingers are fine; only straight fingers are required (3 at scan, 4 at enrolment). The palm square sits on the wrist → middle-knuckle axis, which barely moves when fingers spread (on 11K Hands, same-person pairs whose spread differs by 35°+ match 84% of the time, vs 48% with the earlier knuckle-line square).
- **Position guide:** in palm mode (kiosk *Show position guide*, and while capturing a palm) the oval becomes an open-hand outline, mirrored to the hand being enrolled / the enrolled hand.
- **Template versions:** palm templates carry `v` (`PALM_TEMPLATE_VERSION`, now 2 = middle-finger-axis square). The kiosk ignores older templates and the roster marks them "re-enrol (older format)".
Contactless palmprint on a webcam/iPad camera is less accurate than published numbers (lab lighting, contact scanners): check the go/no-go below with real people before relying on it.

```bash
npm run models       # once: downloads MediaPipe hand_landmarker.task (~7.5 MB) into ./models (gitignored)
npm start            # then open http://localhost:3009/palm-spike.html (no login)
npm run palm:report -- palm-samples.json [--reencode | --sweep] [--same-session] [--threshold 0.38] [--wavelength 14] [--frames 3] [--geom 0.5]
node scripts/palm-eval-11k.mjs HandInfo.csv Hands/ out.json [--subjects 60] [--per 8] [--webcam] [--blur 2] [--keep-blurry]   # public dataset run, see below
```

| Step | Where | Notes |
|---|---|---|
| Detect + 21 landmarks + handedness | `palm-service.js`, MediaPipe Hand Landmarker (GPU, VIDEO mode) | ~11 ms/frame on a MacBook. It tracks between frames itself, so no cheap pre-check pass is needed. Handedness is used as reported (measured: correct for raw, un-mirrored frames) |
| Palm ROI | `palmRoi` | 128 px square below the knuckle line (index MCP 5 to pinky MCP 17), rotated upright, never mirrored. ~3 ms canvas warp |
| Quality gate | `palmQuality` | palm (not the back of the hand) facing, fingers open, flat to the camera, size, light, blur. Lenient `SCAN_PALM`, strict `ENROLL_PALM` |
| Texture code | `encodeCompCode` | Competitive Code: 6 oriented Gabor filters, winning orientation per point on a 32×32 grid (3 bits) + a mask for low-contrast points. One `tf.conv2d` on face-api's TensorFlow.js: **1.2 ms GPU** (4.6 ms in plain JS, identical code) |
| Match | `PalmMatcher` | shift-tolerant (±3 cells) Hamming distance, same accept rules as faces (threshold 0.38, gap, ratio, mean of 2 nearest); same-hand templates only. Hand-geometry term exists but is off (useless, see below) |
| Track + fuse | `FaceTracker` (now generic) + `PalmTrack`, `fuseDecide` | each hand followed by box overlap; per-frame scores computed once; decision over 2–3 frames by **guarded vote**: one frame passes the rules on its own, no frame names someone else, and the mean score agrees (within 0.03 of the threshold). A different palm or the other hand in the same spot restarts the track |
| Liveness | `PalmLiveness` | passive: fingertips must move in the palm's own frame (a photo is rigid, however it is waved); active: "close then open your hand". **Thresholds untuned**: on a still photo, landmark jitter alone reads 0.03–0.04 against a 0.06 pass line |
| Enrolment helpers | `prunePalmOutliers`, `palmDuplicate` | drop samples far from the medoid; warn when the palm is already enrolled under another student |

**Public-dataset run (2026-11-26).** [11K Hands](https://sites.google.com/view/11khands) (Afifi 2019, academic use; not committed) palm photos, 60 people, 8 photos per hand, each person's photos split into an "enrol" half and a "scan" half. `--webcam` shrinks each photo to 640×480 and recompresses it at JPEG quality 70.

| | full 1600×1200 | webcam-like 640×480 |
|---|---|---|
| hand found / correct hand + palm side | 99.9% / 97.2% | 100% / 97.2% |
| pass the scan gate | 51% (most rejects: wrist cut off by the photo, ROI leaves the frame) | 42% (+ blur) |
| pass the enrol gate | 46% | **9%** (blur, palm < 140 px) |
| EER (λ=14) | 4.1% | 2.7% |
| kiosk replay, one photo, threshold just under the closest impostor | 92.2% right, 0 wrong | 92.2% right, 0 wrong (at 0.37: 89.5%) |
| hand geometry alone | EER 30% (useless; kept at weight 0) | EER 30% |

Frame fusion (webcam-like, threshold 0.38, enrol/scan halves): 1 frame **92.2%** right · 2 frames **95.1%** · 3 frames **98.6%**, always 0 wrong; an unenrolled person was given a name 0 of 140 (2 frames) / 0 of 75 (3 frames) times, and 0 of 296 single frames even at threshold 0.40. Guarded vote beat a plain mean (95.7% at 3 frames) and best-frame-only (97.1%) with the same 0 errors. `npm run palm:report -- export.json --frames 3` reproduces it.

Blur (640×480 with added Gaussian blur, all frames kept): accuracy does not drop down to ROI sharpness ~3 (σ=3: 98.9% right with 3 frames, 0 wrong, 0 unenrolled named), because the λ=14 code ignores fine wrinkles; below ~3 (σ=4–6) palms start to look alike and 3–5 of ~100 unenrolled scans get a name. Sharpness limits are therefore 4 (scan) / 5 (enrolment), not the first-guess 8 / 15 that rejected most frames of a soft webcam ("The image was too blurry"). If enrolment still fails on sharpness, the message shows the sharpest value seen vs the limit.

Wavelength sweep (EER, webcam-like): λ=10 4.1%, 12 ~3.5%, **14 2.7%**, 16 2.7% (but fewer right at a safe threshold), 18 2.7%. Coarser filters follow principal lines, which stay put when the hand pose changes; fine wrinkles move. Resolution is not the limit (640×480 ≈ full res); ROI alignment between poses is.
Caveats: each person's photos come from one sitting (no day-to-day change; optimistic), but every photo is an independent pose with no tracking (pessimistic). The margin is thin: the closest different-person pair is only ~0.02 above the threshold.

**API (Phase 3):** `POST /api/students` takes `descriptors`, `palm` (`[{hand, code}]`, base64 code from `codeToBase64`) or both, each with `consent: true`; `PUT /api/students/:id/palm` enrols / re-enrols the hands in the request and keeps the other hand; `DELETE /api/students/:id/palm[?hand=]`; `GET /api/students` adds `hasPalm` and `palms`. `POST /api/sessions/:id/attendance` takes `method: 'face' | 'palm'` (default face; kept through the offline queue; shown in the CSV "Method" column). No learned-template pool for palms yet.

**Protocol:** 8–10 people. Right hand by default ("allow left hand" for both). Per person: *Capture 10* with the strict gate on day 1, then again on another day (different session label) with the lenient gate, under the classroom lighting. Export JSON after each sitting (samples live only in this browser's localStorage).
**Go/no-go** (report with "genuine = different sessions only"): kiosk replay has **0 WRONG person**, and ≥ 95% right once 2–3 frames are fused (the single-frame replay is the pessimistic case). If not, try `--sweep`; if no Gabor setting gets there, the next step is a trained palm model (CCNet-style, ONNX Runtime Web) behind the same matcher. Check dataset licences: Tongji, IITD and MPD are mostly research-only.

## Porting into the Expo app later
Keep `matching.js` and `attendance-service.js` as-is (pure TypeScript-able logic; they already carry JSDoc types and `// @ts-check`). Replace `face-service.js` with react-native-vision-camera + a face detector + a TFLite embedding model (MobileFaceNet; switch `MatchingService` to `metric: 'cosine'` and retune the threshold), swap `localStorage` for expo-sqlite in `AttendanceService`, and the encryption key for expo-secure-store. The API contract in [app.js](app.js) (`/api/students`, `/api/sessions/...`) stays the same.

## Known limits of this PoC
- JavaScript with JSDoc types on the pure modules, not strict TypeScript.
- Landmarks-based liveness is a deterrent for held-up photos, not a certified anti-spoofing system.
- The offline queue survives a Wi-Fi drop but the page itself must already be loaded (no service worker yet).
- The legacy Ollama face-login endpoints still exist in the backend (and tests) but nothing in the UI uses them.
