// Llama Manager Flasher — renderer application (wizard flow).
//
// Copyright (c) 2026 Doubling Technologies (DoubTech.ai). Use of this file is
// governed by the LICENSE file in the repository root.
//
// Implements the five-step flashing wizard: platform select (AMD stable /
// NVIDIA Spark EXPERIMENTAL) → target-drive picker (manual and automatic
// rescans, removable-only list served by the main process) → destructive confirmation
// (the user must type the device path) → download + flash + verify progress
// → done. All privileged work happens in the main process; this component
// only sequences the IPC calls and renders progress. Elevation status is
// surfaced before the confirm step so Windows/Linux users can relaunch the
// app with the rights raw-device writes need. The titlebar reuses the approved
// Llama Manager favicon artwork and exposes accessible custom window controls.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import brandIcon from './brand-icon.png';

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

/** Props for the empty/error/loading state shown below the drive picker. */
interface DriveScanNoticeProps {
  /** True while the main process is enumerating removable media. */
  scanning: boolean;
  /** User-facing enumeration error, or an empty string after a successful scan. */
  error: string;
  /** Sanitized counts and rejection reasons from the main process. */
  diagnostics: DriveScanDiagnostics | null;
  /** Requests an immediate drive enumeration. */
  onRescan: () => void;
}

/**
 * Renders an accessible drive-discovery status with an explicit retry action.
 *
 * @param props - Current scanner state and the callback used to rescan.
 * @returns Status content for the otherwise-empty removable-drive list.
 */
export function DriveScanNotice({ scanning, error, diagnostics, onRescan }: DriveScanNoticeProps): JSX.Element {
  if (scanning) {
    return (
      <div className="drive-scan-notice" role="status" aria-live="polite">
        <p>Scanning for USB and microSD drives…</p>
        <button type="button" className="ghost compact" disabled>Rescan</button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="drive-scan-notice scan-error" role="alert">
        <div>
          <strong>Could not scan removable drives</strong>
          <p>{error}</p>
        </div>
        <button type="button" className="ghost compact" onClick={onRescan}>Try again</button>
      </div>
    );
  }

  if (diagnostics && diagnostics.rawCandidateCount > 0 && diagnostics.acceptedCandidateCount === 0) {
    return (
      <div className="drive-scan-notice scan-error" role="status">
        <div>
          <strong>Devices detected, but none are safe flash targets</strong>
          {diagnostics.rejections.map((rejection) => (
            <p key={rejection.device}>{rejection.description}: {rejection.reason}</p>
          ))}
        </div>
        <button type="button" className="ghost compact" onClick={onRescan}>Rescan</button>
      </div>
    );
  }
  return (
    <div className="drive-scan-notice" role="status">
      <p>No removable drives found. Insert a USB stick or microSD card.</p>
      <button type="button" className="ghost compact" onClick={onRescan}>Rescan</button>
    </div>
  );
}

/** Props for the Windows raw-device permission preflight notice. */
interface DrivePermissionNoticeProps {
  /** Current main-process elevation status, or null while it is loading. */
  elevation: ElevationStatus | null;
  /** Requests a UAC-elevated application relaunch. */
  onRelaunch: () => void;
}

/**
 * Prompts Windows users for UAC elevation before they choose a flash target.
 *
 * @param props - Current privilege status and elevated-relaunch callback.
 * @returns An actionable Windows notice, or null when it is not needed.
 */
export function DrivePermissionNotice({
  elevation,
  onRelaunch,
}: DrivePermissionNoticeProps): JSX.Element | null {
  if (elevation?.platform !== 'win32' || elevation.elevated) return null;

  return (
    <div className="warn-box elev drive-permission" role="status">
      <div>
        <strong>Administrator access is required</strong>
        <p>Windows requires UAC approval before this app can write a USB stick or microSD card.</p>
      </div>
      {elevation.canRelaunch ? (
        <button type="button" className="ghost compact" onClick={onRelaunch}>
          Relaunch as administrator
        </button>
      ) : (
        <p className="hint">{elevation.manualHint ?? 'Close the app, then run it as administrator.'}</p>
      )}
    </div>
  );
}

