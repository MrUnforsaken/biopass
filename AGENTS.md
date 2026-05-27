# Session Context

Last updated: 2026-05-26

## Fixed Issues

### 1. "Connection refused" on startup
- **Root cause**: `tauri` crate had `features = ["protocol-asset"]` which omitted the `custom-protocol` default feature
- **Fix**: Changed to `features = ["protocol-asset", "custom-protocol"]` in `app/src-tauri/Cargo.toml`

### 2. Camera preview black (WebKitGTK PipeWire DMA_DRM bug)
- **Root cause**: WebKit `pwsrc` requests DMA_DRM format, camera provides NV12 → format negotiation fails → `getUserMedia` returns black frames without throwing
- **Fix**: `FaceCapture.tsx` now skips `getUserMedia` entirely and uses native ffmpeg capture (`camera.rs`)

### 3. "No face detected" on Capture + Face crop extremely zoomed
- **Root cause**: Four bugs in C++ YOLOv8 face detection code:
  a. `num_preds = shape[2]` (80 rows) instead of `shape[2] * shape[3]` (6400 grid cells)
  b. Only processed first output tensor (P3/stride 8), ignored P4 (stride 16) and P5 (stride 32)
  c. NHWC tensor access when ONNX uses NCHW layout — class score at channel 64 read pixel values, producing false-positive detections at padding edges
  d. Missing DFL decode — model is YOLOv8-pose (64 DFL bins + class score at ch64), code assumed 5-channel format, giving tiny w/h (~16–32px)
- **Fix**: Rewrote `face_detection.cc` with correct YOLOv8-pose decode:
  - NCHW tensor access (`tdata[ch * H * W + row * W + col]`)
  - DFL softmax-over-16-bins decode for all 4 bbox boundaries
  - Class score at channel 64
  - Cell center at `(col + 0.5) * stride`
  - DFL distance-from-center bbox formula

### 4. IR camera (NV12 format) not working
- **Root cause**: ffmpeg `-input_format mjpeg -c:v copy` fails on NV12-only devices
- **Fix**: Changed to `-c:v mjpeg -q:v 5` (software encode, works for all formats)

### 5. Preview always used /dev/video0
- **Root cause**: `FaceCapture` had hardcoded device auto-detection
- **Fix**: `FaceCapture` accepts `selectedDevicePath` prop from `FaceSetting` (uses configured IR camera)

### 6. PAM helper always used /dev/video0 (white LED instead of IR)
- **Root cause**: `resolveCameraDeviceIdx()` with `std::nullopt` always returns index 0. No config field existed for primary camera selection.
- **Fix**: Added `camera_device` field to `FaceMethodConfig` — PAM helper uses it instead of hardcoded index 0. GUI now has a "Camera Device" selector. Config at `~/.config/com.ticklab.biopass/config.yaml` set to `/dev/video2`.

### 7. IR anti-spoofing failed: "Device or resource busy"
- **Root cause**: When `camera_device` and `ir_camera` point to the same device, the primary session (openpnp) already has the device open; V4L2 direct capture can't open it again.
- **Fix**: `face_auth.cc` detects same-device case and reuses the primary session for IR capture instead of opening a second session.

### 8. IR camera GREY format not available (NV12 only)
- **Root cause**: DELL WB7022 IR camera only exposes NV12 format; anti-spoofing code tried `V4L2_PIX_FMT_GREY` which doesn't exist on this device.
- **Fix**: Added `V4L2NV12CameraSession` that captures NV12 frames and extracts the Y (luma) plane as greyscale. Falls back to `V4L2GreyCameraSession` if NV12 isn't available. Both formats supported; NV12 preferred.

### 9. PAM auth succeeded but sudo still denied
- **Root cause**: `[success=1 default=ignore]` only skipped `pam_unix.so`; the next rule `[default=die] pam_faillock.so authfail` killed the successful auth.
- **Fix**: Changed to `[success=2 default=ignore]` to skip both `pam_unix.so` AND `pam_faillock.so authfail`, matching the original Arch PAM pattern of `success=2` on `pam_unix.so`.

