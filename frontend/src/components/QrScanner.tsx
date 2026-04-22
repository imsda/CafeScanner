import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, NotFoundException } from '@zxing/library';

const SUPPORTED_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODABAR,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.ITF,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.QR_CODE
];

type ScannerStatus =
  | 'not-started'
  | 'insecure-context'
  | 'requesting-permission'
  | 'permission-denied'
  | 'no-camera'
  | 'scanner-ready'
  | 'scan-success'
  | 'scan-error';

type Props = {
  onResult: (text: string) => void;
  onError: (msg: string) => void;
  cooldownMs?: number;
};

const REAR_CAMERA_LABEL_PATTERN = /rear|back|environment|wide/i;

export default function QrScanner({ onResult, onError, cooldownMs = 2500 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const activeStreamRef = useRef<MediaStream | null>(null);
  const lastScanRef = useRef<{ value: string; timestamp: number } | null>(null);
  const [status, setStatus] = useState<ScannerStatus>('not-started');

  const codeReader = useMemo(() => {
    const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS]]);
    return new BrowserMultiFormatReader(hints);
  }, []);

  const releaseVideoStream = useCallback(() => {
    activeStreamRef.current?.getTracks().forEach((track) => track.stop());
    activeStreamRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, []);

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    releaseVideoStream();
  }, [releaseVideoStream]);

  const startScanner = useCallback(async () => {
    if (!videoRef.current) {
      setStatus('scan-error');
      onError('Camera preview is unavailable. Use USB scanner / manual entry mode.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      stopScanner();
      setStatus('no-camera');
      onError('This browser does not support camera access. Use USB scanner / manual entry mode.');
      return;
    }

    if (!window.isSecureContext) {
      stopScanner();
      setStatus('insecure-context');
      onError('Camera scanning requires HTTPS (or localhost). Switch to USB scanner / manual entry mode on insecure connections.');
      return;
    }

    stopScanner();
    setStatus('requesting-permission');

    try {
      const probeStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' }
        },
        audio: false
      });

      probeStream.getTracks().forEach((track) => track.stop());

      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      if (!devices.length) {
        setStatus('no-camera');
        onError('No camera was found on this device. Use USB scanner / manual entry mode.');
        return;
      }

      const preferredDevice = devices.find((device) => REAR_CAMERA_LABEL_PATTERN.test(device.label));

      const controls = await codeReader.decodeFromVideoDevice(preferredDevice?.deviceId, videoRef.current, (result, error) => {
        const stream = videoRef.current?.srcObject;
        activeStreamRef.current = stream instanceof MediaStream ? stream : null;

        if (result) {
          const text = result.getText().trim();
          if (!text) return;

          const now = Date.now();
          const latest = lastScanRef.current;
          if (latest && latest.value === text && now - latest.timestamp < cooldownMs) {
            return;
          }

          lastScanRef.current = { value: text, timestamp: now };
          setStatus('scan-success');
          onResult(text);
          return;
        }

        if (error && !(error instanceof NotFoundException)) {
          setStatus('scan-error');
          onError('Scanner had trouble reading the camera feed. Try better lighting, then try again.');
        }
      });

      controlsRef.current = controls;
      setStatus('scanner-ready');
    } catch (error) {
      const domError = error instanceof DOMException ? error.name : '';
      const message = error instanceof Error ? error.message.toLowerCase() : '';

      if (domError === 'NotAllowedError' || domError === 'SecurityError' || message.includes('permission') || message.includes('denied')) {
        setStatus('permission-denied');
        onError('Camera permission was denied. Allow camera access and tap Start Camera Scanner again, or use USB/manual mode.');
        return;
      }

      if (domError === 'NotFoundError' || domError === 'OverconstrainedError' || message.includes('no camera')) {
        setStatus('no-camera');
        onError('No usable camera was found. Use USB scanner / manual entry mode.');
        return;
      }

      setStatus('scan-error');
      onError('Scanner failed to start. Check browser camera settings, then try again.');
    }
  }, [codeReader, cooldownMs, onError, onResult, releaseVideoStream, stopScanner]);

  useEffect(() => () => stopScanner(), [stopScanner]);

  return (
    <div className="scanner-card">
      <div className="button-row">
        <button type="button" className="primary" onClick={() => void startScanner()}>Start Camera Scanner</button>
        <button type="button" className="secondary" onClick={stopScanner}>Stop Camera Scanner</button>
      </div>
      <video ref={videoRef} className="scanner-video" muted autoPlay playsInline controls={false} />
      <p className="scanner-status">
        {status === 'not-started' && 'Camera not started. Tap Start Camera Scanner to request permission and use the rear camera when available.'}
        {status === 'insecure-context' && 'Camera unavailable here: this page is not secure. Use HTTPS (or localhost) for camera scanning, or use USB scanner / manual entry mode.'}
        {status === 'requesting-permission' && 'Requesting camera permission… Please allow access in your browser prompt.'}
        {status === 'permission-denied' && 'Camera permission denied. You can allow permission in browser settings and retry, or use USB scanner / manual entry mode.'}
        {status === 'no-camera' && 'No camera found for this device/browser. Use USB scanner / manual entry mode.'}
        {status === 'scanner-ready' && 'Scanner ready. Aim the rear camera at a person ID barcode.'}
        {status === 'scan-success' && 'Scan success. Processing this barcode…'}
        {status === 'scan-error' && 'Scan error. Try again or switch to USB scanner / manual entry mode.'}
      </p>
      <p className="muted">If camera mode is unavailable, switch to USB Scanner / Manual ID Entry below to keep check-in moving.</p>
    </div>
  );
}
