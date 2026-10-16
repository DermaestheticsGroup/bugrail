// Ports of the two DermaestheticsDS components the design imports.
export function AppStatusBadge({ label, tone }: { label: string; tone: string; hintSize?: string }) {
  return (
    <span className={`ds-status-badge ds-status-badge--${tone}`}>
      <span className="ds-status-badge__label ts-label-small">{label}</span>
    </span>
  );
}

export function PatientInitialsAvatar({ name, backgroundColor, hintSize }: { name: string; backgroundColor: string; hintSize?: string }) {
  const initials = (name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  const [w, h] = (hintSize || "").split(",");
  const size = w && w !== "auto" ? { width: w, height: h, fontSize: parseInt(w) > 48 ? 24 : undefined } : {};
  return (
    <span className="ds-patient-avatar ts-text-sm-semibold" style={{ backgroundColor, ...size }}>
      {initials || "?"}
    </span>
  );
}
