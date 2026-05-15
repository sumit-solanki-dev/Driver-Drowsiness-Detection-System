import { useEffect, useMemo, useRef, useState } from "react";
import { API } from "./api";
import StatusCard from "./components/StatusCard";
import AlertBox from "./components/AlertBox";
import StatsChart from "./components/StatsChart";

  const initialPayload = {
  status: {
    eye_status: "OPEN",
    yawning: "NO",
    driver_status: "ACTIVE",
    alert_level: "LOW",
    confidence: 0
  },
  stats: {
    blink_count: 0,
    yawn_count: 0,
    drowsiness_events: 0,
    session_seconds: 0
  },
  alert: { show: false, message: "", severity: "LOW", play_sound: false }
};

export default function App() {
  const [payload, setPayload] = useState(initialPayload);
  const [displayAlert, setDisplayAlert] = useState(initialPayload.alert);
  const [series, setSeries] = useState([]);
  const [backendOnline, setBackendOnline] = useState(true);
  const [cameraPermission, setCameraPermission] = useState("pending");
  const [cameraError, setCameraError] = useState("");
  const [audioReady, setAudioReady] = useState(false);

  const sessionIdRef = useRef(null);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const inferTimerRef = useRef(null);
  const alertHideTimerRef = useRef(null);
  const alarmRef = useRef(null);
  const lastSoundEventRef = useRef(0);

  const requestCameraPermission = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraPermission("unsupported");
      setCameraError("Browser does not support webcam access.");
      return;
    }
    try {
      setCameraError("");
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false
        });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      streamRef.current = stream;
      setCameraPermission("granted");
      if (alarmRef.current) {
        try {
          alarmRef.current.volume = 1.0;
          await alarmRef.current.play();
          alarmRef.current.pause();
          alarmRef.current.currentTime = 0;
          setAudioReady(true);
        } catch {
          setAudioReady(false);
        }
      }
    } catch {
      setCameraPermission("denied");
      setCameraError("Could not access webcam. Check browser site permissions and camera usage in other apps.");
    }
  };

  useEffect(() => {
    if (cameraPermission !== "granted") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;

    let cancelled = false;
    const attach = async () => {
      try {
        video.srcObject = stream;
        await video.play();
      } catch {
        if (!cancelled) {
          setCameraError("Webcam opened but video could not play. Refresh page and retry permission.");
        }
      }
    };
    attach();

    return () => {
      cancelled = true;
    };
  }, [cameraPermission]);

  const startSession = async () => {
    const res = await fetch(API.sessionStart, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (!res.ok) throw new Error("Failed to start session");
    const data = await res.json();
    sessionIdRef.current = data.session_id;
  };

  const frameToBase64 = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.videoWidth === 0 || video.videoHeight === 0) return null;

    const width = 640;
    const height = Math.max(360, Math.round((video.videoHeight / video.videoWidth) * width));
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.72);
  };

  const startInferenceLoop = () => {
    if (inferTimerRef.current) clearInterval(inferTimerRef.current);
    inferTimerRef.current = setInterval(async () => {
      if (cameraPermission !== "granted" || !sessionIdRef.current) return;
      const imageBase64 = frameToBase64();
      if (!imageBase64) return;

      try {
        const res = await fetch(API.infer, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionIdRef.current, image_base64: imageBase64 })
        });
        if (!res.ok) return;

        const data = await res.json();
        setPayload(data);
        setSeries((prev) => {
          const next = [...prev, { t: new Date().toLocaleTimeString(), confidence: data.status.confidence || 0 }];
          return next.slice(-20);
        });
      } catch {
        setBackendOnline(false);
      }
    }, 300);
  };

  useEffect(() => {
    alarmRef.current = new Audio("/music.wav");
    alarmRef.current.loop = false;
    return () => {
      if (alarmRef.current) alarmRef.current.pause();
    };
  }, []);

  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await fetch(API.health, { cache: "no-store" });
        setBackendOnline(res.ok);
      } catch {
        setBackendOnline(false);
      }
    };
    checkHealth();
    const id = setInterval(checkHealth, 3000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (cameraPermission !== "granted") return;
    let mounted = true;
    (async () => {
      try {
        await startSession();
        if (!mounted) return;
        startInferenceLoop();
      } catch {
        setBackendOnline(false);
      }
    })();

    return () => {
      mounted = false;
      if (inferTimerRef.current) clearInterval(inferTimerRef.current);
    };
  }, [cameraPermission]);

  useEffect(() => {
    if (!alarmRef.current) return;
    if (!audioReady) return;
    if (!payload.alert.play_sound) return;

    const soundEventId = payload.alert.sound_event_id || 0;
    if (soundEventId === 0 || soundEventId === lastSoundEventRef.current) return;
    lastSoundEventRef.current = soundEventId;

    let plays = 0;
    const playNext = async () => {
      if (!alarmRef.current || plays >= 2) {
        if (alarmRef.current) alarmRef.current.onended = null;
        return;
      }
      plays += 1;
      alarmRef.current.currentTime = 0;
      try {
        await alarmRef.current.play();
      } catch {
        return;
      }
      alarmRef.current.onended = playNext;
    };

    playNext();
  }, [payload.alert.play_sound, payload.alert.sound_event_id, audioReady]);

  useEffect(() => {
    if (payload.alert.show) {
      if (alertHideTimerRef.current) {
        clearTimeout(alertHideTimerRef.current);
        alertHideTimerRef.current = null;
      }
      setDisplayAlert(payload.alert);
      return;
    }

    if (alertHideTimerRef.current) clearTimeout(alertHideTimerRef.current);
    alertHideTimerRef.current = setTimeout(() => {
      setDisplayAlert({ show: false, message: "", severity: "LOW" });
      alertHideTimerRef.current = null;
    }, 3000);
  }, [payload.alert]);

  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (inferTimerRef.current) clearInterval(inferTimerRef.current);
      if (alertHideTimerRef.current) clearTimeout(alertHideTimerRef.current);
    };
  }, []);

  const driverTone = useMemo(() => {
    if (payload.status.driver_status === "SLEEPING") return "danger";
    if (payload.status.driver_status === "DROWSY") return "warn";
    return "good";
  }, [payload.status.driver_status]);

  const alertTone = payload.status.alert_level === "HIGH" ? "danger" : payload.status.alert_level === "MEDIUM" ? "warn" : "good";

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        <header className="card p-5">
          <h1 className="text-2xl md:text-3xl font-bold">Driver Drowsiness Monitoring Dashboard</h1>
          <p className="text-slate-400 mt-1">Each user uses their own browser webcam for detection.</p>
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <section className="xl:col-span-2 card p-4">
            <p className="text-sm text-slate-400 mb-3">Live Webcam Feed (Local Browser)</p>
            <div className="w-full aspect-video rounded-xl border border-white/10 overflow-hidden bg-black">
              {cameraPermission === "granted" ? (
                <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-slate-400">Camera permission required</div>
              )}
            </div>
            {cameraError && <p className="text-rose-300 text-sm mt-3">{cameraError}</p>}
            <canvas ref={canvasRef} className="hidden" />
            {!backendOnline && (
              <p className="text-rose-300 text-sm mt-3">Backend offline. Please start backend on `http://127.0.0.1:8000`.</p>
            )}
          </section>

          <section className="space-y-3">
            <StatusCard label="Eye Status" value={payload.status.eye_status} tone={payload.status.eye_status === "CLOSED" ? "warn" : "good"} />
            <StatusCard label="Yawning Detection" value={payload.status.yawning} tone={payload.status.yawning === "YES" ? "warn" : "good"} />
            <StatusCard label="Driver Status" value={payload.status.driver_status} tone={driverTone} />
            <StatusCard label="Alert Level" value={payload.status.alert_level} tone={alertTone} />
          </section>
        </div>

        <AlertBox alert={displayAlert} />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="grid grid-cols-2 gap-4">
            <StatusCard label="Blink Count" value={payload.stats.blink_count} />
            <StatusCard label="Yawn Count" value={payload.stats.yawn_count} />
            <StatusCard label="Drowsiness Events" value={payload.stats.drowsiness_events} />
            <StatusCard label="Detection Confidence" value={`${payload.status.confidence}%`} />
          </div>
          <StatsChart data={series} />
        </div>
      </div>

      {cameraPermission !== "granted" && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="card w-full max-w-md p-6">
            <h2 className="text-xl font-semibold">Allow Camera Permission</h2>
            <p className="text-slate-300 text-sm mt-2">This app uses your browser webcam for detection.</p>
            {cameraPermission === "denied" && (
              <p className="text-rose-300 text-sm mt-2">Permission denied. Enable camera in browser settings and retry.</p>
            )}
            {cameraPermission === "unsupported" && (
              <p className="text-rose-300 text-sm mt-2">This browser does not support webcam access.</p>
            )}
            <button
              type="button"
              onClick={requestCameraPermission}
              className="mt-4 px-4 py-2 rounded-lg bg-accent text-slate-950 font-semibold hover:brightness-110"
            >
              Grant Permission
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
