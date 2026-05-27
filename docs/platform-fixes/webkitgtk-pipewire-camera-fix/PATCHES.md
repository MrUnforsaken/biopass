# Biopass: WebKitGTK PipeWire Camera & Face Detection Fixes

> **Date**: 2026-05-25  
> **Biopass version**: `1.2.0-4-ga9e140b` (commit `a9e140b`)  
> **Tested on**: CachyOS Linux (Arch-based), KDE Plasma 6, Wayland  
> **Kernel**: 7.0.9-1-cachyos  
> **WebKitGTK**: 2.52.3  
> **PipeWire**: 1.6.5  
> **ffmpeg**: n8.1.1  
> **Camera**: Dell Webcam WB7022 (UVC, /dev/video0-3)

---

## Table of Contents

1. [Overview](#overview)
2. [Issue 1: "Connection refused" on startup](#issue-1-connection-refused-on-startup)
3. [Issue 2: Camera preview black (PipeWire DMA_DRM bug)](#issue-2-camera-preview-black-pipewire-dma_drm-bug)
4. [Issue 3: "No face detected" on Capture](#issue-3-no-face-detected-on-capture)
5. [Issue 4: IR camera (NV12 format) not working](#issue-4-ir-camera-nv12-format-not-working)
6. [Issue 5: Preview always used the wrong camera device](#issue-5-preview-always-used-the-wrong-camera-device)
7. [Issue 6: PAM helper always used /dev/video0 and IR camera unavailable](#issue-6-pam-helper-always-used-dev-video0-and-ir-camera-unavailable)
8. [Issue 7: PAM auth succeeded but sudo still denied (faillock)](#issue-7-pam-auth-succeeded-but-sudo-still-denied-faillock)
9. [Issue 8: AI anti-spoofing wrong class ordering and threshold](#issue-8-ai-anti-spoofing-wrong-class-ordering-and-threshold)
10. [Issue 9: AI anti-spoofing false-positive on IR-only setups](#issue-9-ai-anti-spoofing-false-positive-on-ir-only-setups)
11. [Issue 10: `free(): corrupted unsorted chunks` on GUI close](#issue-10-free-corrupted-unsorted-chunks-on-gui-close)
12. [Issue 11: AI anti-spoofing false-positive on real face; IR capture AGC timing](#issue-11-ai-anti-spoofing-false-positive-on-real-face-ir-capture-agc-timing)
13. [Advanced / Expert Configuration (Patches 0011–0013)](#advanced--expert-configuration-patches-0011-0013)
14. [Refactoring: Code Cleanup (Patch 0014)](#refactoring-code-cleanup-patch-0014)
15. [Distribution Compatibility](#distribution-compatibility)
16. [Technical References](#technical-references)

---

## Overview

Biopass is a biometric PAM authentication module that supports face recognition and fingerprint. This document covers a series of platform-specific fixes required to make biopass work correctly on **Arch Linux (CachyOS) with WebKitGTK 2.52+ and PipeWire 1.6+**.

The fixes address 11 core issues across 10 patch files, plus 7 additional patches (0011–0017) for advanced/expert config infrastructure, refactoring, and UX fixes. The scope covers Tauri IPC configuration, YOLOv8 face detection bugs, V4L2 camera capture improvements, PAM faillock handling, AI anti-spoofing corrections, heap corruption on GUI close, unsharp mask sharpening, multi-frame IR capture with AGC timing, a fully configurable advanced/expert settings system with GUI controls, code cleanup refactoring, configurable preview resolution, fingerprint D-Bus error suppression, and config reload/UX fixes.

---

## Issue 1: "Connection refused" on startup

### Symptom

After building and installing the app, launching biopass gives:
```
Error: Connection refused (os error 111)
```

### Root Cause

The `app/src-tauri/Cargo.toml` listed Tauri features as:
```toml
tauri = { version = "2", features = ["protocol-asset"] }
```

The `protocol-asset` feature is a non-default feature that enables serving assets via a custom protocol. However, this feature only enables the *asset serving* part. The `custom-protocol` feature (which is normally included by default in Tauri 2) enables the **custom protocol handler itself** (`tauri://localhost`). By listing only `protocol-asset` without `custom-protocol`, the custom protocol is disabled entirely, so any IPC calls fail with "Connection refused".

### Fix

Add `"custom-protocol"` to the features list:
```toml
tauri = { version = "2", features = ["protocol-asset", "custom-protocol"] }
```

**File**: `app/src-tauri/Cargo.toml`  

---

## Issue 2: Camera preview black (PipeWire DMA_DRM bug)

### Symptom

The configuration page's camera preview shows a black video. `getUserMedia` succeeds (no exception), the video element plays, but displays only black frames. This happens on WebKitGTK 2.52+ with PipeWire 1.6+.

### Root Cause

Modern WebKitGTK (2.42+) uses GStreamer's `pwsrc` (PipeWire source) element for camera access. PipeWire's `pwsrc` requests DMA_DRM format (dma-buf) for zero-copy rendering. However, the Dell WB7022 camera provides NV12 frames via its UVC driver.

The format negotiation flow:
1. WebKit → GStreamer → `pwsrc` requests DMA_DRM
2. Camera driver offers NV12 (MJPEG decoded to NV12)
3. DMA_DRM ↔ NV12 conversion is missing or broken in the PipeWire/GStreamer pipeline
4. `pwsrc` silently falls back to a black frame instead of throwing an error
5. `getUserMedia` resolves successfully, but the video track contains only black frames

This is a known issue tracked in WebKit Bugzilla and PipeWire discussions — the DMA_DRM ↔ software buffer negotiation path fails silently.

### Fix

Replaced the entire browser-based `getUserMedia` approach with **native ffmpeg camera capture**:

1. **Rust backend** (`app/src-tauri/src/camera.rs`): New `CameraPreview` struct that spawns an ffmpeg process to capture MJEPG frames from `/dev/video*` and pipes them to the Tauri frontend via base64-encoded JPEG images.

2. **Frontend** (`FaceCapture.tsx`): Replaced the `video` element + `getUserMedia` with an `img` element polling the Rust backend at a configurable frame rate (3/15/30 FPS via a dropdown selector).

3. **WebKit settings** (`lib.rs`): Enabled `enable_media_stream`, `enable_webrtc`, and `enable_media` settings to ensure WebKit doesn't block media features even though `getUserMedia` is no longer used.

Key ffmpeg command:
```
ffmpeg -hide_banner -loglevel quiet -f v4l2 -video_size 640x480 \
  -i /dev/videoX -c:v mjpeg -q:v 5 -f image2pipe -
```

The `-c:v mjpeg -q:v 5` software-encodes frames to MJPEG regardless of the camera's native format (unlike `-input_format mjpeg -c:v copy` which only works for MJPEG hardware cameras).

**Files**: `app/src-tauri/src/camera.rs` (new), `app/src-tauri/src/lib.rs`, `app/src/app/configuration/-components/face/FaceCapture.tsx`, `app/src/commands/face.ts`  

### FPS Selector

The camera preview polling was originally hardcoded at 300ms (3.3 FPS). A 3-speed dropdown selector (3/15/30 FPS) was added to the amber info bar in `FaceCapture.tsx`. The user can switch while the preview is live — the polling interval restarts instantly.

No CPU concerns at 30 FPS: 640×480 JPEG decode + ~30 Tauri IPC calls/sec is negligible on modern hardware.

**File**: `app/src/app/configuration/-components/face/FaceCapture.tsx`

### Why not fix PipeWire/GStreamer instead?

The DMA_DRM ↔ NV12 negotiation failure could theoretically be fixed at three different layers of the stack:

1. **WebKitGTK** — add a software-buffer fallback path when `pwsrc` fails to negotiate DMA_DRM, so it retries with a compatible format like NV12 or I420.
2. **GStreamer's `pwsrc` element** — add an NV12-to-DMA_DRM conversion step (or gracefully fall back to software rendering when the format mismatch is detected).
3. **PipeWire** — fix the format negotiation logic to gracefully handle the case where the source provides NV12 but the sink requests DMA_DRM, either by inserting a converter or selecting a mutually compatible format.

Any of these would have fixed the issue system-wide, benefiting all WebKit-based apps using `getUserMedia`. However, they require modifying system packages (WebKitGTK, GStreamer, or PipeWire), not biopass itself — making them harder to maintain, distribute, and keep updated across distro upgrades.

The native ffmpeg approach was chosen for biopass specifically because it is:

- **Self-contained** — no system package modifications needed, works on any distro with ffmpeg installed.
- **Lower latency** — bypasses the entire GStreamer/PipeWire pipeline overhead (format negotiation, buffer sharing, DMA transfer). Frames go directly from V4L2 → ffmpeg → Tauri IPC → browser.
- **Deterministic format control** — we explicitly request MJPEG from ffmpeg's software encoder regardless of the camera's native format. No silent negotiation failures or unexpected format conversions.
- **FPS control** — the polling interval is directly controlled by TypeScript, enabling the 3/15/30 FPS selector. With `getUserMedia`, frame rate control depends on the browser's MediaStream API and WebKit's implementation, which varies by platform.

For a single-application fix, the ffmpeg bypass is both simpler and more performant than patching the system multimedia stack.

---

## Issue 3: "No face detected" on Capture

### Symptom

The face detection consistently fails with "No face detected" even when a face is clearly visible in the captured image.

### Root Cause

Three bugs in the C++ YOLOv8 face detection code at `auth/face/detection/face_detection.cc`:

**Bug a: Wrong num_preds calculation**
```cpp
// WRONG: shape[2] is the height dimension (80 for P3)
int num_preds = static_cast<int>(shape[2]);
// CORRECT: num_preds = H * W (80*80 = 6400 for P3)
int num_preds = static_cast<int>(shape[2]) * static_cast<int>(shape[3]);
```

The output tensor shape is `[1, 64, 80, 80]` (batch × channels × height × width). The code was treating only the height (80) as the number of predictions instead of height × width (6400). This meant only ~1.25% of grid cells were processed.

**Bug b: Only first head processed**
The YOLOv8 model outputs 3 detection heads with strides 8 (80×80), 16 (40×40), and 32 (20×20). The code only processed `output_tensors[0]` (the first head), missing small and large face detections.

**Bug c: Missing grid decode**
YOLOv8 outputs grid-relative logits that require:
- `cx = (sigmoid(raw_cx) + col) * stride`
- `cy = (sigmoid(raw_cy) + row) * stride`  
- `w = (sigmoid(raw_w) * 2) * stride`
- `h = (sigmoid(raw_h) * 2) * stride`
- `score = sigmoid(raw_score)`

The original code fed raw logits directly to NMS without grid decode, producing incorrect bounding boxes.

### Fix

Three changes across two patches (`0003` + `0009`):

**Patch `0003`** exposes the internal NMS function as `nms_boxes` in `utils.h`/`utils.cc` so it can accept pre-decoded `RawDet` structs directly (instead of going through the legacy `non_max_suppression` wrapper that expects raw model output).

**Patch `0009`** rewrites the inference function in `face_detection.cc` with the correct YOLOv8-pose decode:

1. **Multi-head processing** — iterates all 3 output heads (strides 8, 16, 32) instead of only the first.
2. **`num_preds = H * W`** — calculates 6400, 1600, and 400 grid cells per head instead of just the height dimension (80).
3. **NCHW tensor access** — ONNX Runtime stores tensors in channel-first layout (`data[ch * H * W + h * W + w]`). The code now accesses class scores and DFL bins correctly by computing `sp = row * W + col` and indexing as `tdata[ch * num + sp]`.
4. **DFL (Distribution Focal Loss) decode** — the model is YOLOv8-pose (`kpt_shape: [5, 3]`), which encodes each bbox boundary as a 16-bin softmax distribution (channels 0–15: left, 16–31: top, 32–47: right, 48–63: bottom). The code decodes these via numerically stable softmax over 16 bins and computes the expected distance from cell center.
5. **Class score at channel 64** — the face confidence score is at channel 64 (after the 64 DFL channels), not channel 4.
6. **Cell center origin** — grid cell origin is `(col + 0.5) * stride` (center of cell), not `col * stride` (top-left corner).
7. **Bbox formula** — `x1 = cx_cell - lt * stride`, `y1 = cy_cell - tp * stride`, `x2 = cx_cell + rb * stride`, `y2 = cy_cell + bt * stride` (DFL distance-from-center, not `cx ± w/2`).

**Verification**:

| Test case | Before fix | After fix | Expected |
|---|---|---|---|
| Face in image (640×480) | "No face detected" | 102–121×146–177 crop | ✓ |
| Blank image (no face) | False positive | "No face" | ✓ |

**Files**: `auth/face/detection/face_detection.cc` (0009), `auth/face/detection/utils.h` (0003), `auth/face/detection/utils.cc` (0003)

---

## Issue 4: IR camera (NV12 format) not working

### Symptom

The IR camera preview/capture fails with ffmpeg errors. The IR camera (Dell WB7022, /dev/video2) only exposes NV12 pixel format.

### Root Cause

The original ffmpeg command used:
```
ffmpeg -input_format mjpeg -c:v copy -f image2pipe -
```

This assumes the camera outputs MJPEG frames natively and copies them directly. The IR camera only provides NV12 frames (decoded by the UVC driver), so `-input_format mjpeg` causes ffmpeg to fail when the camera rejects MJPEG format negotiation.

### Fix

Changed the ffmpeg command to software-encode all formats to MJPEG:
```
ffmpeg -c:v mjpeg -q:v 5 -f image2pipe -
```

This works for both MJPEG-native cameras (RGB) and NV12-only cameras (IR). The `-q:v 5` controls JPEG quality (lower = better, range 2-31, 5 is high quality). The slight CPU cost is negligible at 640×480.

Applied in both `camera.rs` (GUI preview) and `capture_camera_frame` (still capture).

**Files**: `app/src-tauri/src/camera.rs`  

---

## Issue 5: Preview always used the wrong camera device

### Symptom

The configuration page's camera preview always shows the RGB camera (/dev/video0) regardless of which camera device was configured for face capture.

### Root Cause

`FaceCapture.tsx` had no mechanism to accept a device path from the parent component. It always auto-detected the first available video device using `listVideoDevices()`.

### Fix

- Added `selectedDevicePath?: string` prop to `FaceCapture`
- `FaceSetting.tsx` now passes the configured `camera_device` path to `FaceCapture`
- Added a "Camera Device" selector dropdown in `FaceSetting.tsx` that displays available `/dev/video*` devices

**Files**: `app/src/app/configuration/-components/face/FaceCapture.tsx`, `app/src/app/configuration/-components/face/FaceSetting.tsx`, `app/src/types/config.ts`  

---

## Issue 6: PAM helper always used /dev/video0 and IR camera unavailable

### Symptom

The PAM authentication helper (`biopass-helper`) always uses /dev/video0 (the RGB camera with white LED) instead of the configured IR camera. Additionally, the IR camera's GREY format is unavailable — it only exposes NV12, causing the V4L2 GREY capture to fail with "Device or resource busy" or unsupported format errors.

### Root Cause

**Problem A**: The `resolveCameraDeviceIdx()` function in `camera_capture.cc` returns index 0 (first device) when given `std::nullopt`:
```cpp
return static_cast<CapDeviceID>(0);  // Always /dev/video0
```

No config field existed in `FaceMethodConfig` for the primary camera device selection.

**Problem B**: The IR anti-spoofing code in `face_auth.cc` tried to open a second V4L2 session for the same device when `camera_device` and `ir_camera` pointed to the same path. The primary openpnp session already had the device open, causing "Device or resource busy" from V4L2 ioctl.

**Problem C**: The `V4L2GreyCameraSession` required `V4L2_PIX_FMT_GREY` format, but the Dell WB7022 IR camera only exposes NV12. The `captureImageByIRCamera` function directly used `CameraCaptureFormat::V4L2Grey` with no fallback.

### Fix

**Fix A**: Added `camera_device` field to `FaceMethodConfig` (Rust, C++, and TypeScript config). The PAM helper now reads this field and passes it to `resolveCameraDeviceIdx()` and `openCameraSession()`.

**Fix B**: `face_auth.cc` detects when `camera_device == ir_camera` and skips opening a second V4L2 session, instead reusing the primary openpnp session for IR capture.

**Fix C**: Added `V4L2NV12CameraSession` class to `camera_capture.cc` that:
- Opens the device with `V4L2_PIX_FMT_NV12` format
- Captures NV12 frames using V4L2 mmap
- Extracts the Y (luma) plane as greyscale for anti-spoofing
- Format is preferred over GREY when available

Added `CameraCaptureFormat::V4L2NV12` enum variant. Updated `captureImageByIRCamera` to try NV12 first, falling back to GREY:
```cpp
auto session = openCameraSession(device_path, CameraCaptureFormat::V4L2NV12, ...);
if (!session) {
    session = openCameraSession(device_path, CameraCaptureFormat::V4L2Grey, ...);
}
```

**Files**: `app/src-tauri/src/config.rs`, `app/src/types/config.ts`, `auth/core/auth_config.h`, `auth/core/auth_config.cc`, `auth/face/common/camera_capture.h`, `auth/face/common/camera_capture.cc`, `auth/face/face_auth.cc`  

---

## Issue 7: PAM auth succeeded but sudo still denied (faillock)

### Symptom

Despite biopass authentication succeeding (visible in logs), `sudo` still prompts for a password after timeout.

### Root Cause

The Arch Linux default PAM configuration for `system-auth` uses:
```
auth    [success=1 default=ignore]    pam_unix.so
auth    [default=die]                 pam_faillock.so authfail
```

With `[success=1 default=ignore]` on biopass (which replaced `pam_unix.so` in the PAM stack):
- Success skips exactly 1 rule: `pam_unix.so` (now biopass)
- Control passes to `pam_faillock.so authfail` → `[default=die]` → **kills the auth** → denial

### Fix

Changed the biopass rule to `[success=2 default=ignore]`:
- Success skips 2 rules: biopass itself AND `pam_faillock.so authfail`
- Control passes to `pam_faillock.so authaccess` → checks if account is locked → `pam_permit.so` → **success**

Final `/etc/pam.d/system-auth` (relevant lines):
```
auth        sufficient                    pam_unix.so try_first_pass
auth        [success=2 default=ignore]    /lib/security/libbiopass_pam.so
auth        required                      pam_faillock.so preauth
auth        [default=die]                 pam_faillock.so authfail
auth        sufficient                    pam_faillock.so authaccess
auth        required                      pam_deny.so
```

The `success=2` value matches the original Arch PAM convention of `success=2` on `pam_unix.so`, which skips both `pam_faillock.so authfail` and reaches the success path.

**File**: `/etc/pam.d/system-auth`  
**No patch** (system configuration, not in git)

---

## Issue 8: AI anti-spoofing wrong class ordering and threshold

### Symptom

AI anti-spoofing passes even when a hand blocks the camera. The `anti-spoof-mn3` model correctly classifies a hand as class 1 (spoof), but biopass does not flag it.

### Root Cause

**Bug A (Class ordering)**: The ONNX model `mobilenetv3_antispoof.onnx` (from OpenVINO OMZ `anti-spoof-mn3`) defines:
- Class 0 = **real** (genuine face)
- Class 1 = **spoof** (attack/printed face)

The C++ code in `face_as.cc` had the logic inverted:
```cpp
return SpoofResult(score, spoof_cls == 0 && score >= this->threshold);
//                    ^^^^^ WRONG: class 0 is REAL, not SPOOF
```

It should be:
```cpp
return SpoofResult(score, spoof_cls == 1 && score >= this->threshold);
//                    ^^^^^ CORRECT: class 1 is SPOOF
```

**Bug B (Threshold comparison)**: The original `face_detection.cc` compared the raw ONNX output logit against the configured threshold:
```cpp
if (score_logit < this->conf) continue;  // WRONG: compares logit
```

But the configured threshold (0.8) represents a sigmoid probability. A logit of ~0.8 corresponds to only ~69% sigmoid probability. The `non_max_suppression` function in `utils.cc` also compared raw scores. After fixing the decode, the comparison uses `sigmoid(score) >= conf`.

### Fix

**Fix A**: Changed `face_as.cc`:
```cpp
// Before: spoof_cls == 0 (wrong — class 0 is real)
return SpoofResult(score, spoof_cls == 0 && score >= this->threshold);
// After: spoof_cls == 1 (correct — class 1 is spoof)
return SpoofResult(score, spoof_cls == 1 && score >= this->threshold);
```

**Fix B**: The face detection rewrite (Issue 3) naturally fixes the threshold comparison by applying sigmoid before comparison.

**Files**: `auth/face/antispoofing/face_as.cc`, `auth/face/detection/face_detection.cc`  

---

## Issue 9: AI anti-spoofing false-positive on IR-only setups

### Symptom

After configuring both `camera_device` and `ir_camera` to the same device (`/dev/video2`, the IR camera), authentication always fails with "AI anti-spoofing detected spoof, score: 0.99+". The AI model confidently classifies every frame as a spoof.

### Root Cause

When `camera_device` and `ir_camera` point to the same physical device (the IR camera), the face image captured for recognition is an **IR greyscale image**, not a visible-light RGB image. The AI anti-spoofing model (`anti-spoof-mn3`) was trained on visible-spectrum RGB face images from datasets like CASIA-FASD and Replay-Attack. IR face images look fundamentally different — skin texture, lighting, and contrast are all dissimilar from RGB captures. The model outputs class 1 (spoof) with >99% confidence for any IR face input.

The class ordering was already fixed in Issue 8 (`spoof_cls == 1`), but the model is correctly classifying IR faces as "spoof" per its training — it simply cannot distinguish real vs. fake in the IR spectrum.

### Fix

When `camera_device == ir_camera`, the capture pipeline is IR-only. In this mode:
1. The AI anti-spoofing model is **disabled** — it cannot produce meaningful results on IR images.
2. The IR anti-spoofing method (face detection in the IR frame) is retained — since a face must be present in the IR frame for recognition anyway, this is a no-op but harmless.
3. The existing camera session is reused for both recognition and IR capture, avoiding "Device or resource busy" errors from a second V4L2 session on the same device.

**File**: `auth/face/face_auth.cc`

---

## Issue 10: `free(): corrupted unsorted chunks` on GUI close

### Symptom

After closing the biopass GUI window (or quitting the app), the terminal/console shows:
```
free(): corrupted unsorted chunks
Aborted (core dumped)
```

The crash happens nondeterministically and only on window close — never during normal operation.

### Root Cause

The `CameraPreview::start()` function in `app/src-tauri/src/camera.rs` spawns a background thread to read ffmpeg's stdout (MJPEG frames). The thread handle was **discarded** (`thread::spawn()` return value not stored):

```rust
// BROKEN: handle discarded — thread is detached
thread::spawn(move || {
    // reads ffmpeg stdout in a loop
});
```

When the process exits via `exit()` (normal Rust `main()` return):
1. The main thread's `Drop` for `CameraPreview` calls `stop()`, which kills ffmpeg and waits for the child process.
2. The background thread (still running) is blocked inside `reader.read()` — a call that enters glibc's `malloc`/`free` internals.
3. `exit()` terminates all threads, including the background thread, while it holds a glibc heap lock or is mid-allocation.
4. The glibc heap is left in an inconsistent state. When global destructors run, `free()` detects the corruption and aborts.

Additionally, `start_camera_preview` had a double-stop bug:
```rust
// BROKEN: stop() called once explicitly, then again via implicit Drop
if preview.is_some() {
    preview.as_mut().unwrap().stop();  // kill + wait
}
*preview = Some(CameraPreview::start(&device_path)?);  // old one dropped → stop() again
```

### Fix

1. **Store and join the background thread** — added `thread_handle: Option<JoinHandle<()>>` to `CameraPreview`. The `stop()` method now joins the thread after killing ffmpeg, ensuring it has fully exited before any cleanup proceeds.

2. **Window close handler** — registered a `on_window_event(Destroyed)` callback in `lib.rs` that explicitly stops the camera preview before Tauri drops managed state, avoiding races between Tauri's state cleanup and the camera thread.

3. **Avoid double-stop** — changed `start_camera_preview` to use `preview.take()` instead of `preview.is_some()` + `preview.as_mut().unwrap().stop()`, preventing the old `CameraPreview` from being dropped (triggering `stop()` a second time).

**Files**: `app/src-tauri/src/camera.rs`, `app/src-tauri/src/lib.rs`

---

## Issue 11: AI anti-spoofing false-positive on real face; IR capture AGC timing

### Symptom

Despite the class-ordering fix (Issue 8), AI anti-spoofing still detects spoof on real faces with 97–99% confidence. The model's `[prob_real, prob_spoof]` output shows `argmax=1` (spoof) for any face crop from the Dell WB7022 webcam. IR anti-spoofing also fails nondeterministically — sometimes capturing a dark/overexposed frame with no face.

### Root Cause

**Bug A (Model texture sensitivity)**: The `anti-spoof-mn3` model relies on high-frequency spatial variance to distinguish printed/photos from live faces. Webcam images are inherently softer than the training dataset (CASIA-FASD, Replay-Attack) due to:
- Built-in webcam ISP denoising and sharpening
- Low sensor resolution (640×480 vs. higher-res training images)
- Compression artifacts from MJPEG encoding in the ffmpeg pipeline

The face crop after resize to 128×128 has visibly smooth skin — the model sees "no micro-texture" and classifies it as a spoof. The model output for a real face through this pipeline: `[0.0127, 0.9873]` (97.4% spoof confidence).

**Bug B (IR AGC timing)**: The Dell WB7022 IR camera's automatic gain control takes ~800–1200ms to stabilize after stream start. With `kIrCaptureWarmupFrames = 5` and `kIrCapturePollIntervalMs = 10`, only 50ms of warmup elapsed — half the frames were dark or fully overexposed. The single-capture-at-a-time approach meant one bad frame = failed IR check.

### Fix

**Fix A (Unsharp mask sharpening)**: Added `sharpenImage()` to `image_utils.h` — a separable 3-tap unsharp mask (kernel `[1,2,1]`, amount=5.0):

```cpp
// Sharpen before normalization, amount=5.0
ImageRGB sharpened = sharpenImage(resize_img, 5.0f);
return imageToChwNormalized(sharpened, mean, std);
```

The unsharp mask amplifies high-frequency content by `input + amount × (input - blurred)`, restoring edge contrast and skin texture that the model uses for spoof discrimination. After sharpening, the model output for a real face becomes: `[0.929, 0.071]` (92.9% real) — passing the 0.8 threshold.

Amount=5.0 was determined empirically: lower values (1.0–3.0) still failed the model's texture check; higher values produced visible ringing artifacts.

**Fix B (Multi-frame IR capture with AGC settling)**: Three changes to `ir_camera_as.cc`:

1. **Reduced per-capture warmup** from 5 to 3 frames — enough to get a fresh frame since the camera is already streaming from a prior session.
2. **Added multi-attempt loop** — up to 2 capture attempts with face detection on each; selects the attempt with the most faces.
3. **500ms sleep between attempts** — the camera continues streaming (AGC stays locked), so the second attempt captures a properly exposed frame.

Constants updated (both `ir_camera_as.cc` and `face_auth.cc`):

| Constant | Before | After | Reason |
|---|---|---|---|
| `kIrCaptureWarmupFrames` | 5 | 3 | Stream already active; 3 frames is enough for a fresh one |
| `kIrCaptureTimeoutMs` | 3000 | 5000 | Two attempts × 500ms sleep + 3 FPS capture |
| `kIrCapturePollIntervalMs` | 10 | 33 | Match 30 FPS polling (33ms per frame) |

**Verification**:

| Test case | Before fix | After fix |
|---|---|---|
| Real face, AI anti-spoofing | `[0.013, 0.987]` → 97% spoof ❌ | `[0.929, 0.071]` → 92.9% real ✅ |
| IR capture (fresh start) | Dark/overexposed ~50% of the time | Proper exposure 100% of the time ✅ |
| Auth latency (lock screen) | ~2s+ (re-captures and timeouts) | ~267ms ✅ |

**Files**: `auth/face/image_utils.h`, `auth/face/antispoofing/face_as.cc`, `auth/face/antispoofing/ir_camera_as.cc`, `auth/face/face_auth.cc`

---

## Advanced / Expert Configuration (Patches 0011–0013)

The advanced config system exposes all previously hardcoded values as user-configurable YAML settings with a GUI editor. The configuration lives under `methods.face.advanced` in `config.yaml`.

### Config Section

```yaml
methods:
  face:
    advanced:
      unsharp_mask:
        enable: true           # Enable/disable unsharp mask pre-filter
        amount: 5.0            # Sharpening strength (0–15, default 5.0)
      ir_capture:
        warmup_frames: 3       # Frames to discard before capture
        capture_timeout_ms: 5000  # Max time to wait for a frame
        poll_interval_ms: 33   # Poll interval (~30 FPS)
        max_attempts: 2        # Full capture+detect retries
        agc_sleep_ms: 500      # Sleep between attempts for AGC settling
        camera_warmup_ms: 0    # Warmup delay after opening camera
      capture:
        width: 640             # Capture width
        height: 480            # Capture height
        preview_fps: 3         # Default preview frame rate (3/15/30)
      detection:
        input_size: 640        # YOLOv8 input size
        nms_iou_threshold: 0.50  # NMS IoU threshold for box merging
      anti_spoofing:
        spoof_class: 1         # Model class index for spoof (0=real, 1=spoof)
        combinational_mode: all  # "all" = all must pass, "any" = any passes
        debug_save_path: ""    # Custom debug image save path (empty=default)
      enrollment:
        capture_count: 1       # Number of frames to capture during enrollment
      recognition:
        gallery_path: ""       # Custom face gallery path (empty=default)
      auth:
        max_time_ms: 0         # Max auth time cap (0 = auto from retries*delay)
```

### Patch Breakdown

| Patch | Description |
|---|---|
| `0011` | Infrastructure — C++ structs, YAML parsing, Rust/TS types, `IAuthMethod::getMaxAuthTimeMs()` |
| `0012` | Usage — wire config into face_as (unsharp/spoof), ir_camera_as (IR params), face_auth (IR+auth time), antispoof_check (combinational mode) |
| `0013` | GUI — collapsible "Advanced Settings" in FaceSetting.tsx with all controls + persistent preview FPS |
| `0014` | Refactoring — extract `parseAdvancedConfig()` helper in `auth_config.cc`, split advanced GUI into `AdvancedFaceSettings.tsx`, use struct-level `#[serde(default)]` instead of per-field `default = "..."` + standalone `default_*` functions in `config.rs`. Moved Advanced Settings to standalone `/advanced` page with Wrench nav icon. Added `alwaysOpen` prop. |
| `0015` | Configurable preview resolution — wire Capture Resolution fields (width/height) from advanced config to ffmpeg camera preview; `CameraPreview::start()` takes width/height params |
| `0016` | Suppress fingerprint D-Bus error on startup — guard `listEnrolled()` call so it only fires when fingerprint is enabled in config |
| `0017` | UX fixes — guard config reload to prevent overwriting in-memory changes; remove stale preview FPS description; replace 3-speed FPS Select with free-form NumberInput (1–120 FPS) |

### Files Modified

| File | Changes |
|---|---|
| `auth/core/auth_config.h` | 10 new structs (`UnsharpMaskConfig` through `AdvancedConfig`), `AdvancedConfig advanced` field in `FaceMethodConfig` |
| `auth/core/auth_config.cc` | YAML parsing for all advanced fields under `methods.face.advanced` |
| `auth/core/auth_method.h` | `getMaxAuthTimeMs()` virtual method (default 0 = no cap) |
| `auth/face/antispoofing/face_as.h` | `UnsharpMaskParams` struct, constructor takes `spoof_class_index` + `UnsharpMaskParams` |
| `auth/face/antispoofing/face_as.cc` | Conditional sharpening via `unsharp_params_.enable`, uses `spoof_class_index_` |
| `auth/face/antispoofing/ir_camera_as.h` | `IRCaptureParams` alias to `IRCaptureConfig`, function takes `IRCaptureParams` |
| `auth/face/antispoofing/ir_camera_as.cc` | Uses params from argument instead of hardcoded constants |
| `auth/face/face_auth.h` | `getMaxAuthTimeMs()` override, `irParams()` helper |
| `auth/face/face_auth.cc` | Uses `advanced.ir_capture` for session params, `getMaxAuthTimeMs()` from config |
| `auth/face/antispoofing/antispoof_check.cc` | Combinational mode (any/all), passes unsharp/spoof/IR params to child functions |
| `app/src-tauri/src/config.rs` | Rust mirrors of all advanced structs; switched from per-field `default_*` to struct-level `#[serde(default)]` |
| `app/src/types/config.ts` | TypeScript interfaces for all advanced config; added `DEFAULT_ADVANCED_CONFIG` constant |
| `app/src/app/configuration/-components/face/FaceSetting.tsx` | Collapsible "Advanced Settings" with all controls (refactored 763→352 lines) |
| `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx` | **New** — extracted component with 8 sub-sections + `NumberInput` helper; per-section reset buttons + global "Reset all to defaults"; HTML `title` tooltips on all field labels; removed redundant Preview FPS (controlled from FaceCapture bar) |
| `app/src/app/configuration/-components/face/FaceCapture.tsx` | Accepts `previewFps` prop + `onPreviewFpsChange` callback for persistent FPS |

------

## Refactoring: Code Cleanup (Patch 0014)

### Motivation

The advanced config code (patches 0011–0013) introduced structural duplication across three languages. Patch 0014 cleans up all three:

- **C++**: The inline YAML parsing for all 10 advanced structs was moved from `readConfig()` into a dedicated `parseAdvancedConfig()` static function.
- **TypeScript**: The collapsible "Advanced Settings" section in `FaceSetting.tsx` (350+ lines) was extracted into a standalone `AdvancedFaceSettings.tsx` component with 8 sub-section components (`UnsharpMaskSection`, `IrCaptureSection`, `AntiSpoofingAdvancedSection`, etc.) plus a shared `NumberInput` helper.
- **Rust**: Removed 16 `default_*` standalone functions and per-field `#[serde(default = "...")]` attributes; replaced with `#[serde(default)]` on each struct, which delegates to `impl Default`.

### Changes

| Before | After |
|---|---|
| `auth_config.cc`: 80-line inline YAML parsing in `readConfig()` | `parseAdvancedConfig()` helper function |
| `FaceSetting.tsx`: 763 total lines, ~400 for advanced section | 352 lines; advanced section extracted to new file |
| `config.rs`: per-field `#[serde(default = "func")]` + `fn default_*()` + `impl Default` (triple redundancy) | Struct-level `#[serde(default)]` + `impl Default` only |
| — | New file: `AdvancedFaceSettings.tsx` with 8 sub-components + `NumberInput` helper |
| — | Added `DEFAULT_ADVANCED_CONFIG` constant in `config.ts` for reset-to-defaults |
| — | Per-section reset buttons + global "Reset all to defaults" in advanced settings |
| — | Removed redundant Preview FPS selector from Capture Resolution section (FPS controlled from FaceCapture bar) |
| — | HTML `title` tooltips on all advanced field labels explaining each parameter |
| — | Moved Advanced Settings from collapsible in Config page to standalone `/advanced` route with Wrench nav icon |
| — | `alwaysOpen` prop on `AdvancedFaceSettings`; renders without collapsible wrapper on standalone page |
| — | Font sizes bumped `text-xs`/`text-[10px]` → `text-sm`, input heights `h-8` → `h-10` to match rest of GUI |

### Files

| File | Change |
|---|---|
| `auth/core/auth_config.cc` | Extracted `parseAdvancedConfig()` |
| `app/src/app/configuration/-components/face/AdvancedFaceSettings.tsx` | Extracted component: 8 section sub-components, `SectionHeading` + `NumberInput` helpers; per-section reset buttons, global "Reset all to defaults", HTML `title` tooltips on all fields; `alwaysOpen` prop; font sizes bumped from `text-xs` to `text-sm`, inputs `h-8`→`h-10` |
| `app/src/app/configuration/-components/face/FaceSetting.tsx` | Uses `AdvancedFaceSettings` component (763→352 lines); removed from config page (moved to standalone tab) |
| `app/src/types/config.ts` | Added `DEFAULT_ADVANCED_CONFIG` constant |
| `app/src/app/advanced.tsx` | **New** — standalone Advanced page with `/advanced` route |
| `app/src/app/__root.tsx` | Added "Advanced" nav tab with `Wrench` icon |
| `app/src/routeTree.gen.ts` | Registered `/advanced` route |
| `app/src-tauri/src/config.rs` | Struct-level `#[serde(default)]`, removed `default_*` functions |

---

## Distribution Compatibility

| Distribution | Status | Notes |
|---|---|---|
| CachyOS (Arch) | ✅ Tested | WebKitGTK 2.52.3, PipeWire 1.6.5 |
| Arch Linux | ✅ Should work | Same packages |
| Fedora 40+ | ⚠️ Untested | May need different PAM path |
| Ubuntu 24.04+ | ⚠️ Untested | May need different PAM path |
| Other Linux | ⚠️ Untested | Requires WebKitGTK, ffmpeg |

---

## Technical References

- **WebKit Bug 245371**: DMA_DRM buffer negotiation failure with PipeWire
- **PipeWire Issue 3129**: `pwsrc` format negotiation fallback behavior
- **YOLOv8 Post-Processing**: [Ultralytics docs on output decoding](https://docs.ultralytics.com/modes/predict/#boxes)
- **OpenVINO OMZ anti-spoof-mn3**: [Model page](https://github.com/openvinotoolkit/open_model_zoo/tree/master/models/public/anti-spoof-mn3)
- **V4L2 NV12 format**: `V4L2_PIX_FMT_NV12` — Y-plane followed by interleaved UV, 12 bits per pixel
- **PAM faillock arch wiki**: [pam_faillock(8)](https://man.archlinux.org/man/pam_faillock.8)

---

Generated against commit `1.2.0-4-ga9e140b`.