### 10. AI anti-spoofing passed on hand (wrong class ordering)
- **Root cause**: `anti-spoof-mn3` model defines class 0 = real, class 1 = spoof, but biopass code checked `spoof_cls == 0` (backwards). A hand was correctly classified as class 1 (spoof) but the code didn't flag it.
- **Fix**: Changed `face_as.cc` to check `spoof_cls == 1` instead of `spoof_cls == 0`.

### 11. Face detection threshold compared logit instead of sigmoid
- **Root cause**: `if (score_logit < this->conf)` compared raw ONNX output (logit) against configured threshold, but `d.conf` stored `sigmoid(score_logit)`. A threshold of 0.8 gave ~69% effective probability.
- **Fix**: Moved sigmoid before comparison: `if (score < this->conf)` where `score = sigmoid(score_logit)`. Also added dimension sanity checks (`pred_dim < 5 || H == 0 || W == 0`).

### 12. Camera preview FPS hardcoded at 300ms
- **Root cause**: `FaceCapture.tsx` used `setInterval(..., 300)` with no way to change the frame rate
- **Fix**: Added 3-speed dropdown (3/15/30 FPS) in the amber info bar. User can switch while preview is live — polling restarts instantly with the new interval. Default remains 3 FPS. No CPU concerns at 30 FPS (640×480 JPEG decode + ~30 Tauri IPC calls/sec is negligible).
- **Files**: `app/src/app/configuration/-components/face/FaceCapture.tsx`

### 13. AI anti-spoofing false positive on IR-only setup
- **Root cause**: When `camera_device == ir_camera` (both `/dev/video2` IR cam), the face capture is IR greyscale, but the AI anti-spoofing model was trained on visible-light RGB data. It outputs class 1 (spoof) with 99.8% confidence for any IR face.
- **Fix**: Same-device detection disables AI anti-spoofing (`anti_spoofing.enable = false`) and reuses primary session for IR-only anti-spoofing in `face_auth.cc::authenticate()`. Also passes `camera_session_.get()` as IR session pointer instead of nullptr so `checkAntispoofByIRCamera` captures from the primary session instead of opening a new V4L2 session.

### 14. `biopass-helper` IR capture fails with "Device or resource busy" on polkit-1 calls
- **Root cause**: `beginAuthenticationSession()` set `ir_camera_session_ = nullptr` for same-device reuse. `authenticate()` then re-entered IR setup logic, and `checkAntiSpoof` passed nullptr to `checkAntispoofByIRCamera`, which tried to open a new V4L2 session — failed because primary session already had the device.
- **Fix**: Same as #13 — authenticate now passes `camera_session_.get()` when same-device.

### 15. polkit-1 PAM integration (REVERTED — causes lock screen hang)
- **Root cause**: `/etc/pam.d/polkit-1` didn't include biopass. Config also had `polkit-1` in `ignore_services`.
- **Original fix**: Added `auth sufficient libbiopass_pam.so` to `/etc/pam.d/polkit-1` before `pam_faillock.so preauth`. Set `ignore_services: []` in user config.
- **Why reverted**: Lock screen (polkit-1 auth) hung — face auth delay + PAM_AUTH_ERR from biopass broke the PAM chain even with correct password. User had to force-reboot.
- **Current state**: `libbiopass_pam.so` line is commented out in `/etc/pam.d/polkit-1`. `ignore_services` restored to `["polkit-1", "pkexec"]` in user config. polkit-1 flows fall through to password-only auth.

## Fixed & Refactored in Session (2026-05-26)

