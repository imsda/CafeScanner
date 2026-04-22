import { useEffect, useRef } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

const SUPPORTED_FORMATS: BarcodeFormat[] = [BarcodeFormat.QR_CODE];

/**
 * Scanner wrapper abstraction.
 * Add 1D support later by extending SUPPORTED_FORMATS.
 */
export default function QrScanner({ onResult, onError }: { onResult: (text: string) => void; onError: (msg: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, SUPPORTED_FORMATS]]);
    const codeReader = new BrowserMultiFormatReader(hints);

    let stopScanner: (() => void) | undefined;

    if (!videoRef.current) {
      onError('Camera element is unavailable.');
      return;
    }

    codeReader
      .decodeFromVideoDevice(undefined, videoRef.current, (result, error, controls) => {
        stopScanner = () => controls.stop();

        if (result) {
          onResult(result.getText());
          return;
        }

        if (error && error.name !== 'NotFoundException') {
          onError('Camera scan error. Check camera permissions.');
        }
      })
      .catch(() => onError('Unable to access camera.'));

    return () => {
      stopScanner?.();
    };
  }, [onResult, onError]);

  return <video ref={videoRef} style={{ width: '100%', borderRadius: 8 }} muted autoPlay playsInline />;
}
