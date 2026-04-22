import { useCallback, useMemo, useRef, useState } from 'react';
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

type Props = {
  onResult: (text: string) => void;
  onError: (msg: string) => void;
  cooldownMs?: number;
};

export default function QrScanner({ onResult, onError, cooldownMs = 2500 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastScanRef = useRef<{ value: string; timestamp: number } | null>(null);
  const [status, setStatus] = useState<'idle' | 'starting' | 'ready' | 'denied' | 'error' | 'no-camera'>('idle');

  const codeReader = useMemo(() => {
    const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS]]);
    return new BrowserMultiFormatReader(hints);
  }, []);

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
  }, []);

  const startScanner = useCallback(async () => {
    if (!videoRef.current) {
      setStatus('error');
      onError('Camera preview is unavailable.');
      return;
    }

    stopScanner();
    setStatus('starting');

    try {
      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      if (!devices.length) {
        setStatus('no-camera');
        onError('No camera was found on this device. Use USB scanner / manual entry mode.');
        return;
      }

      const controls = await codeReader.decodeFromVideoDevice(undefined, videoRef.current, (result, error) => {
        if (result) {
          const text = result.getText().trim();
          if (!text) return;

          const now = Date.now();
          const latest = lastScanRef.current;
          if (latest && latest.value === text && now - latest.timestamp < cooldownMs) {
            return;
          }

          lastScanRef.current = { value: text, timestamp: now };
          onResult(text);
          return;
        }

        if (error && !(error instanceof NotFoundException)) {
          onError('Scanner had trouble reading the camera feed.');
        }
      });

      controlsRef.current = controls;
      setStatus('ready');
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('permission') || message.includes('denied')) {
        setStatus('denied');
        onError('Camera permission is required for camera mode. Please allow camera access and try again.');
        return;
      }

      setStatus('error');
      onError('Scanner failed to start. Check camera access and browser support.');
    }
  }, [codeReader, cooldownMs, onError, onResult, stopScanner]);

  return (
    <div className="scanner-card">
      <div className="button-row">
        <button type="button" className="primary" onClick={() => void startScanner()}>Start Scanner</button>
        <button type="button" className="secondary" onClick={stopScanner}>Stop Scanner</button>
      </div>
      <video ref={videoRef} className="scanner-video" muted autoPlay playsInline />
      <p className="scanner-status">
        {status === 'idle' && 'Click Start Scanner to request camera permission and begin barcode scanning.'}
        {status === 'starting' && 'Starting camera…'}
        {status === 'ready' && 'Camera ready. Aim at a barcode.'}
        {status === 'denied' && 'Camera permission denied. Switch to USB Scanner / Manual Entry mode.'}
        {status === 'no-camera' && 'No camera available on this device.'}
        {status === 'error' && 'Scanner initialization failed. Use USB Scanner / Manual Entry mode.'}
      </p>
    </div>
  );
}