### 16. `free(): corrupted unsorted chunks` on GUI close
- **Root cause**: `CameraPreview` background thread handle was discarded (`thread::spawn()` → no `JoinHandle`). On `exit()`, the detached thread was still running (blocked on `reader.read()`) while glibc heap cleanup ran, corrupting unsorted bins.
- **Fix**: 
  - `CameraPreview` now stores the `JoinHandle` 
  - `stop()` joins the thread after killing ffmpeg and waiting for the child
  - `start_camera_preview` uses `preview.take()` instead of `preview.is_some() + stop()` to avoid double-stop on drop
  - `lib.rs` registers a `on_window_event(Destroyed)` handler that explicitly stops the preview before Tauri drops managed state
- **Files**: `app/src-tauri/src/camera.rs`, `app/src-tauri/src/lib.rs`

### 17. polkit-1 lock screen hang after PAM modification
- **Root cause**: `ignore_services: []` allowed biopass to run for `polkit-1` service (when called via `system-auth` PAM include). Lock screen camera unavailable → face auth delay + PAM_AUTH_ERR corrupted the auth flow. Password entry via `pam_unix.so` failed despite correct password.
- **Fix**: Restored `ignore_services: ["polkit-1", "pkexec"]` in user config. The polkit-1 PAM file's biopass line was already commented out. polkit-1 now bypasses biopass entirely.
- **Files**: `~/.config/com.ticklab.biopass/config.yaml`

### 18. AI anti-spoofing false-positive on real face (webcam crop too smooth for model)
- **Root cause**: `anti-spoof-mn3` model relies on high-frequency texture variance. Dell WB7022 webcam produces soft crops at 128×128 after MJPEG compression. Model output: `[0.013, 0.987]` (97.4% spoof) for any real face.
- **Fix**: Added `sharpenImage()` (separable 3-tap unsharp mask, amount=5.0) to `image_utils.h`. Applied in `face_as.cc::preprocess()` before normalization. After fix: `[0.929, 0.071]` (92.9% real) — passes threshold.
- **Files**: `auth/face/image_utils.h`, `auth/face/antispoofing/face_as.cc`

### 19. IR anti-spoofing fails due to AGC timing (dark frames)
- **Root cause**: Dell WB7022 IR AGC takes ~1s to stabilize. `kIrCaptureWarmupFrames=5` at 10ms poll = 50ms warmup, far too short. Half of captures get dark/overexposed frames.
- **Fix**: Reduced per-capture warmup to 3 frames; added multi-attempt loop (2 attempts) with 500ms sleep between for AGC settling. Updated `kIrCaptureTimeoutMs=5000`, `kIrCapturePollIntervalMs=33`.
- **Files**: `auth/face/antispoofing/ir_camera_as.cc`, `auth/face/face_auth.cc`

### 20. Code cleanup refactoring (Patch 0014)
- **What**: Extract `parseAdvancedConfig()` from inline YAML parsing in `auth_config.cc`; split advanced settings GUI into `AdvancedFaceSettings.tsx` (8 section components + NumberInput helper); use struct-level `#[serde(default)]` instead of per-field `default_*` functions in `config.rs`
- **Impact**: `FaceSetting.tsx` reduced 763→352 lines; removed 16 `default_*` Rust functions; C++ YAML parsing moved to dedicated helper
- **Files**: `auth/core/auth_config.cc`, `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx` (new), `app/src/app/configuration/-components/face/FaceSetting.tsx`, `app/src-tauri/src/config.rs`

### 21. Advanced settings UI refinements: reset buttons + field tooltips
- **What**: Added per-section reset buttons (↺ icon next to each section heading) and a "Reset all to defaults" button at the top. Removed redundant Preview FPS from Capture Resolution section (FPS is controlled from FaceCapture info bar). Added HTML `title` tooltips on all advanced field labels explaining each parameter. Improved section reset button hover text to "Reset this section to defaults".
- **Impact**: `AdvancedFaceSettings.tsx` grew slightly (SectionHeading component + NumberInput `title` prop + CaptureResolutionSection simplified 3-col→2-col)
- **Files**: `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx`, `app/src/types/config.ts` (added `DEFAULT_ADVANCED_CONFIG` constant)

