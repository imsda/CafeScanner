import { useEffect, useRef } from 'react';
import { BrowserMultiFormatReader, NotFoundException } from '@zxing/browser';

/**
 * Scanner wrapper abstraction.
 * Barcode support can be added by changing decode hints/reader in this component only.
 */
export default function QrScanner({ onResult, onError }: { onResult: (text: string) => void; onError: (msg: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const codeReader = new BrowserMultiFormatReader();
    let stopFn: (() => void) | null = null;

    codeReader.decodeFromVideoDevice(undefined, videoRef.current!, (result, error, controls) => {
      stopFn = () => controls.stop();
      if (result) onResult(result.getText());
      if (error && !(error instanceof NotFoundException)) onError('Camera scan error. Check camera permissions.');
    }).catch(() => onError('Unable to access camera.'));

    return () => {
      if (stopFn) stopFn();
      codeReader.reset();
    };
  }, [onResult, onError]);

  return <video ref={videoRef} style={{ width: '100%', borderRadius: 8 }} muted autoPlay playsInline />;
}
