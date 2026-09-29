import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { usePipeline } from '../state/pipeline';
import { confidenceColor, confidenceLabel, formatDims, stageLabel } from '@cadforge/shared';
import type { Part } from '../types';
import './RightPanel.css';

export function RightPanel(): JSX.Element {
  const { project, liveLogs } = usePipeline();
  const [selected, setSelected] = useState<string | null>(null);
  const [parts, setParts] = useState<Map<string, Part>>(new Map());
  const [loadingPart, setLoadingPart] = useState(false);
  const [partError, setPartError] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  // Reset the selection when the project changes.
  useEffect(() => {
    setSelected(null);
    setParts(new Map());
    setPartError(null);
  }, [project?._id]);

  // The instance list, in assembly order, with the base part first.
  const instances = useMemo(() => {
    if (!project) return [];
    return project.assembly.map((item) => ({
      instanceName: item.instanceName,
      partId: item.partId,
      position: item.resolvedPosition_mm ?? { x: 0, y: 0, z: 0 },
    }));
  }, [project]);

  const current = instances.find((i) => i.instanceName === selected) ?? null;

  useEffect(() => {
    if (!current) return;
    const cached = parts.get(current.partId);
    if (cached) return;

    let cancelled = false;
    setLoadingPart(true);
    setPartError(null);
    void api
      .getPart(current.partId)
      .then((part) => {
        if (cancelled) return;
        setParts((prev) => new Map(prev).set(part.id, part));
        setVerified((prev) => ({ ...prev, [part.id]: part.verified }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPartError(err instanceof Error ? err.message : 'Could not load that part');
      })
      .finally(() => {
        if (!cancelled) setLoadingPart(false);
      });

    return () => {
      cancelled = true;
    };
  }, [current, parts]);

  const part = current ? (parts.get(current.partId) ?? null) : null;

  const toggleVerified = async (): Promise<void> => {
    if (!part) return;
    const next = !verified[part.id];
    setVerified((prev) => ({ ...prev, [part.id]: next }));
    try {
      const updated = await api.verifyPart(part.id, next);
      setParts((prev) => new Map(prev).set(updated.id, updated));
    } catch (err) {
      setVerified((prev) => ({ ...prev, [part.id]: !next }));
      setPartError(err instanceof Error ? err.message : 'Could not update the part');
    }
  };

  const usedFallback = useMemo(
    () =>
      project !== null &&
      (project.logs ?? []).concat(liveLogs).some((l) => l.message.includes('fallback: true')),
    [project, liveLogs],
  );

  if (!project) {
    return (
      <aside className="panel" aria-label="Part details">
        <div className="panel__header">
          <span className="eyebrow">Details</span>
        </div>
        <div className="empty">
          Select a project to inspect its parts, dimensions, and sources.
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel" aria-label="Part details">
      <div className="panel__header">
        <span className="eyebrow">Assembly</span>
        <span className="chip">{instances.length} parts</span>
      </div>

      <div className="panel__body">
        <div className="panel__section">
          <div className="panel__section-title">
            <span className="eyebrow">Part tree</span>
          </div>
          {instances.length === 0 ? (
            <p className="empty">The plan has no parts yet.</p>
          ) : (
            <div className="tree">
              {instances.map((instance) => {
                const spec = parts.get(instance.partId);
                const cls = `tree__item${instance.instanceName === selected ? ' tree__item--active' : ''}`;
                return (
                  <button
                    key={instance.instanceName}
                    type="button"
                    className={cls}
                    onClick={() => setSelected(instance.instanceName)}
                  >
                    <span
                      className="tree__swatch"
                      style={{ background: spec?.color_hex ?? '#39424f' }}
                    />
                    <span className="tree__name" title={instance.instanceName}>
                      {spec?.name ?? instance.partId}
                    </span>
                    {spec ? <span className="tree__dims">{spec.bbox_mm.x.toFixed(1)}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {current ? (
          <>
            <div className="panel__section">
              <div className="panel__section-title">
                <span className="eyebrow">{part?.name ?? current.partId}</span>
                {part ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => void toggleVerified()}
                    title={
                      part.verified
                        ? 'Mark as unverified so the pipeline will re-research it'
                        : 'Confirm this spec against its datasheet'
                    }
                  >
                    {part.verified ? 'Unverify' : 'Verify'}
                  </button>
                ) : null}
              </div>

              {loadingPart && !part ? (
                <div className="empty">
                  <span className="spinner" /> Loading the part spec…
                </div>
              ) : null}

              {partError ? <p className="props__issue props__issue--error">{partError}</p> : null}

              {part ? (
                <>
                  <div className="props__badges">
                    <span
                      className="badge badge--confidence"
                      style={{ color: confidenceColor(part.confidence) }}
                      title="How much the sources agree. 0.9+ is a manufacturer drawing."
                    >
                      confidence {part.confidence.toFixed(2)} · {confidenceLabel(part.confidence)}
                    </span>
                    <span
                      className={`badge ${part.verified ? 'badge--verified' : 'badge--unverified'}`}
                      title={
                        part.verified
                          ? 'Verified: the pipeline will never re-research this part'
                          : 'Not verified: dimensions come from research and may be approximate'
                      }
                    >
                      {part.verified ? 'verified' : 'unverified'}
                    </span>
                    <span className="badge badge--category">{part.category}</span>
                    {part.origin === 'seed' ? (
                      <span className="badge badge--category">library</span>
                    ) : null}
                    {usedFallback ? (
                      <span
                        className="badge badge--fallback"
                        title="At least one part used the deterministic builder instead of LLM-generated geometry. Dimensions are still spec-exact."
                      >
                        fallback geometry
                      </span>
                    ) : null}
                  </div>

                  <div className="props__grid">
                    <span className="props__key">Size</span>
                    <span className="props__value">{formatDims(part.bbox_mm)}</span>
                    <span className="props__key">Instance</span>
                    <span className="props__value">{current.instanceName}</span>
                    <span className="props__key">Position</span>
                    <span className="props__value">
                      {current.position.x.toFixed(2)}, {current.position.y.toFixed(2)},{' '}
                      {current.position.z.toFixed(2)} mm
                    </span>
                    {part.pitch_mm !== undefined ? (
                      <>
                        <span className="props__key">Pitch</span>
                        <span className="props__value">{part.pitch_mm} mm</span>
                      </>
                    ) : null}
                    {part.material ? (
                      <>
                        <span className="props__key">Material</span>
                        <span className="props__value">{part.material}</span>
                      </>
                    ) : null}
                    {part.anchors.length > 0 ? (
                      <>
                        <span className="props__key">Anchors</span>
                        <span className="props__value">{part.anchors.length}</span>
                      </>
                    ) : null}
                  </div>

                  {part.notes ? <p className="props__note">{part.notes}</p> : null}

                  {part.issues?.map((issue, i) => (
                    <p
                      key={i}
                      className={`props__issue${issue.severity === 'error' ? ' props__issue--error' : ''}`}
                    >
                      {issue.path}: {issue.message}
                    </p>
                  ))}
                </>
              ) : null}
            </div>

            {part && part.features.length > 0 ? (
              <div className="panel__section">
                <div className="panel__section-title">
                  <span className="eyebrow">Features</span>
                  <span className="chip">{part.features.length}</span>
                </div>
                <div className="feature-list">
                  {part.features.map((feature) => (
                    <div className="feature" key={feature.name}>
                      <span className="feature__type">{feature.type}</span>
                      <span className="feature__name" title={feature.note ?? feature.name}>
                        {feature.name}
                      </span>
                      <span className="feature__dims">
                        {Object.entries(feature.dims_mm)
                          .map(([k, v]) => `${k.slice(0, 4)}=${v}`)
                          .join(' ')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {part && part.anchors.length > 0 ? (
              <div className="panel__section">
                <div className="panel__section-title">
                  <span className="eyebrow">Anchors</span>
                </div>
                <div className="anchor-list">
                  {part.anchors.map((anchor) => (
                    <span
                      className="anchor"
                      key={anchor.name}
                      title={`(${anchor.position_mm.x}, ${anchor.position_mm.y}, ${anchor.position_mm.z}) mm`}
                    >
                      {anchor.name}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            {part && part.sources.length > 0 ? (
              <div className="panel__section">
                <div className="panel__section-title">
                  <span className="eyebrow">Sources</span>
                  <span className="chip">{part.sources.length}</span>
                </div>
                {part.sources.map((source) => (
                  <div className="source" key={source.url}>
                    <div className="source__title">{source.title}</div>
                    <a
                      className="source__url"
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {source.url}
                    </a>
                    {source.extracted_fields.length > 0 ? (
                      <ul className="source__fields">
                        {source.extracted_fields.map((field, i) => (
                          <li key={i}>
                            {field.field} = {field.value}
                            {field.conflict ? (
                              <span className="source__conflict"> — conflict: {field.conflict}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {project.scaleChecks.length > 0 ? (
          <div className="panel__section">
            <div className="panel__section-title">
              <span className="eyebrow">Scale verification</span>
            </div>
            {project.scaleChecks.map((check, i) => (
              <div className="check" key={i}>
                <span className={`check__icon check__icon--${check.ok ? 'ok' : 'fail'}`}>
                  {check.ok ? 'OK' : 'FAIL'}
                </span>
                <span className="check__label">
                  {check.label}
                  <span className="check__detail">{check.detail}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {project.error ? (
          <div className="panel__section">
            <div className="panel__section-title">
              <span className="eyebrow">Failure</span>
            </div>
            <p className="props__issue props__issue--error">{project.error}</p>
            <p className="props__note">
              {project.status === 'failed' && project.plan === null
                ? 'This usually means the LLM or search key is wrong, or the cad-worker is not running. Check /api/health.'
                : 'The pipeline stopped. The log in the sidebar has the stage and message that failed.'}
            </p>
          </div>
        ) : null}

        <div className="panel__section">
          <div className="panel__section-title">
            <span className="eyebrow">Plan</span>
            {project.plan ? <span className="chip">{stageLabel('plan')}</span> : null}
          </div>
          {project.plan ? (
            <>
              <div className="feature-list">
                {project.plan.parts.map((part, i) => (
                  <div className="feature" key={i}>
                    <span className="feature__type">{part.quantity}×</span>
                    <span className="feature__name" title={part.role}>
                      {part.name}
                    </span>
                  </div>
                ))}
              </div>
              {project.plan.relations.length > 0 ? (
                <ul className="source__fields" style={{ paddingLeft: 0, listStyle: 'none' }}>
                  {project.plan.relations.map((rel, i) => (
                    <li key={i}>
                      {rel.a} ↔ {rel.b}: {rel.description}
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="empty">The plan has not been produced yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