### 22. Configurable preview resolution from advanced config

- **Root cause**: `camera.rs` had `640x480` hardcoded in ffmpeg `-video_size` for both preview stream and single-frame capture. Config had `CaptureAdvancedConfig { width, height }` with GUI controls in Advanced Settings, but they were never wired to the ffmpeg commands.
- **Fix**: 
  - `camera.rs`: `CameraPreview::start()` now takes `width: u32, height: u32` params; `start_camera_preview` and `capture_camera_frame` accept optional `width`/`height` (defaults 640×480)
  - `commands/face.ts`: pass optional width/height through Tauri invocations
  - `FaceCapture.tsx`: accepts `captureWidth`/`captureHeight` props, forwards them when starting preview
  - `FaceSetting.tsx`: reads `config.advanced.capture.width`/`.height` and passes to FaceCapture
- **Files**: `app/src-tauri/src/camera.rs`, `app/src/commands/face.ts`, `app/src/app/configuration/-components/face/FaceCapture.tsx`, `app/src/app/configuration/-components/face/FaceSetting.tsx`

### 23. Advanced Settings moved to standalone page
- **What**: Moved the Advanced Settings collapsible section out of the Configuration page into its own top-level nav tab ("Advanced" with Wrench icon). Created `app/src/app/advanced.tsx` page route, updated `__root.tsx` nav bar, registered route in `routeTree.gen.ts`. AdvancedFaceSettings now accepts `alwaysOpen` prop to render without the collapsible wrapper when used as a standalone page.
- **Impact**: Cleaner Configuration page (no more collapsible), dedicated page for all advanced tuning parameters
- **Files**: `app/src/app/advanced.tsx` (new), `app/src/app/__root.tsx`, `app/src/app/routeTree.gen.ts`, `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx`, `app/src/app/configuration/-components/face/FaceSetting.tsx`
- **Note**: Font sizes bumped from `text-xs`/`text-[10px]` to `text-sm` throughout Advanced page to match the rest of the GUI; input heights increased from `h-8` to `h-10`

### 24. Suppress fingerprint D-Bus error on startup

- **Root cause**: `FingerprintSetting.tsx` mounts unconditionally in `MethodConfig` and calls `cmd.fingerprint.listEnrolled()` on mount, which creates a `FingerprintAuth` and tries D-Bus to fprintd, logging "No fingerprint device found" when no hardware exists — even when fingerprint is disabled in config.
- **Fix**: Added `if (!config?.enable) return;` guard at the top of the `useEffect`, and added `config?.enable` to the dependency array so the call only fires when fingerprint is actively enabled. The component stays mounted for smooth expand/collapse animation (`grid-rows-[0fr]` in MethodCard).
- **Files**: `app/src/app/configuration/-components/FingerprintSetting.tsx`

### 25. Config reload overwrites in-memory advanced settings on navigation

- **Root cause**: `configuration/page.tsx:19-21` called `initializeConfig()` unconditionally in `useEffect` on every mount. Navigating away and back re-initialized config from YAML, discarding any in-memory advanced setting changes made in the Advanced page.
- **Fix**: Guarded with `if (!config)` so it only runs when config is null (initial load), and added `config` to the dependency array for proper reactive sync.
- **Files**: `app/src/app/configuration/page.tsx`

### 26. Stale description in Capture Resolution section

- **Root cause**: `AdvancedFaceSettings.tsx` said "Preview FPS is controlled from the camera preview bar above" — but FPS is now a NumberInput **in** the camera preview bar, not "above" it.
- **Fix**: Removed the inaccurate sentence.
- **Files**: `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx`

### 27. Fixed 3-speed FPS selector too restrictive

