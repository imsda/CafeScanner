import { useEffect, useState } from "react";
import Barcode from "react-barcode";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api/client";

export type BadgeCodeType = "barcode" | "qr" | "auto";

export const BADGE_CODE_TYPE_STORAGE_KEY = "cafescanner.badgeCodeType";

export function resolveBadgeCodeType(type: BadgeCodeType, value: string): "barcode" | "qr" {
  if (type !== "auto") return type;
  return /^\d{1,20}$/.test(value.trim()) ? "barcode" : "qr";
}

export function BadgesPage() {
  const [people, setPeople] = useState<any[]>([]);
  const [codeType, setCodeType] = useState<BadgeCodeType>(() => {
    const stored = window.localStorage.getItem(BADGE_CODE_TYPE_STORAGE_KEY);
    return stored === "barcode" || stored === "qr" || stored === "auto" ? stored : "barcode";
  });

  useEffect(() => {
    void api<any[]>("/people?showInactive=true").then(setPeople);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(BADGE_CODE_TYPE_STORAGE_KEY, codeType);
  }, [codeType]);

  return (
    <div className="card">
      <h2>Printable Badges</h2>
      <div className="button-row">
        <label>
          Code Type
          <select value={codeType} onChange={(e) => setCodeType(e.target.value as BadgeCodeType)}>
            <option value="barcode">Barcode (Code 128)</option>
            <option value="qr">QR Code</option>
            <option value="auto">Auto (recommended)</option>
          </select>
        </label>
        <button className="secondary" onClick={() => window.print()}>
          Print Sheet
        </button>
      </div>
      <div className="badge-grid">
        {people.map((p) => {
          const scanValue = String((p.codeValue ?? p.personId ?? "")).trim();
          const resolvedType = resolveBadgeCodeType(codeType, scanValue);
          return (
            <div className="badge" key={p.id}>
              <p className="badge-name">
                {p.firstName} {p.lastName}
              </p>
              <div className="badge-code" aria-label={`${resolvedType} code`}>
                {!scanValue ? (
                  <small className="error">No ID available</small>
                ) : resolvedType === "qr" ? (
                  <QRCodeSVG value={scanValue} size={80} />
                ) : (
                  <Barcode
                    value={scanValue}
                    format="CODE128"
                    width={1.5}
                    height={45}
                    displayValue={false}
                    margin={0}
                  />
                )}
              </div>
              <small className="badge-id">{scanValue || "No ID available"}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
