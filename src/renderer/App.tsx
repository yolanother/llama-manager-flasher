// Llama Manager Flasher — renderer application (wizard flow).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Implements the five-step flashing wizard: platform select (AMD stable /
// NVIDIA Spark EXPERIMENTAL) → target-drive picker (auto-refreshing,
// removable-only list served by the main process) → destructive confirmation
// (the user must type the device path) → download + flash + verify progress
// → done. All privileged work happens in the main process; this component
// only sequences the IPC calls and renders progress. Elevation status is
// surfaced before the confirm step so Windows/Linux users can relaunch the
// app with the rights raw-device writes need.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Step = 'platform' | 'drive' | 'confirm' | 'progress' | 'done' | 'error';

/** Sub-phase of the progress step, in execution order. */
type ProgressPhase = 'download' | 'checksum' | 'write' | 'verify';

const PHASE_LABELS: Record<ProgressPhase, string> = {
  download: 'Downloading image',
  checksum: 'Verifying checksum',
  write: 'Writing to device',
  verify: 'Verifying device',
};

/**
 * Formats a byte count as a short human-readable string (GB/MB).
 *
 * @param n - Byte count, or null when unknown.
 * @returns A short string like "14.9 GB", or "—" when unknown.
 */
function fmtBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * Formats a bytes-per-second rate.
 *
 * @param speed - Rate in bytes/second, or undefined.
 * @returns A short string like "42.1 MB/s", or empty when unknown.
 */
function fmtSpeed(speed?: number): string {
  if (!speed || !Number.isFinite(speed)) return '';
  return `${fmtBytes(speed)}/s`;
}

/** The inline llama mark used in the header (mirrors build/icon.svg). */
function LlamaMark({ size = 34 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="lm-bg" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ed1c24" />
          <stop offset="0.55" stopColor="#ff6a00" />
          <stop offset="1" stopColor="#ffa02f" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#lm-bg)" />
      <g fill="#ffffff">
        <path d="M24.4 24.5c-.6-4.7-2-8.2-3.8-10.5 3.9.6 6.9 3.4 8.2 7.7z" />
        <path d="M39.6 24.5c.6-4.7 2-8.2 3.8-10.5-3.9.6-6.9 3.4-8.2 7.7z" />
        <path d="M23.6 24.2c-.5 0-.8.4-.8 1v9.8c0 6.2 2.3 10 5.7 12.1l1.1 5.2c.2.9 1.5.9 1.7 0l.6-2.8h.8l.6 2.8c.2.9 1.5.9 1.7 0l1.1-5.2c3.4-2.1 5.7-5.9 5.7-12.1V25.2c0-.6-.3-1-.8-1z" />
      </g>
      <circle cx="44.5" cy="43" r="4.2" fill="#22c55e" stroke="#0a0a0a" strokeWidth="1.6" />
    </svg>
  );
}

