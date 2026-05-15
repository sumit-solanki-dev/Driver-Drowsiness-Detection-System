export default function AlertBox({ alert }) {
  if (!alert?.show) {
    return (
      <div className="card p-4 border-emerald-400/30">
        <p className="text-emerald-300 font-semibold">System Normal</p>
        <p className="text-slate-300 text-sm mt-1">No drowsiness detected.</p>
      </div>
    );
  }

  const severe = alert.severity === "HIGH";

  return (
    <div className={`card p-4 border-rose-500/50 ${severe ? "animate-pulseAlert" : ""}`}>
      <p className="text-rose-300 font-semibold">Alert: {alert.severity}</p>
      <p className="text-rose-200 text-sm mt-1">{alert.message}</p>
    </div>
  );
}