- **Root cause**: `FaceCapture.tsx` only offered 3, 15, or 30 FPS via a `<Select>` dropdown. Users wanted full control (e.g., 5, 10, 60 FPS).
- **Fix**: Replaced `<Select>` with `<Input type="number" min={1} max={120}>`, computed polling interval as `1000 / localFps` (clamped to ≥16ms). Removed `FPS_OPTIONS`/`fpsToIndex`/`fpsIndex` state; replaced with `localFps` state initialized from `previewFps` prop.
- **Files**: `app/src/app/configuration/-components/face/FaceCapture.tsx`

## Files Modified
- `app/src-tauri/Cargo.toml` — added `"custom-protocol"` feature
- `app/src-tauri/src/camera.rs` — new file: ffmpeg native camera streaming
- `app/src-tauri/src/lib.rs` — registered camera module, media settings
- `app/src-tauri/src/config.rs` — added `camera_device` field to `FaceMethodConfig`
- `app/src/app/configuration/-components/face/FaceCapture.tsx` — native-only preview, accepts device prop, 3-speed FPS selector (3/15/30 FPS)
- `app/src/app/configuration/-components/face/FaceSetting.tsx` — passes camera device to FaceCapture, added Camera Device selector UI
- `app/src/commands/face.ts` — added Tauri camera commands
- `app/src/types/config.ts` — added `camera_device` to TypeScript interface
- `auth/face/detection/face_detection.cc` — NCHW tensor layout fix + DFL decode + threshold sigmoid fix + dim checks
- `auth/face/detection/utils.h` — added `nms_boxes` declaration
- `auth/face/detection/utils.cc` — renamed `nms` to `nms_boxes` (exposed from static)
- `auth/core/auth_config.h` — added `camera_device` to `FaceMethodConfig`
- `auth/core/auth_config.cc` — parse `camera_device` from YAML
- `auth/face/face_auth.cc` — use `camera_device` for primary camera; same-device IR reuse; V4L2NV12 with V4L2Grey fallback
- `auth/face/common/camera_capture.h` — added `V4L2NV12` enum value
- `auth/face/common/camera_capture.cc` — added `V4L2NV12CameraSession` class, NV12 capture with Y-plane extraction, GREY fallback
- `auth/face/antispoofing/face_as.cc` — changed class check from `spoof_cls == 0` to `spoof_cls == 1`; added sharpenImage call before normalization; uses configurable unsharp params + spoof class index from advanced config
- `auth/face/antispoofing/face_as.h` — added `UnsharpMaskParams`, `spoof_class_index_`, `unsharp_params_` members; updated constructor
- `auth/face/image_utils.h` — added `sharpenImage()` function (separable 3-tap unsharp mask, amount=5.0)
- `auth/face/antispoofing/ir_camera_as.cc` — reduced warmup to 3 frames; added 2-attempt multi-frame capture with 500ms AGC sleep; now uses IR params from config (warmup_frames, timeout, poll, max_attempts, agc_sleep_ms, camera_warmup_ms)
- `auth/face/antispoofing/ir_camera_as.h` — added `IRCaptureParams` struct (alias for `IRCaptureConfig`), updated function signature
- `auth/face/face_auth.cc` — uses IR params from advanced config; implements `getMaxAuthTimeMs()` from `AuthAdvancedConfig`
- `auth/face/face_auth.h` — added `getMaxAuthTimeMs()` override, `irParams()` helper, `#include "ir_camera_as.h"`
- `auth/face/antispoofing/antispoof_check.cc` — adds combinational mode (all/any), passes unsharp/spoof/IR params through to FaceAntiSpoofing and IR camera check
- `auth/core/auth_config.h` — added `UnsharpMaskConfig`, `IRCaptureConfig`, `CaptureConfig`, `DetectionAdvancedConfig`, `AntiSpoofingAdvancedConfig`, `EnrollmentConfig`, `RecognitionAdvancedConfig`, `AuthAdvancedConfig`, `AdvancedConfig` structs; added `AdvancedConfig advanced` field to `FaceMethodConfig`
- `auth/core/auth_config.cc` — YAML parsing for all advanced config fields under `methods.face.advanced`
- `auth/core/auth_method.h` — added `virtual uint32_t getMaxAuthTimeMs() const { return 0; }` to `IAuthMethod`
- `app/src-tauri/src/config.rs` — added all advanced config structs with serde + Default impls + forward through deserializer
- `app/src/types/config.ts` — added all advanced config TypeScript interfaces; added `DEFAULT_ADVANCED_CONFIG` constant
- `app/src/app/configuration/-components/face/FaceSetting.tsx` — added collapsible Advanced Settings section with all controls
- `app/src/app/configuration/-components/face/FaceCapture.tsx` — accepts `previewFps` prop + `onPreviewFpsChange` callback for persistent FPS
- `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx` — extracted advanced settings component with 8 sub-sections + NumberInput helper; per-section reset buttons + global "Reset all to defaults"; HTML title tooltips on all field labels; alwaysOpen prop for standalone page usage; font sizes bumped from text-xs to text-sm, inputs h-8→h-10
- `app/src/app/advanced.tsx` — new file: standalone Advanced Settings page with Wrench nav icon
- `app/src/app/__root.tsx` — added "Advanced" nav tab with Wrench icon
- `app/src/app/routeTree.gen.ts` — registered /advanced route
- `app/src/app/configuration/-components/face/FaceSetting.tsx` — refactored to use AdvancedFaceSettings (763→352 lines), AdvancedFaceSettings removed from config page (moved to standalone tab)
- `app/src-tauri/src/config.rs` — replaced per-field `#[serde(default = "...")]` + 16 `default_*` functions with struct-level `#[serde(default)]`
- `auth/core/auth_config.cc` — extracted inline YAML parsing into `parseAdvancedConfig()` helper function
- `/etc/pam.d/system-auth` — `[success=2 default=ignore]` for biopass, `[success=2 default=bad]` for pam_unix.so
- `app/src-tauri/src/camera.rs` — `CameraPreview::start()` now takes `width: u32, height: u32`; `start_camera_preview` and `capture_camera_frame` accept optional width/height (defaults 640×480) instead of hardcoded `640x480`
- `app/src/commands/face.ts` — `startCameraPreview` and `captureCameraFrame` pass optional width/height through Tauri invocations
- `app/src/app/configuration/-components/face/FaceCapture.tsx` — accepts `captureWidth`/`captureHeight` props, forwards them when starting preview
- `app/src/app/configuration/-components/face/FaceSetting.tsx` — reads `config.advanced.capture.width`/`.height` and passes to FaceCapture
- `app/src/app/configuration/-components/FingerprintSetting.tsx` — suppress D-Bus call on mount when fingerprint is disabled
- `app/src/app/configuration/page.tsx` — guard `initializeConfig` with `if (!config)` to prevent reload overwriting in-memory changes
- `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx` — removed stale description about preview FPS
- `app/src/app/configuration/-components/face/FaceCapture.tsx` — replaced fixed 3-speed FPS Select with free-form NumberInput (1–120 FPS)