/** Root wizard component. */
export default function App(): JSX.Element {
  const [step, setStep] = useState<Step>('platform');
  const [image, setImage] = useState<ApplianceImage | null>(null);
  const [manifestLoading, setManifestLoading] = useState<'amd' | 'nvidia-spark' | null>(null);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [drive, setDrive] = useState<DriveInfo | null>(null);
  const [typed, setTyped] = useState('');
  const [elevation, setElevation] = useState<ElevationStatus | null>(null);
  const [phase, setPhase] = useState<ProgressPhase>('download');
  const [pct, setPct] = useState(0);
  const [speed, setSpeed] = useState('');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const [version, setVersion] = useState('');
  const flashing = useRef(false);

  useEffect(() => {
    void window.llamaFlasher.appInfo().then((i) => setVersion(i.version));
    void window.llamaFlasher.elevation.status().then(setElevation);
  }, []);

  // Auto-refresh the drive list every 2s while the picker is showing.
  useEffect(() => {
    if (step !== 'drive') return;
    let live = true;
    const refresh = () => {
      void window.llamaFlasher.devices.list().then((d) => {
        if (live) setDrives(d);
      }).catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [step]);

  const choosePlatform = useCallback(async (platformId: 'amd' | 'nvidia-spark') => {
    setManifestLoading(platformId);
    setError('');
    try {
      const img = await window.llamaFlasher.manifest.fetch({ platformId });
      setImage(img);
      setStep('drive');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    } finally {
      setManifestLoading(null);
    }
  }, []);

  const startFlash = useCallback(async () => {
    if (!image || !drive || flashing.current) return;
    flashing.current = true;
    setStep('progress');
    setPhase('download');
    setPct(0);
    setSpeed('');
    setDetail('');

    const offDownload = window.llamaFlasher.image.onProgress((p) => {
      if (p.phase === 'verifying') {
        setPhase('checksum');
        setPct(100);
        setDetail('Computing SHA-256…');
      } else if (p.phase === 'retrying') {
        setDetail(`Retrying download (attempt ${p.attempt ?? '?'})…`);
      } else {
        setPhase('download');
        setPct(p.total > 0 ? (p.bytes / p.total) * 100 : 0);
        setDetail(`${fmtBytes(p.bytes)} of ${fmtBytes(p.total || image.size)}`);
      }
    });
    const offFlash = window.llamaFlasher.flash.onProgress((p) => {
      if (p.error) {
        setError(p.error);
        return;
      }
      const isVerify = p.phase === 'verifying' || p.phase === 'verify';
      setPhase(isVerify ? 'verify' : 'write');
      setPct(p.percentage ?? 0);
      setSpeed(fmtSpeed(p.speed));
      setDetail(`${fmtBytes(p.bytesWritten ?? 0)} of ${fmtBytes(p.size ?? image.size)}`);
    });

    try {
      const imagePath = await window.llamaFlasher.image.download({
        url: image.url,
        file: image.file,
        sha256: image.sha256,
        size: image.size,
      });
      setPhase('write');
      setPct(0);
      setSpeed('');
      setDetail('Starting write…');
      const result = await window.llamaFlasher.flash.start({
        devicePath: drive.device,
        imagePath,
        typedConfirmation: typed.trim(),
      });
      if (!result.ok) throw new Error('flash reported a write failure');
      setStep('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    } finally {
      offDownload();
      offFlash();
      flashing.current = false;
    }
  }, [image, drive, typed]);

  const reset = useCallback(() => {
    setStep('platform');
    setImage(null);
    setDrive(null);
    setTyped('');
    setError('');
    void window.llamaFlasher.elevation.status().then(setElevation);
  }, []);

  const confirmReady = useMemo(
    () => drive != null && typed.trim() === drive.device,
    [drive, typed],
  );

  const needsElevation = elevation != null && !elevation.elevated;

  return (
    <div className="shell">
      <header className="titlebar">
        <div className="brand">
          <LlamaMark />
          <div>
            <h1>Llama Manager Flasher</h1>
            <p className="sub">Appliance image writer{version ? ` · v${version}` : ''}</p>
          </div>
        </div>
        <ol className="steps" aria-label="Progress">
          {(['platform', 'drive', 'confirm', 'progress'] as const).map((s, i) => (
            <li
              key={s}
              className={step === s ? 'active' : ''}
              aria-current={step === s ? 'step' : undefined}
            >
              {i + 1}
            </li>
          ))}
        </ol>
      </header>

      <main className="stage">
        {step === 'platform' && (
          <section className="panel" aria-label="Choose your platform">
            <h2>Choose your platform</h2>
            <p className="hint">The latest appliance image for your hardware will be downloaded and verified.</p>
            <div className="platform-grid">
              <button
                type="button"
                className="card card-amd"
                onClick={() => void choosePlatform('amd')}
                disabled={manifestLoading != null}
              >
                <span className="chip chip-stable">Stable</span>
                <strong>AMD Ryzen AI</strong>
                <span className="card-sub">Ubuntu appliance · amd64</span>
                <span className="card-note">
                  {manifestLoading === 'amd' ? 'Fetching latest release…' : 'Recommended for AMD Ryzen AI Max machines'}
                </span>
              </button>
              <button
                type="button"
                className="card card-nvidia"
                onClick={() => void choosePlatform('nvidia-spark')}
                disabled={manifestLoading != null}
              >
                <span className="chip chip-exp">Experimental</span>
                <strong>NVIDIA DGX Spark</strong>
                <span className="card-sub">Ubuntu appliance · arm64</span>
                <span className="card-note">
                  {manifestLoading === 'nvidia-spark'
                    ? 'Fetching latest release…'
                    : 'Unvalidated on hardware — expect rough edges'}
                </span>
              </button>
            </div>
          </section>
        )}

        {step === 'drive' && image && (
          <section className="panel" aria-label="Choose the target drive">
            <h2>Choose the target drive</h2>
            <p className="hint">
              Flashing <strong>{image.file}</strong> ({fmtBytes(image.size)}, v{image.version})
              {image.channel === 'experimental' && <span className="chip chip-exp inline">Experimental</span>}
            </p>
            {image.channel === 'experimental' && (
              <p className="warn-box">
                This build is unvalidated on hardware. Use it only if you know what you are doing.
              </p>
            )}
            <div className="drive-list" role="radiogroup" aria-label="Removable drives">
              {drives.length === 0 && (
                <p className="empty">No removable drives found. Insert a USB stick or microSD card…</p>
              )}
              {drives.map((d) => (
                <button
                  key={d.device}
                  type="button"
                  role="radio"
                  aria-checked={drive?.device === d.device}
                  className={`drive ${drive?.device === d.device ? 'selected' : ''}`}
                  onClick={() => setDrive(d)}
                >
                  <strong>{d.description}</strong>
                  <span>{d.device} · {fmtBytes(d.size)}</span>
                  {d.mountpoints.length > 0 && <span className="mounts">{d.mountpoints.join(', ')}</span>}
                </button>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="ghost" onClick={reset}>Back</button>
              <button
                type="button"
                className="primary"
                disabled={!drive}
                onClick={() => setStep('confirm')}
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {step === 'confirm' && image && drive && (
          <section className="panel" aria-label="Confirm flash">
            <h2>Point of no return</h2>
            <p className="warn-box">
              Everything on <strong>{drive.description}</strong> ({drive.device},{' '}
              {fmtBytes(drive.size)}) will be <strong>permanently erased</strong>.
            </p>
            {needsElevation && (
              <div className="warn-box elev">
                <p>
                  Writing to a raw device needs {elevation?.platform === 'win32' ? 'administrator' : 'root'} rights.
                </p>
                {elevation?.canRelaunch ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void window.llamaFlasher.elevation.relaunch()}
                  >
                    Relaunch elevated
                  </button>
                ) : (
                  <p className="hint">{elevation?.manualHint ?? 'Restart the app with elevated rights.'}</p>
                )}
              </div>
            )}
            <label className="confirm-label" htmlFor="confirm-input">
              Type <code>{drive.device}</code> to confirm:
            </label>
            <input
              id="confirm-input"
              className="confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={drive.device}
              autoFocus
              spellCheck={false}
            />
            <div className="actions">
              <button type="button" className="ghost" onClick={() => { setTyped(''); setStep('drive'); }}>
                Back
              </button>
              <button
                type="button"
                className="danger"
                disabled={!confirmReady || (needsElevation && elevation?.platform !== 'darwin')}
                onClick={() => void startFlash()}
              >
                Flash it
              </button>
            </div>
          </section>
        )}

        {step === 'progress' && image && (
          <section className="panel" aria-label="Flashing progress" aria-live="polite">
            <h2>{PHASE_LABELS[phase]}</h2>
            <div className="phase-row">
              {(Object.keys(PHASE_LABELS) as ProgressPhase[]).map((p) => (
                <span key={p} className={`phase ${p === phase ? 'active' : ''}`}>
                  {PHASE_LABELS[p]}
                </span>
              ))}
            </div>
            <div className="bar" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
              <div className="bar-fill" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
            </div>
            <p className="progress-detail">
              {Math.floor(pct)}% {speed && `· ${speed}`} {detail && `· ${detail}`}
            </p>
            <p className="hint">Keep the drive plugged in. This can take a while for large images.</p>
          </section>
        )}

        {step === 'done' && drive && (
          <section className="panel done" aria-label="Flash complete">
            <div className="done-mark" aria-hidden="true">✓</div>
            <h2>Flash complete</h2>
            <p className="hint">
              {drive.description} was written and verified. It is safe to unplug —
              the drive was unmounted after verification. Boot your machine from it
              to install Llama Manager.
            </p>
            <div className="actions">
              <button type="button" className="primary" onClick={reset}>Flash another</button>
            </div>
          </section>
        )}

        {step === 'error' && (
          <section className="panel" aria-label="Error">
            <h2>Something went wrong</h2>
            <p className="warn-box">{error}</p>
            <div className="actions">
              <button type="button" className="primary" onClick={reset}>Start over</button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
