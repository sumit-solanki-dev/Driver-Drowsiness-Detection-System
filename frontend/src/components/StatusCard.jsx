export default function StatusCard({ label, value, tone = "normal" }) {
  const toneClass = {
    normal: "text-slate-100",
    good: "text-emerald-300",
    warn: "text-amber-300",
    danger: "text-rose-300"
  }[tone];

  return (
    <div className="card p-4">
      <p className="text-sm text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
