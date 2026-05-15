import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

export default function StatsChart({ data }) {
  return (
    <div className="card p-4 h-64">
      <p className="text-sm text-slate-400 mb-2">Live Risk Trend</p>
      <ResponsiveContainer width="100%" height="90%">
        <AreaChart data={data}>
          <defs>
            <linearGradient id="risk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#ef4444" stopOpacity={0.8} />
              <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="t" stroke="#94a3b8" />
          <YAxis stroke="#94a3b8" domain={[0, 100]} />
          <Tooltip />
          <Area type="monotone" dataKey="confidence" stroke="#ef4444" fill="url(#risk)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