## Binaries Installed
- `/usr/bin/biopass` (app)
- `/usr/bin/biopass-helper` (PAM helper) — rebuilt with all camera fixes
- `/lib/security/libbiopass_pam.so` (PAM module)
- `/lib/security/libbiopass_det.so` (face detection shared library)
- `/lib/security/libbiopass_as.so` (anti-spoofing shared library)
- `/lib/security/libbiopass_reg.so` (face recognition shared library)

## PAM Config
- `/etc/pam.d/system-auth` uses `libbiopass_pam.so` with `[success=2 default=ignore]`
- Backups exist at `/etc/pam.d/system-auth.bak.*`

## Config File
- `~/.config/com.ticklab.biopass/config.yaml` — has `camera_device: /dev/video0`, `ir_camera: /dev/video2`, `anti_spoofing.enable: true`

## Anti-Spoofing Model
- Path: `~/.local/share/com.ticklab.biopass/models/mobilenetv3_antispoof.onnx`
- Source: OpenVINO OMZ `anti-spoof-mn3` model (same file, different name)
- Input: `[1, 3, 128, 128]`, Output: `[1, 2]` with Softmax (class 0 = real, class 1 = spoof)
- Preprocessing: mean `[0.5931, 0.4690, 0.4229]`, std `[0.2471, 0.2214, 0.2157]` (matches OMZ mean/scale in [0,255] range)
- Threshold: 0.8 (applied to sigmoid probability, not raw logit)

