/* Primitivos de interface compartilhados pelas telas — equivalente React do
   antigo js/ui.js. Nenhum deles guarda estado. */

export function Badge({ children, tone = 'mute', className = '' }) {
  return <span className={`badge badge--${tone} ${className}`.trim()}>{children}</span>;
}

export function Kpi({ label, value, delta, sub, tone = 'mute', valueSize }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-row">
        <div className="kpi-value" style={valueSize ? { fontSize: valueSize } : undefined}>{value}</div>
        {delta ? <div className={`kpi-delta tone-${tone}`}>{delta}</div> : null}
      </div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

export function KpiRow({ items, cls = 'grid--kpi', valueSize }) {
  return (
    <div className={`grid ${cls}`}>
      {items.map((k) => <Kpi key={k.label} {...k} valueSize={valueSize} />)}
    </div>
  );
}

export function CardHead({ title, sub, right }) {
  return (
    <div className="card-head">
      <div>
        <div className="card-title">{title}</div>
        {sub ? <div className="card-sub">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}

export function Field({ label, value, ph, onChange, type = 'text', options = [], required = false, disabled = false, inputMode, maxLength }) {
  const filled = value != null;
  return (
    <div className="field">
      <label>{label}</label>
      {onChange ? (
        type === 'select' ? (
          <select className="control" value={value || ''} onChange={(event) => onChange(event.target.value)} required={required} disabled={disabled}>
            <option value="">{ph || 'Selecionar'}</option>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : <input className="control" value={value || ''} placeholder={ph} onChange={(event) => onChange(event.target.value)} type={type} required={required} disabled={disabled} inputMode={inputMode} maxLength={maxLength} />
      ) : <div className={`control${filled ? '' : ' is-placeholder'}`}>{filled ? value : ph}</div>}
    </div>
  );
}

export function Tile({ label, value, sub }) {
  return (
    <div className="tile">
      <span className="stat-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub ? <span className="meta">{sub}</span> : null}
    </div>
  );
}

export function Kv({ label, value }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** Barra horizontal proporcional (funil, financeiro, cards de fechamento). */
export function Bar({ pct, color }) {
  return <i style={{ width: pct, background: color }} />;
}

/** Filtros em pílula. `items` aceita 'Rótulo' ou ['Rótulo', contagem]. */
export function Chips({ items, active, onSelect }) {
  return items.map((item) => {
    const [label, count] = Array.isArray(item) ? item : [item, null];
    return (
      <button
        key={label}
        type="button"
        className={`chip${label === active ? ' is-active' : ''}`}
        onClick={() => onSelect(label)}
      >
        {label}
        {count != null ? <span className="chip-count">{count}</span> : null}
      </button>
    );
  });
}

/** Cor do ponto/realce por tom de status. */
export function toneColor(tone) {
  return {
    ok: 'var(--green)',
    warn: 'var(--orange-ink)',
    info: 'var(--navy-500)',
    mute: 'var(--ink-mute)',
    new: 'var(--purple-ink)'
  }[tone] || 'var(--ink-mute)';
}

/** Logo C-E-C em três blocos, usada nas páginas públicas. */
export function LogoBlocks() {
  return (
    <div className="logo">
      <span className="logo-c">C</span>
      <span style={{ background: '#fff', color: 'var(--navy)' }}>E</span>
      <span className="logo-c2">C</span>
    </div>
  );
}

/** Etiqueta ao lado do nome: o responsável tem (ou não) cliente no Asaas. */
export function AsaasBadge({ customerId }) {
  return customerId
    ? <span className="asaas-badge is-on" title={`Cliente no Asaas: ${customerId}`}>✓ Asaas</span>
    : <span className="asaas-badge" title="Este responsável ainda não tem cadastro no Asaas">sem Asaas</span>;
}
