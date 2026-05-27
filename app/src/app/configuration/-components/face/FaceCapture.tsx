import { convertFileSrc } from "@tauri-apps/api/core";
import { AlertCircle, Camera, Circle, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cmd } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function FaceCapture({
  selectedDevicePath,
  previewFps,
  onPreviewFpsChange,
  captureWidth,
  captureHeight,
}: {
  selectedDevicePath?: string;
  previewFps?: number;
  onPreviewFpsChange?: (fps: number) => void;
  captureWidth?: number;
  captureHeight?: number;
}) {
  const nativeImgRef = useRef<HTMLImageElement>(null);
  const pollingRef = useRef<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [faceImages, setFaceImages] = useState<string[]>([]);
  const [nativeFrame, setNativeFrame] = useState<string | null>(null);
  const [localFps, setLocalFps] = useState(previewFps ?? 3);
  const capturedFrameRef = useRef<string | null>(null);

  const loadFaceImages = useCallback(async () => {
    try {
      const images = await cmd.face.listImages();
      setFaceImages(images);
    } catch (err) {
      console.error("Failed to load face images:", err);
    }
  }, []);

  useEffect(() => {
    loadFaceImages();
  }, [loadFaceImages]);

  function stopPolling() {
    if (pollingRef.current !== null) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: stopPolling behavior is stable across renders
  useEffect(() => {
    return () => {
      stopPolling();
      cmd.face.stopCameraPreview().catch(() => {});
    };
  }, []);

  function pollFrames() {
    stopPolling();
    const interval = Math.max(16, Math.round(1000 / localFps));
    pollingRef.current = window.setInterval(async () => {
      try {
        const frame = await cmd.face.getPreviewFrame();
        if (frame) {
          capturedFrameRef.current = frame;
          setNativeFrame(`data:image/jpeg;base64,${frame}`);
        }
      } catch {
        // frame read failed, will retry
      }
    }, interval);
  }

  async function startCamera() {
    try {
      let device = selectedDevicePath;
      if (!device) {
        const devices = await cmd.face.listVideoDevices();
        const target = devices.find(
          (d) => !d.name.toLowerCase().includes("metadata"),
        );
        device = target?.path ?? "/dev/video0";
      }
      await cmd.face.startCameraPreview(device, captureWidth, captureHeight);
      pollFrames();
      setCapturing(true);
    } catch (err) {
      toast.error("Failed to access camera");
      console.error(err);
    }
  }

  function stopCamera() {
    stopPolling();
    setCapturing(false);
    setNativeFrame(null);
    capturedFrameRef.current = null;
    cmd.face.stopCameraPreview().catch(() => {});
  }

  async function capturePhoto() {
    const frame = capturedFrameRef.current;
    if (!frame) {
      toast.error("No frame available yet, please wait...");
      return;
    }
    await saveFaceImage(frame);
  }

  async function saveFaceImage(base64Data: string) {
    try {
      await cmd.face.saveImage(base64Data);
      toast.success("Face image saved!");
      await loadFaceImages();
    } catch (err) {
      toast.error(`Failed to save face image: ${err}`);
    }
  }

  async function deleteFace(path: string) {
    try {
      await cmd.face.deleteImage(path);
      toast.success("Face image deleted");
      await loadFaceImages();
    } catch (err) {
      toast.error(`Failed to delete: ${err}`);
    }
  }

  return (
    <div className="p-4 rounded-lg bg-muted/50 border border-border/50">
      <h4 className="font-medium mb-3 flex items-center gap-2">
        <Camera className="w-4 h-4" />
        Face Capture
      </h4>

      <div className="grid gap-4">
        <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
          {nativeFrame && capturing ? (
            <img
              ref={nativeImgRef}
              src={nativeFrame}
              alt="Camera preview"
              className="w-full h-full object-cover"
            />
          ) : !capturing ? (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Camera className="w-12 h-12 opacity-50" />
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary mx-auto mb-2" />
                <p className="text-xs">Starting camera...</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-amber-500 bg-amber-500/10 p-2 rounded">
          <AlertCircle className="w-3 h-3 shrink-0" />
          <span className="flex-1">
            Using native camera capture —{" "}
            {capturing ? `${localFps} FPS` : "preview not started"}
          </span>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              min={1}
              max={120}
              value={localFps}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v >= 1 && v <= 120) {
                  setLocalFps(v);
                  if (onPreviewFpsChange) onPreviewFpsChange(v);
                  if (capturing) pollFrames();
                }
              }}
              className="h-6 w-16 text-xs text-amber-500 bg-amber-500/5 border-amber-500/30 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="text-amber-500/70">FPS</span>
          </div>
        </div>

        <div className="flex gap-2">
          {!capturing ? (
            <Button onClick={startCamera} className="flex-1">
              <Camera className="w-4 h-4 mr-2" />
              Start Camera
            </Button>
          ) : (
            <>
              <Button onClick={capturePhoto} className="flex-1">
                <Circle className="w-4 h-4 mr-2" />
                Capture
              </Button>
              <Button variant="outline" onClick={stopCamera}>
                <Square className="w-4 h-4 mr-2" />
                Stop
              </Button>
            </>
          )}
        </div>

        {faceImages.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground mb-2">
              Saved Faces ({faceImages.length})
            </p>
            <div className="grid grid-cols-4 gap-2">
              {faceImages.map((path) => (
                <div key={path} className="relative group">
                  <div className="aspect-square bg-muted rounded-lg overflow-hidden">
                    <img
                      src={convertFileSrc(path)}
                      alt="Captured face"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => deleteFace(path)}
                    className="absolute top-1 right-1 p-1 rounded bg-destructive/80 text-destructive-foreground cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3 text-white" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