## Documentation
- `docs/platform-fixes/webkitgtk-pipewire-camera-fix/PATCHES.md` — full documentation covering all 11 issues
- `docs/platform-fixes/webkitgtk-pipewire-camera-fix/patches/` — 17 patch files (0001–0017)

## Patch Files
| # | Description |
|---|---|
| `0001` | Add `custom-protocol` feature to Cargo.toml |
| `0002` | Native ffmpeg camera preview (replaces getUserMedia) + FPS selector (3/15/30 FPS) |
| `0003` | Expose `nms_boxes` from utils (prerequisite for 0009) |
| `0004` | Pass configured camera device to FaceCapture |
| `0005` | New camera.rs module (ffmpeg streaming) |
| `0006` | camera_device config, V4L2NV12 capture, same-device IR reuse |
| `0007` | AI anti-spoofing class ordering fix (class 1 = spoof) |
| `0008` | Heap corruption fix (CameraPreview thread join + window close handler) |
| `0009` | Correct YOLOv8-pose face detection decode (NCHW + DFL + cell center) |
| `0010` | Unsharp mask sharpening for anti-spoofing; multi-frame IR capture with AGC sleep |
| `0011` | Advanced/expert config infrastructure — C++ structs, YAML parsing, Rust/TS types, IAuthMethod::getMaxAuthTimeMs() |
| `0012` | Wire advanced config into face_as, ir_camera_as, face_auth, antispoof_check |
| `0013` | Advanced settings GUI — collapsible section with all controls + persistent preview FPS |
| `0014` | Refactoring — extract `parseAdvancedConfig()` helper, split GUI into `AdvancedFaceSettings.tsx`, struct-level `#[serde(default)]` in `config.rs` |
| `0015` | Configurable preview resolution — wire Capture Resolution fields (width/height) from advanced config to ffmpeg camera preview |
| `0016` | Suppress fingerprint D-Bus error on startup — skip `listEnrolled` call in `FingerprintSetting` when fingerprint is disabled |
| `0017` | Config reload guard, stale description fix, free-form FPS NumberInput — 3 UX fixes for advanced config persistence & camera preview controls |

## Commands to Rebuild
```bash
touch /home/cachyos/test/biopass/auth/face/detection/face_detection.cc
cmake --build /home/cachyos/test/biopass/auth/build --parallel

# Install binaries
sudo cp auth/build/pam/biopass-helper /usr/bin/biopass-helper
sudo cp auth/build/face/detection/libbiopass_det.so /lib/security/libbiopass_det.so
sudo cp auth/build/face/antispoofing/libbiopass_as.so /lib/security/libbiopass_as.so
sudo cp auth/build/face/recognition/libbiopass_reg.so /lib/security/libbiopass_reg.so

# GUI build (if changes to app/):
make -C /home/cachyos/test/biopass build
sudo cp app/src-tauri/target/release/biopass /usr/bin/biopass
```

## Quick Auth Test
```bash
sudo -k && timeout 10 sudo echo "OK"
```
- Face visible → OK (auth passes)
- Hand blocking camera → "Failure, timeout reached" (auth fails, face detection gets no face)

## Known Remaining Issues
- Auth retries 5 times before falling through to password (~2s delay). Configurable in upstream code.