/**
 * Reconciles the selected device with a fresh enumeration result.
 *
 * @param selected - Previously selected drive, or null.
 * @param drives - Fresh drive metadata from the main process.
 * @returns The refreshed matching drive, or null when it was unplugged.
 */
export function reconcileSelectedDrive(
  selected: DriveInfo | null,
  drives: DriveInfo[],
): DriveInfo | null {
  if (selected == null) return null;
  return drives.find((candidate) => candidate.device === selected.device) ?? null;
}

/** The approved Llama Manager favicon artwork used in the app titlebar. */
function BrandMark({ size = 40 }: { size?: number }): JSX.Element {
  return (
    <img
      className="brand-mark"
      src={brandIcon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** Accessible native-equivalent controls for the frameless app window. */
function WindowControls(): JSX.Element {
  return (
    <div className="window-controls" aria-label="Window controls">
      <button
        type="button"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void window.llamaFlasher.window.control('minimize')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5h10" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Toggle maximize window"
        title="Maximize or restore"
        onClick={() => void window.llamaFlasher.window.control('maximize')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3.5" y="3.5" width="9" height="9" rx="0.5" />
        </svg>
      </button>
      <button
        type="button"
        className="window-close"
        aria-label="Close window"
        title="Close"
        onClick={() => void window.llamaFlasher.window.control('close')}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}


/** Stable platform value used by the shell backdrop across every wizard step. */
export function platformDataValue(
  image: ApplianceImage | LocalImage | Pick<ApplianceImage, 'platformId'> | null,
  loading: 'amd' | 'nvidia-spark' | null,
): 'amd' | 'nvidia-spark' | undefined {
  const platformId = image != null && 'platformId' in image ? image.platformId : undefined;
  return platformId ?? loading ?? undefined;
}

/**
 * Discriminates a user-chosen local image from a downloaded appliance image.
 *
 * @param image - The current selection, or null.
 * @returns True when the selection is a local file flashed without downloading.
 */
export function isLocalImage(image: ApplianceImage | LocalImage | null): image is LocalImage {
  return image != null && 'kind' in image && image.kind === 'local';
}

/** Props for the platform-page "flash an already-downloaded image" affordance. */
interface LocalImagePickerProps {
  /** The chosen file, or null before one is picked. */
  selection: LocalImageSelection | null;
  /** Current expected-SHA-256 input value. */
  sha: string;
  /** True while a platform manifest or file dialog is resolving. */
  busy: boolean;
  /** Opens the native file picker. */
  onChoose: () => void;
  /** Updates the optional expected-checksum field. */
  onShaChange: (value: string) => void;
  /** Discards the current selection so a different file can be picked. */
  onClear: () => void;
  /** Accepts the selection and advances to the drive picker. */
  onContinue: () => void;
}

/**
 * Lets the user flash an image already on disk instead of downloading one.
 *
 * @param props - The current selection, optional checksum, and callbacks.
 * @returns The secondary picker shown below the platform cards.
 */
export function LocalImagePicker({
  selection,
  sha,
  busy,
  onChoose,
  onShaChange,
  onClear,
  onContinue,
}: LocalImagePickerProps): JSX.Element {
  return (
    <div className="local-image">
      <p className="hint local-image-lead">Already downloaded an image?</p>
      {selection == null ? (
        <button type="button" className="ghost compact" onClick={onChoose} disabled={busy}>
          Choose a downloaded image…
        </button>
      ) : (
        <div className="local-image-details">
          <div className="local-image-file">
            <strong>{selection.file}</strong>
            <span>{fmtBytes(selection.size)}</span>
          </div>
          <label className="local-sha-label" htmlFor="local-sha">
            Expected SHA-256 <span className="local-sha-optional">(optional)</span>
          </label>
          <input
            id="local-sha"
            className="confirm-input local-sha-input"
            value={sha}
            onChange={(e) => onShaChange(e.target.value)}
            placeholder="Paste to verify before writing…"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="actions">
            <button type="button" className="ghost" onClick={onClear}>Choose a different file</button>
            <button type="button" className="primary" onClick={onContinue}>Continue</button>
          </div>
        </div>
      )}
    </div>
  );
}
/** Root wizard component. */
export default function App(): JSX.Element {
  const [step, setStep] = useState<Step>('platform');
  const [image, setImage] = useState<ApplianceImage | LocalImage | null>(null);
  const [manifestLoading, setManifestLoading] = useState<'amd' | 'nvidia-spark' | null>(null);
  const [localSelection, setLocalSelection] = useState<LocalImageSelection | null>(null);
  const [localSha, setLocalSha] = useState('');
  const [choosingImage, setChoosingImage] = useState(false);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [drive, setDrive] = useState<DriveInfo | null>(null);
  const [scanningDrives, setScanningDrives] = useState(false);
  const [driveScanError, setDriveScanError] = useState('');
  const [driveScanDiagnostics, setDriveScanDiagnostics] = useState<DriveScanDiagnostics | null>(null);
  const [typed, setTyped] = useState('');
  const [elevation, setElevation] = useState<ElevationStatus | null>(null);
  const [phase, setPhase] = useState<ProgressPhase>('download');
  const [pct, setPct] = useState(0);
  const [speed, setSpeed] = useState('');
  const [detail, setDetail] = useState('');
  const [error, setError] = useState('');
  const [version, setVersion] = useState('');
  const flashing = useRef(false);
  const scanSequence = useRef(0);

  useEffect(() => {
    void window.llamaFlasher.appInfo().then((i) => setVersion(i.version));
    void window.llamaFlasher.elevation.status().then(setElevation);
  }, []);

  /** Requests a fresh device list and ignores any older scan finishing later. */
  const refreshDrives = useCallback(async () => {
    const sequence = ++scanSequence.current;
    setScanningDrives(true);
    setDriveScanError('');
    try {
      const result = await window.llamaFlasher.devices.list();
      if (sequence !== scanSequence.current) return;
      setDrives(result.drives);
      setDriveScanDiagnostics(result.diagnostics);
      setDrive((selected) => reconcileSelectedDrive(selected, result.drives));
    } catch (scanError) {
      if (sequence !== scanSequence.current) return;
      setDriveScanError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      if (sequence === scanSequence.current) setScanningDrives(false);
    }
  }, []);

  // Auto-refresh the drive list every 2s while the picker is showing, while
  // retaining a visible manual rescan for newly inserted or slow card readers.
  useEffect(() => {
    if (step !== 'drive') return;
    void refreshDrives();
    const t = setInterval(() => void refreshDrives(), 2000);
    return () => {
      clearInterval(t);
      scanSequence.current += 1;
    };
  }, [refreshDrives, step]);

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

  // Opens the native picker for an already-downloaded image. A cancelled
  // dialog resolves to null and leaves any prior selection untouched.
  const chooseLocalImage = useCallback(async () => {
    setChoosingImage(true);
    setError('');
    try {
      const picked = await window.llamaFlasher.image.choose();
      if (picked) {
        setLocalSelection(picked);
        setLocalSha('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep('error');
    } finally {
      setChoosingImage(false);
    }
  }, []);

  const clearLocalImage = useCallback(() => {
    setLocalSelection(null);
    setLocalSha('');
  }, []);

  // Promotes the chosen file to the active image and enters the drive picker,
  // reusing the same destructive-confirmation flow as a downloaded image.
  const continueWithLocalImage = useCallback(() => {
    if (!localSelection) return;
    setImage({
      kind: 'local',
      file: localSelection.file,
      size: localSelection.size,
      path: localSelection.path,
      sha256: localSha.trim(),
    });
    setStep('drive');
  }, [localSelection, localSha]);

  const startFlash = useCallback(async () => {
    if (!image || !drive || flashing.current) return;
    flashing.current = true;
    setStep('progress');
    // A local image skips the download; a verified one starts at the checksum.
    const startingPhase: ProgressPhase = isLocalImage(image)
      ? (image.sha256 ? 'checksum' : 'write')
      : 'download';
    setPhase(startingPhase);
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
      let imagePath: string;
      if (isLocalImage(image)) {
        // No download — flash the file the user already has. When they supplied
        // an expected hash, verify it first; otherwise go straight to the write.
        if (image.sha256) {
          setPhase('checksum');
          setPct(100);
          setDetail('Computing SHA-256…');
          imagePath = await window.llamaFlasher.image.verifyLocal({
            path: image.path,
            sha256: image.sha256,
          });
        } else {
          imagePath = image.path;
        }
      } else {
        imagePath = await window.llamaFlasher.image.download({
          url: image.url,
          file: image.file,
          sha256: image.sha256,
          size: image.size,
        });
      }
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
    setDriveScanDiagnostics(null);
    setLocalSelection(null);
    setLocalSha('');
    void window.llamaFlasher.elevation.status().then(setElevation);
  }, []);

  const confirmReady = useMemo(
    () => drive != null && typed.trim() === drive.device,
    [drive, typed],
  );

  const needsElevation = elevation != null && !elevation.elevated;

  return (
    <div className="shell" data-platform={platformDataValue(image, manifestLoading)}>
      <header className="titlebar">
        <div className="brand">
          <BrandMark />
          <div>
            <h1>Llama Manager Flasher</h1>
            <p className="sub">Appliance image writer{version ? ` · v${version}` : ''}</p>
          </div>
        </div>
        <div className="titlebar-end">
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
          <WindowControls />
        </div>
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
            <LocalImagePicker
              selection={localSelection}
              sha={localSha}
              busy={manifestLoading != null || choosingImage}
              onChoose={() => void chooseLocalImage()}
              onShaChange={setLocalSha}
              onClear={clearLocalImage}
              onContinue={continueWithLocalImage}
            />
          </section>
        )}

        {step === 'drive' && image && (
          <section className="panel" aria-label="Choose the target drive">
            <h2>Choose the target drive</h2>
            <p className="hint">
              Flashing <strong>{image.file}</strong> ({fmtBytes(image.size)}{!isLocalImage(image) && `, v${image.version}`})
              {!isLocalImage(image) && image.channel === 'experimental' && (
                <span className="chip chip-exp inline">Experimental</span>
              )}
            </p>
            <DrivePermissionNotice
              elevation={elevation}
              onRelaunch={() => void window.llamaFlasher.elevation.relaunch()}
            />
            {!isLocalImage(image) && image.channel === 'experimental' && (
              <p className="warn-box">
                This build is unvalidated on hardware. Use it only if you know what you are doing.
              </p>
            )}
            <div className="drive-list" role="radiogroup" aria-label="Removable drives">
              {drives.length === 0 && (
                <DriveScanNotice
                  scanning={scanningDrives}
                  error={driveScanError}
                  diagnostics={driveScanDiagnostics}
                  onRescan={() => void refreshDrives()}
                />
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
            {drives.length > 0 && (
              <div className="drive-scan-actions" aria-live="polite">
                <span>{scanningDrives ? 'Scanning for changes…' : `${drives.length} removable drive${drives.length === 1 ? '' : 's'} found`}</span>
                <button
                  type="button"
                  className="ghost compact"
                  disabled={scanningDrives}
                  onClick={() => void refreshDrives()}
                >
                  Rescan
                </button>
              </div>
            )}
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
              {(Object.keys(PHASE_LABELS) as ProgressPhase[])
                .filter((p) => {
                  // A local image never downloads; it only shows a checksum
                  // phase when the user supplied an expected hash to verify.
                  if (!isLocalImage(image)) return true;
                  if (p === 'download') return false;
                  if (p === 'checksum') return image.sha256 !== '';
                  return true;
                })
                .map((p) => (
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
