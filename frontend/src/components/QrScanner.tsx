import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserMultiFormatReader, IScannerControls } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType, NotFoundException } from '@zxing/library';

const SUPPORTED_FORMATS: BarcodeFormat[] = [BarcodeFormat.QR_CODE];

type Props = {
  onResult: (text: string) => void;
  onError: (msg: string) => void;
  cooldownMs?: number;
};

/**
 * Scanner abstraction for QR codes.
 * Extend SUPPORTED_FORMATS when adding 1D barcode support later.
 */
export default function QrScanner({ onResult, onError, cooldownMs = 2500 }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const lastScanRef = useRef<{ value: string; timestamp: number } | null>(null);
  const [status, setStatus] = useState<'idle' | 'starting' | 'ready' | 'denied' | 'error'>('idle');

  const codeReader = useMemo(() => {
    const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS]]);
    return new BrowserMultiFormatReader(hints);
  }, []);

  const stopScanner = useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
  }, [codeReader]);

  useEffect(() => {
    let active = true;

    async function startScanner() {
      if (!videoRef.current) {
        onError('Camera preview is unavailable.');
        setStatus('error');
        return;
      }

      setStatus('starting');

      try {
        const controls = await codeReader.decodeFromVideoDevice(undefined, videoRef.current, (result, error) => {
          if (!active) {
            return;
          }

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
        const maybeMessage = error instanceof Error ? error.message : '';
        if (maybeMessage.toLowerCase().includes('permission') || maybeMessage.toLowerCase().includes('denied')) {
          setStatus('denied');
          onError('Camera permission was denied. Please allow camera access and reload the page.');
          return;
        }

        setStatus('error');
        onError('Unable to access camera. Confirm camera permission and HTTPS usage on mobile.');
      }
    }

    void startScanner();

    return () => {
      active = false;
      stopScanner();
    };
  }, [codeReader, cooldownMs, onError, onResult, stopScanner]);

  return (
    <div className="scanner-card">
      <video ref={videoRef} className="scanner-video" muted autoPlay playsInline />
      <p className="scanner-status">
        {status === 'starting' && 'Starting camera…'}
        {status === 'ready' && 'Camera ready. Aim at the student QR code.'}
        {status === 'denied' && 'Camera permission denied. Use manual entry below.'}
        {status === 'error' && 'Camera unavailable. Use manual entry below.'}
        {status === 'idle' && 'Initializing scanner…'}
      </p>
    </div>
  );
}
