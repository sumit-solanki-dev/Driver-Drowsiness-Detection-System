const base = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

export const API = {
  base,
  health: `${base}/api/health`,
  sessionStart: `${base}/api/session/start`,
  infer: `${base}/api/infer`
};
